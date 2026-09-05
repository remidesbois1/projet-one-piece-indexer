"""Differentiable training path for the pinned inference-only Falcon release.

Weights and the published inference API remain unchanged. SDPA represents each
attention sink as a zero-value extra key, so gradients include its denominator.
The upstream raw Triton squared-ReLU kernel has no autograd; use PyTorch here.
"""

import importlib
import math
from contextlib import nullcontext
from functools import partial

import torch
import torch.nn.functional as F
from config import BASE_MODEL, PROMPT
from PIL import Image, ImageEnhance, ImageOps
from torch.nn.attention.flex_attention import flex_attention
from torch.utils.checkpoint import checkpoint

# Upstream assumes fixed decode shapes and an 8-graph cache. Validation changes
# batch sizes, masks and sequence lengths, and also reloads a second model.
torch._dynamo.config.recompile_limit = max(torch._dynamo.config.recompile_limit, 64)
torch._dynamo.config.accumulated_recompile_limit = max(
    torch._dynamo.config.accumulated_recompile_limit, 512
)
dynamic_flex_decode = torch.compile(flex_attention, dynamic=True, fullgraph=True)


def enable_compact_image_padding(processing):
    """Keep the original pixels; allocate only the batch's occupied rectangle."""
    cls = processing.ImageProcessor
    original = cls.batch_images_with_mask
    if getattr(original, "_compact_padding", False):
        return

    def compact(processor, pixel_values, max_image_height, max_image_width):
        images = (
            [img for img in pixel_values if img is not None and len(img)]
            if pixel_values is not None
            else []
        )
        if images:
            max_image_height = min(
                max_image_height, max(img.shape[1] for img in images)
            )
            max_image_width = min(max_image_width, max(img.shape[2] for img in images))
        return original(processor, pixel_values, max_image_height, max_image_width)

    compact._compact_padding = True
    compact.__wrapped__ = original
    cls.batch_images_with_mask = compact


def sink_attention(q, k, v, sinks, allowed):
    """Exactly softmax([QK/sqrt(d), sink]) @ [V, 0] (up to dtype rounding).

    Pad head dimension to a multiple of 8 for CUDA SDPA; avoid a materialized
    [batch, heads, sequence, sequence] additive bias containing the sinks.
    """
    b, heads, _length, dim = q.shape
    padded_dim = math.ceil((dim + 1) / 8) * 8
    q_extra = torch.ones_like(q[..., :1])
    q = F.pad(torch.cat((q, q_extra), dim=-1), (0, padded_dim - dim - 1))
    k = F.pad(k, (0, padded_dim - dim))
    sink = sinks.to(q.dtype).view(1, heads, 1, 1).expand(b, -1, -1, -1) * math.sqrt(dim)
    sink_key = F.pad(sink, (dim, padded_dim - dim - 1))
    k = torch.cat((k, sink_key), dim=2)
    v = F.pad(v, (0, padded_dim - dim, 0, 1))
    mask = F.pad(allowed, (0, 1), value=True)
    return F.scaled_dot_product_attention(
        q, k, v, attn_mask=mask, dropout_p=0.0, scale=dim**-0.5
    )[..., :dim]


def hybrid_mask(tokens, config, pad_id):
    length = tokens.shape[1]
    positions = torch.arange(length, device=tokens.device)
    causal = positions[:, None] >= positions[None, :]
    image = (
        (tokens == config.image_cls_token_id).cumsum(-1)
        - (tokens == config.img_end_id).cumsum(-1)
    ) > 0
    return (
        (causal[None] | (image[:, :, None] & image[:, None, :]))
        & (tokens != pad_id)[:, None, :]
    )[:, None]


def open_crop(row, rng=None):
    with Image.open(row["image_path"]) as source:
        image = source.convert("RGB")
    # Pathological narrow crops would otherwise become smaller than one patch.
    w, h = image.size
    image = ImageOps.pad(
        image,
        (max(w, math.ceil(h / 32), 16), max(h, math.ceil(w / 32), 16)),
        color="white",
        method=Image.Resampling.BICUBIC,
    )
    if rng is not None and rng.random() < 0.35:
        image = ImageEnhance.Contrast(image).enhance(rng.uniform(0.9, 1.1))
        image = ImageEnhance.Brightness(image).enhance(rng.uniform(0.95, 1.05))
        image = ImageEnhance.Sharpness(image).enhance(rng.uniform(0.9, 1.1))
    return image


