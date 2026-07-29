"""Production single-page Flash KV-cache decode for LightOnOCR-BBox.

This is intentionally specialized for CUDA BF16, batch size one and the
Qwen3 16Q/8KV language model used by LightOnOCR-2. It keeps page-level
batching out of the runtime while packing the two GQA head groups inside a
single FlashAttention kernel launch.
"""

from __future__ import annotations

import time
import types
from dataclasses import dataclass

import torch

from lighton_gemv_kernels import bf16_gemv


@dataclass
class OptimizedGeneration:
    token_ids: torch.Tensor
    prefill_ms: float
    decode_ms: float
    generated_tokens: int
    decode_steps: int


def normalize_eos_token_ids(model) -> set[int]:
    token_ids = model.generation_config.eos_token_id
    if isinstance(token_ids, int):
        return {token_ids}
    return {int(token_id) for token_id in (token_ids or [])}


class FlashKVCache:
    def __init__(self, model, max_cache_len: int, cache_batch_size: int = 2):
        config = model.config.get_text_config(decoder=True)
        self.max_cache_len = max_cache_len
        self.key_cache = []
        self.value_cache = []
        self.seqlens = []
        for _ in range(config.num_hidden_layers):
            keys = torch.empty(
                (
                    cache_batch_size,
                    max_cache_len,
                    config.num_key_value_heads,
                    config.head_dim,
                ),
                device=model.device,
                dtype=model.dtype,
            )
            values = torch.empty_like(keys)
            seqlen = torch.zeros(
                (cache_batch_size,),
                device=model.device,
                dtype=torch.int32,
            )
            torch._dynamo.mark_static_address(keys)
            torch._dynamo.mark_static_address(values)
            torch._dynamo.mark_static_address(seqlen)
            self.key_cache.append(keys)
            self.value_cache.append(values)
            self.seqlens.append(seqlen)

    def get_seq_length(self, layer_idx: int = 0):
        return self.seqlens[layer_idx][0]

    def get_mask_sizes(self, query_length: int, layer_idx: int):
        return self.get_seq_length(layer_idx) + query_length, 0

    def get_max_cache_shape(self, layer_idx: int = 0):
        return self.max_cache_len

    def reset(self):
        with torch.inference_mode():
            for seqlen in self.seqlens:
                seqlen.zero_()

    def set_seq_length(self, length: int):
        with torch.inference_mode():
            for seqlen in self.seqlens:
                seqlen.fill_(length)


def patch_qwen3_flash_kvcache(
    model,
    *,
    num_splits: int,
    prefill_num_splits: int,
):
    import kernels
    from transformers.models.qwen3.modeling_qwen3 import apply_rotary_pos_emb

    flash_kernel_module = kernels.get_kernel("kernels-community/flash-attn2")
    flash_attn_with_kvcache = flash_kernel_module.flash_attn_with_kvcache
    patched_attentions = []

    def flash_kvcache_forward(
        attention,
        hidden_states,
        position_embeddings,
        attention_mask,
        past_key_values=None,
        **_kwargs,
    ):
        del attention_mask
        input_shape = hidden_states.shape[:-1]
        hidden_shape = (*input_shape, -1, attention.head_dim)
        if hidden_states.shape[1] == 1:
            fused_qkv = bf16_gemv(
                hidden_states.reshape(-1),
                attention.fused_qkv_weight,
            ).view(1, 1, -1)
            query_states, key_states, value_states = fused_qkv.split(
                attention.fused_qkv_sizes,
                dim=-1,
            )
        else:
            query_states = attention.q_proj(hidden_states)
            key_states = attention.k_proj(hidden_states)
            value_states = attention.v_proj(hidden_states)

        query_states = attention.q_norm(
            query_states.view(hidden_shape)
        ).transpose(1, 2)
        key_states = attention.k_norm(
            key_states.view(hidden_shape)
        ).transpose(1, 2)
        value_states = value_states.view(hidden_shape).transpose(1, 2)
        cos, sin = position_embeddings
        query_states, key_states = apply_rotary_pos_emb(
            query_states,
            key_states,
            cos,
            sin,
        )
        if not isinstance(past_key_values, FlashKVCache):
            raise TypeError("FlashKVCache is required by optimized attention.")

        layer_idx = attention.layer_idx
        query_states = query_states.transpose(1, 2).contiguous()
        key_states = key_states.transpose(1, 2).contiguous()
        value_states = value_states.transpose(1, 2).contiguous()
        groups = (
            attention.config.num_attention_heads
            // attention.config.num_key_value_heads
        )
        grouped_queries = query_states.unflatten(
            2,
            (attention.config.num_key_value_heads, groups),
        )
        batch_size, query_length = query_states.shape[:2]
        batched_queries = grouped_queries.permute(0, 3, 1, 2, 4).reshape(
            batch_size * groups,
            query_length,
            attention.config.num_key_value_heads,
            attention.head_dim,
        )
        batched_keys = key_states.repeat_interleave(groups, dim=0)
        batched_values = value_states.repeat_interleave(groups, dim=0)
        active_num_splits = (
            prefill_num_splits if hidden_states.shape[1] != 1 else num_splits
        )
        batched_output = flash_attn_with_kvcache(
            batched_queries.contiguous(),
            past_key_values.key_cache[layer_idx],
            past_key_values.value_cache[layer_idx],
            k=batched_keys,
            v=batched_values,
            cache_seqlens=past_key_values.seqlens[layer_idx],
            softmax_scale=attention.scaling,
            causal=True,
            num_splits=active_num_splits,
        )
        past_key_values.seqlens[layer_idx].add_(hidden_states.shape[1])
        output = (
            batched_output.unflatten(0, (batch_size, groups))
            .permute(0, 2, 3, 1, 4)
            .flatten(2, 3)
            .reshape(*input_shape, -1)
            .contiguous()
        )
        return attention.o_proj(output), None

    try:
        for layer in model.model.language_model.layers:
            attention = layer.self_attn
            patched_attentions.append((attention, attention.forward))
            attention.fused_qkv_sizes = (
                attention.q_proj.out_features,
                attention.k_proj.out_features,
                attention.v_proj.out_features,
            )
            attention.fused_qkv_weight = torch.nn.Parameter(
                torch.cat(
                    (
                        attention.q_proj.weight,
                        attention.k_proj.weight,
                        attention.v_proj.weight,
                    ),
                    dim=0,
                ).contiguous(),
                requires_grad=False,
            )
            attention.forward = types.MethodType(
                flash_kvcache_forward,
                attention,
            )
    except Exception:
        restore_qwen3_attention(patched_attentions)
        raise
    return patched_attentions


def restore_qwen3_attention(patched_attentions) -> None:
    for attention, original_forward in patched_attentions:
        attention.forward = original_forward
        if hasattr(attention, "fused_qkv_weight"):
            delattr(attention, "fused_qkv_weight")
        if hasattr(attention, "fused_qkv_sizes"):
            delattr(attention, "fused_qkv_sizes")


class FlashKVDecodeStep(torch.nn.Module):
    def __init__(self, model, cache: FlashKVCache):
        super().__init__()
        self.language_model = model.model.language_model
        self.lm_head = model.lm_head
        self.cache = cache

    def forward(self, input_ids, position_ids):
        hidden_states = self.language_model.embed_tokens(input_ids)
        position_embeddings = self.language_model.rotary_emb(
            hidden_states,
            position_ids,
        )
        for decoder_layer in self.language_model.layers:
            hidden_states = decoder_layer(
                hidden_states,
                attention_mask=None,
                position_embeddings=position_embeddings,
                position_ids=position_ids,
                past_key_values=self.cache,
                use_cache=True,
            )
        hidden_states = self.language_model.norm(hidden_states)
        logits = bf16_gemv(
            hidden_states[:, -1, :].reshape(-1),
            self.lm_head.weight,
        ).unsqueeze(0)
        return logits.argmax(dim=-1)