class FalconEngine:
    def __init__(self, config, source=None):
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.config = config
        source = str(source or BASE_MODEL)
        kwargs = (
            {"revision": config.revision}
            if source == BASE_MODEL
            else {"local_files_only": True}
        )
        # FP32 master parameters/Adam moments, BF16 autocast for tensor cores.
        self.model = AutoModelForCausalLM.from_pretrained(
            source, trust_remote_code=True, torch_dtype=torch.float32, **kwargs
        ).to("cuda")
        self.tokenizer = AutoTokenizer.from_pretrained(
            source, trust_remote_code=True, **kwargs
        )
        self.model._tokenizer = self.tokenizer
        self.model._ensure_device_buffers()
        package = self.model.__class__.__module__.rsplit(".", 1)[0]
        self.processing = importlib.import_module(package + ".processing_falcon_ocr")
        enable_compact_image_padding(self.processing)
        self.rope = importlib.import_module(package + ".rope")
        self.upstream = importlib.import_module(package + ".modeling_falcon_ocr")
        self.upstream.compiled_flex_attn_decode = dynamic_flex_decode
        original_golden_rope = self.rope.apply_golden_freqs_cis_to_visual_pos

        def golden_rope_fp32(freqs, positions):
            # Autocast would downcast the upstream einsum to BF16; torch.polar
            # cannot consume BF16. Positional phases must remain FP32 anyway.
            with torch.autocast(freqs.device.type, enabled=False):
                return original_golden_rope(freqs.float(), positions.float())

        self.upstream.apply_golden_freqs_cis_to_visual_pos = golden_rope_fp32
        self.pad_id = self.tokenizer.convert_tokens_to_ids("<|pad|>")
        self.stop_ids = {
            self.model.config.eos_id,
            self.tokenizer.convert_tokens_to_ids("<|end_of_query|>"),
        }
        self.eos = self.tokenizer.convert_tokens_to_ids("<|end_of_query|>")
        self.model._pad_token_id = self.pad_id
        scatter = self.model._scatter_img_tokens_with_projector

        def autocast_scatter(h, *args):
            # Embedding is FP32 with master weights; Linear is BF16 in autocast.
            if torch.is_autocast_enabled("cuda"):
                h = h.to(torch.get_autocast_dtype("cuda"))
            return scatter(h, *args)

        self.model._scatter_img_tokens_with_projector = autocast_scatter
        for token in ("<|pad|>", "<|end_of_query|>", "<|OCR_PLAIN|>"):
            if (
                self.tokenizer.convert_ids_to_tokens(
                    self.tokenizer.convert_tokens_to_ids(token)
                )
                != token
            ):
                raise RuntimeError(f"Tokenizer contract mismatch: {token}")

    def target_ids(self, row):
        ids = self.tokenizer.encode(row["text"], add_special_tokens=False)
        if set(ids) & set(self.tokenizer.all_special_ids):
            raise ValueError(f"Reserved model token in label {row['id']}")
        if len(ids) + 1 > self.config.max_new_tokens:
            raise ValueError(
                f"Target {row['id']} needs {len(ids) + 1} tokens; increase FALCON_MAX_NEW_TOKENS"
            )
        return ids + [self.eos]

    def collate(self, rows, rng=None, supervised=True, cpu_only=False):
        c = self.config
        images = [open_crop(row, rng) for row in rows]
        batch = self.processing.process_batch(
            self.tokenizer,
            self.model.config,
            [(image, PROMPT) for image in images],
            max_length=4096,
            min_dimension=c.min_dimension,
            max_dimension=c.max_dimension,
        )
        if supervised:
            sequences, labels = [], []
            for prefix, row in zip(batch["tokens"], rows):
                prefix = prefix[prefix != self.pad_id]
                target = torch.tensor(self.target_ids(row), dtype=torch.long)
                sequences.append(torch.cat((prefix, target)))
                labels.append(torch.cat((torch.full_like(prefix, -100), target)))
            batch["tokens"] = torch.nn.utils.rnn.pad_sequence(
                sequences,
                batch_first=True,
                padding_value=self.pad_id,
                padding_side="left",
            )
            batch["labels"] = torch.nn.utils.rnn.pad_sequence(
                labels, batch_first=True, padding_value=-100, padding_side="left"
            )
            batch["pos_t"], batch["pos_hw"] = self.processing.get_pos_thw(
                batch["tokens"],
                batch["pixel_mask"],
                self.model.config,
                self.model.config.spatial_patch_size,
                pad_token_id=self.pad_id,
            )
        if (
            batch["tokens"].shape[1] + (0 if supervised else c.max_new_tokens)
            > self.model.config.max_seq_len
        ):
            raise ValueError(
                "Sequence exceeds context: reduce resolution or token budget"
            )
        return batch if cpu_only else self.to_device(batch)

    def to_device(self, batch):
        return {
            k: v.to(self.model.device) if torch.is_tensor(v) else v
            for k, v in batch.items()
        }

    def hidden(self, batch):
        import einops as E

        m, c = self.model, self.model.config
        tokens = batch["tokens"]
        h = m.tok_embeddings(tokens)
        patches = E.rearrange(
            batch["pixel_values"],
            "n (t pt) (h ph) (w pw) c -> n (t h w) (pt ph pw c)",
            pt=c.temporal_patch_size,
            ph=c.spatial_patch_size,
            pw=c.spatial_patch_size,
        )
        h = m._scatter_img_tokens_with_projector(
            h, patches, batch["pixel_mask"], tokens
        )
        temporal = m.freqs_cis[batch["pos_t"]]
        with torch.autocast(m.device.type, enabled=False):
            spatial = self.rope.apply_golden_freqs_cis_to_visual_pos(
                m.freqs_cis_golden.float(), batch["pos_hw"].float()
            )
        mask = hybrid_mask(tokens, c, self.pad_id)

        def block(x, layer):
            a = layer.attention
            q, k, v = a._pre_attention_qkv(x)
            q, k = self.rope.apply_3d_rotary_emb(
                q, k, temporal, spatial, batch["pos_hw"]
            )
            output = sink_attention(
                q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), a.sinks, mask
            )
            x = x + a.wo(output.transpose(1, 2).contiguous().flatten(2))
            ff = layer.feed_forward
            packed = ff.w13(F.rms_norm(x, (x.size(-1),)))
            gate, up = packed[..., 0::2], packed[..., 1::2]
            # Triton computes the product in FP32 before its BF16 store.
            gated = (F.relu(gate.float()).square() * up.float()).to(packed.dtype)
            return x + ff.w2(gated)

        use_checkpoint = (
            self.config.gradient_checkpointing
            and m.training
            and tokens.numel() > self.config.checkpoint_token_budget
        )
        for layer in m.layers.values():
            fn = partial(block, layer=layer)
            h = checkpoint(fn, h, use_reentrant=False) if use_checkpoint else fn(h)
        return m.norm(h)

    def loss(self, batch):
        hidden = self.hidden(batch)[:, :-1]
        labels = batch["labels"][:, 1:]
        valid = labels != -100
        selected, targets = hidden[valid], labels[valid]
        owners = torch.arange(labels.shape[0], device=labels.device)[:, None].expand_as(
            labels
        )[valid]
        # Only OCR positions reach the 65k vocabulary head; checkpoint chunks to
        # avoid keeping their large FP32 softmax intermediates until backward.
        sums = hidden.new_zeros(labels.shape[0], dtype=torch.float32)

        def token_losses(h, target):
            return F.cross_entropy(
                self.model.output(h).float(), target, reduction="none"
            )

        for start in range(0, len(targets), 128):
            loss = checkpoint(
                token_losses,
                selected[start : start + 128],
                targets[start : start + 128],
                use_reentrant=False,
            )
            sums = sums.scatter_add(0, owners[start : start + 128], loss)
        return (sums / valid.sum(1).clamp_min(1)).mean()

    @torch.inference_mode()
    def generate(self, rows):
        """Official cached forward, but enforce the exact generation cap and expose stops.

        Upstream _generate_batch rounds its budget to a block, then decodes to that
        rounded size. Track tokens explicitly for honest token_limit_rate reporting.
        """
        batch = self.collate(rows, supervised=False)
        tokens = batch["tokens"]
        b, length = tokens.shape
        size = math.ceil((length + self.config.max_new_tokens) / 128) * 128
        cache = self.upstream.KVCache(
            b,
            size,
            self.model.config.n_heads,
            self.model.config.head_dim,
            self.model.config.n_layers,
        )
        padded = F.pad(tokens, (0, size - length), value=self.pad_id)
        mask = self.model.get_attention_mask(padded, max_len=size)
        # Generation needs only the last position. Projecting every image/prompt
        # token to the 65k vocabulary wastes both VRAM and matrix multiplications.
        hook = self.model.output.register_forward_pre_hook(
            lambda _module, args: (args[0][:, -1:, :],)
        )
        try:
            logits = self.model(
                tokens=tokens,
                attention_mask=mask,
                kv_cache=cache,
                rope_pos_t=batch["pos_t"],
                rope_pos_hw=batch["pos_hw"],
                pixel_values=batch["pixel_values"],
                pixel_mask=batch["pixel_mask"],
            )
        finally:
            hook.remove()
        done = [False] * b
        generated = [[] for _ in rows]
        for step in range(self.config.max_new_tokens):
            next_tokens = logits[:, -1].argmax(-1)
            for i, token in enumerate(next_tokens.tolist()):
                if not done[i]:
                    if token in self.stop_ids:
                        done[i] = True
                    else:
                        generated[i].append(token)
            if all(done) or step + 1 == self.config.max_new_tokens:
                break
            done_mask = torch.tensor(done, dtype=torch.bool, device=tokens.device)
            next_tokens = next_tokens.masked_fill(done_mask, self.pad_id)[:, None]
            padded[:, cache.get_pos()] = next_tokens[:, 0]
            logits = self.model(tokens=next_tokens, attention_mask=mask, kv_cache=cache)
        return [
            {
                "prediction": self.tokenizer.decode(
                    ids, skip_special_tokens=False
                ).strip(),
                "generated_tokens": len(ids),
                "token_limit": not bool(stopped),
            }
            for ids, stopped in zip(generated, done)
        ]

    def save(self, destination):
        self.model.save_pretrained(
            destination, safe_serialization=True, max_shard_size="2GB"
        )
        self.tokenizer.save_pretrained(destination)


def autocast():
    return (
        torch.autocast("cuda", dtype=torch.bfloat16)
        if torch.cuda.is_available()
        else nullcontext()
    )