class FlashKVGreedyEngine:
    def __init__(
        self,
        model,
        *,
        max_new_tokens: int,
        eos_check_interval: int = 8,
        num_splits: int = 4,
        prefill_num_splits: int = 1,
        compile_mode: str = "autotune",
        minimum_cache_len: int = 0,
    ):
        if model.device.type != "cuda" or model.dtype != torch.bfloat16:
            raise ValueError("Optimized LightOnOCR requires CUDA BF16.")
        if max_new_tokens < 1:
            raise ValueError("max_new_tokens must be at least 1.")
        if eos_check_interval < 1:
            raise ValueError("eos_check_interval must be at least 1.")
        if num_splits < 1 or prefill_num_splits < 1:
            raise ValueError("FlashAttention num_splits must be at least 1.")
        if compile_mode not in {"safe", "autotune"}:
            raise ValueError("compile_mode must be 'safe' or 'autotune'.")

        self.model = model
        self.max_new_tokens = max_new_tokens
        self.eos_check_interval = eos_check_interval
        self.num_splits = num_splits
        self.prefill_num_splits = prefill_num_splits
        self.compile_mode = compile_mode
        self.minimum_cache_len = max(0, minimum_cache_len)
        self.patched_attentions = patch_qwen3_flash_kvcache(
            model,
            num_splits=num_splits,
            prefill_num_splits=prefill_num_splits,
        )
        self.cache = None
        self.decode_step = None
        self.decode_graph = None
        self.graph_input_token = None
        self.graph_position = None
        self.graph_output = None
        self.graph_block_buffer = None
        self.restored = False
        torch._dynamo.config.recompile_limit = max(
            torch._dynamo.config.recompile_limit,
            64,
        )

    def restore_model(self) -> None:
        if self.restored:
            return
        restore_qwen3_attention(self.patched_attentions)
        self.patched_attentions = []
        self.cache = None
        self.decode_step = None
        self.decode_graph = None
        self.graph_input_token = None
        self.graph_position = None
        self.graph_output = None
        self.graph_block_buffer = None
        self.restored = True

    def _reset_graph_state(self) -> None:
        self.decode_step = None
        self.decode_graph = None
        self.graph_input_token = None
        self.graph_position = None
        self.graph_output = None
        self.graph_block_buffer = None

    def _ensure_cache(self, input_length: int) -> None:
        required_length = max(
            input_length + self.max_new_tokens,
            self.minimum_cache_len,
        )
        if self.cache is not None and self.cache.max_cache_len >= required_length:
            self.cache.reset()
            return
        self.cache = FlashKVCache(
            self.model,
            required_length,
            cache_batch_size=2,
        )
        # CUDA Graphs retain cache addresses. A larger cache must be followed
        # by a fresh capture before another decode.
        self._reset_graph_state()

    def _capture_decode_graph(
        self,
        seed_token: torch.Tensor,
        input_length: int,
    ) -> None:
        self.decode_step = FlashKVDecodeStep(self.model, self.cache)
        compile_kwargs = {"fullgraph": False, "dynamic": False}
        if self.compile_mode == "autotune":
            compile_kwargs["mode"] = "max-autotune-no-cudagraphs"
        else:
            compile_kwargs["options"] = {"triton.cudagraphs": False}
        self.decode_step = torch.compile(self.decode_step, **compile_kwargs)
        self.graph_input_token = seed_token[:, None].clone()
        self.graph_position = torch.full(
            (1, 1),
            input_length,
            device=seed_token.device,
            dtype=torch.long,
        )
        self.graph_block_buffer = torch.empty(
            self.eos_check_interval,
            device=seed_token.device,
            dtype=torch.long,
        )

        warmup_stream = torch.cuda.Stream()
        warmup_stream.wait_stream(torch.cuda.current_stream())
        with (
            torch.cuda.stream(warmup_stream),
            torch.inference_mode(),
            torch.autocast("cuda", dtype=self.model.dtype),
        ):
            for _ in range(2):
                self.decode_step(self.graph_input_token, self.graph_position)
        torch.cuda.current_stream().wait_stream(warmup_stream)
        self.cache.set_seq_length(input_length)

        self.decode_graph = torch.cuda.CUDAGraph()
        with (
            torch.cuda.graph(self.decode_graph),
            torch.inference_mode(),
            torch.autocast("cuda", dtype=self.model.dtype),
        ):
            for block_index in range(self.eos_check_interval):
                self.graph_output = self.decode_step(
                    self.graph_input_token,
                    self.graph_position,
                )
                self.graph_block_buffer[block_index].copy_(self.graph_output[0])
                self.graph_input_token.copy_(self.graph_output[:, None])
                self.graph_position.add_(1)

    def _reset_decode_graph(
        self,
        seed_token: torch.Tensor,
        input_length: int,
    ) -> None:
        self.graph_input_token.copy_(seed_token[:, None])
        self.graph_position.fill_(input_length)

    def _graph_decode(
        self,
        seed_token: torch.Tensor,
        input_length: int,
        eos_ids: set[int],
        max_new_tokens: int,
    ):
        captured_now = self.decode_graph is None
        if captured_now:
            self._capture_decode_graph(seed_token, input_length)
        else:
            self._reset_decode_graph(seed_token, input_length)

        seed_id = int(seed_token[0].item())
        token_list = [seed_id]
        if seed_id in eos_ids or max_new_tokens == 1:
            return (
                torch.tensor(
                    [token_list],
                    device=seed_token.device,
                    dtype=torch.long,
                ),
                1,
                0,
            )

        decode_steps = 0
        use_captured_output = captured_now
        while len(token_list) < max_new_tokens:
            if use_captured_output:
                use_captured_output = False
            else:
                self.decode_graph.replay()
            remaining = max_new_tokens - len(token_list)
            recent = self.graph_block_buffer.tolist()[:remaining]
            decode_steps += len(recent)
            eos_offset = next(
                (
                    offset
                    for offset, token_id in enumerate(recent)
                    if token_id in eos_ids
                ),
                None,
            )
            if eos_offset is not None:
                token_list.extend(recent[: eos_offset + 1])
                break
            token_list.extend(recent)
        return (
            torch.tensor(
                [token_list],
                device=seed_token.device,
                dtype=torch.long,
            ),
            len(token_list),
            decode_steps,
        )

    def generate(
        self,
        inputs,
        *,
        max_new_tokens: int | None = None,
    ) -> OptimizedGeneration:
        if self.restored:
            raise RuntimeError("The optimized engine has been restored.")
        if int(inputs["input_ids"].shape[0]) != 1:
            raise ValueError("Optimized LightOnOCR is single-page only.")

        generation_limit = min(
            self.max_new_tokens,
            max_new_tokens or self.max_new_tokens,
        )
        input_length = int(inputs["input_ids"].shape[1])
        self._ensure_cache(input_length)
        prefill_inputs = {
            key: value
            for key, value in inputs.items()
            if key != "attention_mask"
        }

        torch.cuda.synchronize()
        prefill_started = time.perf_counter()
        with (
            torch.inference_mode(),
            torch.autocast("cuda", dtype=self.model.dtype),
        ):
            outputs = self.model(
                **prefill_inputs,
                past_key_values=self.cache,
                use_cache=True,
                logits_to_keep=1,
            )
        torch.cuda.synchronize()
        prefill_ms = (time.perf_counter() - prefill_started) * 1000

        eos_ids = normalize_eos_token_ids(self.model)
        next_token = outputs.logits[:, -1].argmax(dim=-1)
        torch.cuda.synchronize()
        decode_started = time.perf_counter()
        stacked, generated_tokens, decode_steps = self._graph_decode(
            next_token,
            input_length,
            eos_ids,
            generation_limit,
        )
        torch.cuda.synchronize()
        decode_ms = (time.perf_counter() - decode_started) * 1000
        return OptimizedGeneration(
            token_ids=stacked,
            prefill_ms=prefill_ms,
            decode_ms=decode_ms,
            generated_tokens=generated_tokens,
            decode_steps=decode_steps,
        )
