"""Production batch-one decode for Surya's hybrid Qwen3.5 language model."""

from __future__ import annotations

import time
import types
from dataclasses import dataclass

import torch
from transformers.cache_utils import Cache, DynamicLayer, LinearAttentionLayer

from surya_mlp_kernels import fused_swiglu


@dataclass
class HybridFlashGeneration:
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


class HybridFlashCache(Cache):
    """Static linear-attention state plus packed FlashAttention KV caches."""

    def __init__(self, model, max_cache_len: int):
        config = model.config.get_text_config(decoder=True)
        layers = [
            LinearAttentionLayer()
            if layer_type == "linear_attention"
            else DynamicLayer()
            for layer_type in config.layer_types
        ]
        super().__init__(layers=layers)
        self.capacity = max_cache_len
        self.full_layer_indices = [
            index
            for index, layer_type in enumerate(config.layer_types)
            if layer_type == "full_attention"
        ]
        groups = config.num_attention_heads // config.num_key_value_heads
        self.key_cache: dict[int, torch.Tensor] = {}
        self.value_cache: dict[int, torch.Tensor] = {}
        self.seqlens: dict[int, torch.Tensor] = {}
        for layer_idx in self.full_layer_indices:
            keys = torch.empty(
                (
                    groups,
                    max_cache_len,
                    config.num_key_value_heads,
                    config.head_dim,
                ),
                device=model.device,
                dtype=model.dtype,
            )
            values = torch.empty_like(keys)
            seqlens = torch.zeros(
                (groups,),
                device=model.device,
                dtype=torch.int32,
            )
            torch._dynamo.mark_static_address(keys)
            torch._dynamo.mark_static_address(values)
            torch._dynamo.mark_static_address(seqlens)
            self.key_cache[layer_idx] = keys
            self.value_cache[layer_idx] = values
            self.seqlens[layer_idx] = seqlens

    def get_seq_length(self, layer_idx: int = 0):
        del layer_idx
        return self.seqlens[self.full_layer_indices[0]][0]

    def get_mask_sizes(self, query_length: int, layer_idx: int):
        del layer_idx
        return self.get_seq_length() + query_length, 0

    def get_max_cache_shape(self, layer_idx: int = 0):
        del layer_idx
        return self.capacity

    def reset(self):
        with torch.inference_mode():
            for layer in self.layers:
                layer.reset()
            for seqlens in self.seqlens.values():
                seqlens.zero_()

    def set_seq_length(self, length: int):
        with torch.inference_mode():
            for seqlens in self.seqlens.values():
                seqlens.fill_(length)


def patch_gated_delta_decode(model) -> list[tuple[object, object, object]]:
    from gated_delta_kernels import causal_conv1d_update, recurrent_gated_delta

    patched = []

    def triton_conv(
        hidden_states,
        conv_state,
        weight,
        bias=None,
        activation=None,
    ):
        if (
            hidden_states.shape[0] != 1
            or hidden_states.shape[-1] != 1
            or bias is not None
            or activation not in {None, "silu"}
        ):
            from transformers.models.qwen3_5.modeling_qwen3_5 import (
                torch_causal_conv1d_update,
            )

            return torch_causal_conv1d_update(
                hidden_states,
                conv_state,
                weight,
                bias=bias,
                activation=activation,
            )
        return causal_conv1d_update(hidden_states, conv_state, weight)

    def triton_recurrent(
        query,
        key,
        value,
        g,
        beta,
        initial_state,
        output_final_state,
        use_qk_l2norm_in_kernel=False,
    ):
        if (
            query.shape[0:2] != (1, 1)
            or initial_state is None
            or not use_qk_l2norm_in_kernel
        ):
            from transformers.models.qwen3_5.modeling_qwen3_5 import (
                torch_recurrent_gated_delta_rule,
            )

            return torch_recurrent_gated_delta_rule(
                query,
                key,
                value,
                g,
                beta,
                initial_state=initial_state,
                output_final_state=output_final_state,
                use_qk_l2norm_in_kernel=use_qk_l2norm_in_kernel,
            )
        output = recurrent_gated_delta(
            query,
            key,
            value,
            g,
            beta,
            initial_state,
        )
        return output, initial_state if output_final_state else None

    for layer in model.model.language_model.layers:
        if layer.layer_type != "linear_attention":
            continue
        linear_attn = layer.linear_attn
        patched.append(
            (
                linear_attn,
                linear_attn.causal_conv1d_update,
                linear_attn.recurrent_gated_delta_rule,
            )
        )
        linear_attn.causal_conv1d_update = triton_conv
        linear_attn.recurrent_gated_delta_rule = triton_recurrent
    return patched


def restore_gated_delta_decode(patched) -> None:
    for linear_attn, original_conv, original_recurrent in patched:
        linear_attn.causal_conv1d_update = original_conv
        linear_attn.recurrent_gated_delta_rule = original_recurrent


def patch_fused_mlp_decode(model):
    patched = []
    original_forwards = {}

    def fused_forward(mlp, hidden_states):
        if hidden_states.shape[0:2] != (1, 1):
            return original_forwards[id(mlp)](hidden_states)
        intermediate = fused_swiglu(
            hidden_states.reshape(-1),
            mlp.gate_proj.weight,
            mlp.up_proj.weight,
        ).view(1, 1, -1)
        return mlp.down_proj(intermediate)

    for layer in model.model.language_model.layers:
        mlp = layer.mlp
        patched.append((mlp, mlp.forward))
        original_forwards[id(mlp)] = mlp.forward
        mlp.forward = types.MethodType(fused_forward, mlp)
    return patched, original_forwards


def restore_fused_mlp_decode(patched) -> None:
    patched_modules, original_forwards = patched
    del original_forwards
    for mlp, original_forward in patched_modules:
        mlp.forward = original_forward


def patch_qwen35_flash_kvcache(
    model,
    *,
    num_splits: int,
    prefill_num_splits: int,
):
    import kernels
    from transformers.models.qwen3_5.modeling_qwen3_5 import (
        apply_rotary_pos_emb,
    )

    flash_kernel_module = kernels.get_kernel("kernels-community/flash-attn2")
    flash_attn_with_kvcache = flash_kernel_module.flash_attn_with_kvcache
    patched_attentions = []
    original_forwards = {}

    def flash_kvcache_forward(
        attention,
        hidden_states,
        position_embeddings,
        attention_mask,
        past_key_values=None,
        **forward_kwargs,
    ):
        if not isinstance(past_key_values, HybridFlashCache):
            return original_forwards[id(attention)](
                hidden_states,
                position_embeddings,
                attention_mask,
                past_key_values=past_key_values,
                **forward_kwargs,
            )
        del attention_mask

        input_shape = hidden_states.shape[:-1]
        hidden_shape = (*input_shape, -1, attention.head_dim)
        q_gate_size = attention.q_proj.out_features
        if hidden_states.shape[1] == 1:
            fused_qkv = torch.nn.functional.linear(
                hidden_states,
                attention.fused_qkv_weight,
            )
            q_gate, key_states, value_states = fused_qkv.split(
                attention.fused_qkv_sizes,
                dim=-1,
            )
        else:
            q_gate = attention.q_proj(hidden_states)
            key_states = attention.k_proj(hidden_states)
            value_states = attention.v_proj(hidden_states)
        if q_gate.shape[-1] != q_gate_size:
            raise RuntimeError("Unexpected fused Qwen3.5 Q/gate projection size.")

        query_states, gate = torch.chunk(
            q_gate.view(*input_shape, -1, attention.head_dim * 2),
            2,
            dim=-1,
        )
        gate = gate.reshape(*input_shape, -1)
        query_states = attention.q_norm(
            query_states.reshape(hidden_shape)
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
        query_states = query_states.transpose(1, 2).contiguous()
        key_states = key_states.transpose(1, 2).contiguous()
        value_states = value_states.transpose(1, 2).contiguous()
        groups = attention.num_key_value_groups
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
        layer_idx = attention.layer_idx
        active_num_splits = (
            prefill_num_splits if query_length != 1 else num_splits
        )
        batched_output = flash_attn_with_kvcache(
            batched_queries,
            past_key_values.key_cache[layer_idx],
            past_key_values.value_cache[layer_idx],
            k=batched_keys,
            v=batched_values,
            cache_seqlens=past_key_values.seqlens[layer_idx],
            softmax_scale=attention.scaling,
            causal=True,
            num_splits=active_num_splits,
        )
        past_key_values.seqlens[layer_idx].add_(query_length)
        output = (
            batched_output.unflatten(0, (batch_size, groups))
            .permute(0, 2, 3, 1, 4)
            .flatten(2, 3)
            .reshape(*input_shape, -1)
            .contiguous()
        )
        output = output * torch.sigmoid(gate)
        return attention.o_proj(output), None

    try:
        for layer in model.model.language_model.layers:
            if layer.layer_type != "full_attention":
                continue
            attention = layer.self_attn
            patched_attentions.append((attention, attention.forward))
            original_forwards[id(attention)] = attention.forward
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
        restore_qwen35_attention((patched_attentions, original_forwards))
        raise
    return patched_attentions, original_forwards


def restore_qwen35_attention(patched_attentions) -> None:
    patched_modules, original_forwards = patched_attentions
    del original_forwards
    for attention, original_forward in patched_modules:
        attention.forward = original_forward
        if hasattr(attention, "fused_qkv_weight"):
            delattr(attention, "fused_qkv_weight")
        if hasattr(attention, "fused_qkv_sizes"):
            delattr(attention, "fused_qkv_sizes")


class HybridFlashDecodeStep(torch.nn.Module):
    def __init__(self, model, cache: HybridFlashCache):
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
        logits = self.lm_head(hidden_states[:, -1, :])
        return logits.argmax(dim=-1)


class HybridFlashGreedyEngine:
    def __init__(
        self,
        model,
        *,
        max_new_tokens: int,
        eos_check_interval: int = 8,
        num_splits: int = 4,
        prefill_num_splits: int = 1,
        use_delta_kernels: bool = True,
        use_fused_mlp: bool = True,
        use_cuda_graph: bool = True,
        compile_decode: bool = True,
        minimum_cache_len: int = 0,
        use_dynamic_prefill: bool = False,
    ):
        if model.device.type != "cuda" or model.dtype != torch.bfloat16:
            raise ValueError("Optimized Surya requires CUDA BF16.")
        if max_new_tokens < 1 or eos_check_interval < 1:
            raise ValueError("Generation limits must be positive.")
        self.model = model
        self.max_new_tokens = max_new_tokens
        self.eos_check_interval = eos_check_interval
        self.num_splits = num_splits
        self.prefill_num_splits = prefill_num_splits
        self.use_cuda_graph = use_cuda_graph
        self.compile_decode = compile_decode
        self.minimum_cache_len = max(0, minimum_cache_len)
        self.use_dynamic_prefill = use_dynamic_prefill
        self.patched_attentions = ([], {})
        self.patched_delta = []
        self.patched_mlp = ([], {})
        try:
            self.patched_attentions = patch_qwen35_flash_kvcache(
                model,
                num_splits=num_splits,
                prefill_num_splits=prefill_num_splits,
            )
            self.patched_delta = (
                patch_gated_delta_decode(model) if use_delta_kernels else []
            )
            self.patched_mlp = (
                patch_fused_mlp_decode(model) if use_fused_mlp else ([], {})
            )
        except Exception:
            restore_fused_mlp_decode(self.patched_mlp)
            restore_gated_delta_decode(self.patched_delta)
            restore_qwen35_attention(self.patched_attentions)
            raise
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

    def restore_model(self):
        if self.restored:
            return
        restore_qwen35_attention(self.patched_attentions)
        restore_gated_delta_decode(self.patched_delta)
        restore_fused_mlp_decode(self.patched_mlp)
        self.patched_attentions = ([], {})
        self.patched_delta = []
        self.patched_mlp = ([], {})
        self.restored = True

    def _reset_graph_state(self):
        self.decode_step = None
        self.decode_graph = None
        self.graph_input_token = None
        self.graph_position = None
        self.graph_output = None
        self.graph_block_buffer = None

    def _ensure_cache(self, input_length: int):
        required_length = max(
            input_length + self.max_new_tokens,
            self.minimum_cache_len,
        )
        if self.cache is not None and self.cache.capacity >= required_length:
            self.cache.reset()
            return
        self.cache = HybridFlashCache(self.model, required_length)
        self._reset_graph_state()

    def _build_decode_step(self):
        step = HybridFlashDecodeStep(self.model, self.cache)
        if self.compile_decode:
            step = torch.compile(
                step,
                fullgraph=False,
                dynamic=False,
                options={"triton.cudagraphs": False},
            )
        self.decode_step = step

    def _copy_dynamic_cache(self, dynamic_cache):
        groups = (
            self.model.config.get_text_config(decoder=True).num_attention_heads
            // self.model.config.get_text_config(decoder=True).num_key_value_heads
        )
        with torch.inference_mode():
            for layer_idx, (destination, source) in enumerate(
                zip(self.cache.layers, dynamic_cache.layers, strict=True)
            ):
                if layer_idx in self.cache.seqlens:
                    keys = source.keys.transpose(1, 2).repeat(
                        groups,
                        1,
                        1,
                        1,
                    )
                    values = source.values.transpose(1, 2).repeat(
                        groups,
                        1,
                        1,
                        1,
                    )
                    sequence_length = keys.shape[1]
                    self.cache.key_cache[layer_idx][
                        :, :sequence_length
                    ].copy_(keys)
                    self.cache.value_cache[layer_idx][
                        :, :sequence_length
                    ].copy_(values)
                    self.cache.seqlens[layer_idx].fill_(sequence_length)
                    continue
                destination.update_conv_state(source.conv_states)
                destination.update_recurrent_state(source.recurrent_states)

    def _snapshot_linear_states(self):
        snapshots = {}
        for layer_idx, layer in enumerate(self.cache.layers):
            if not isinstance(layer, LinearAttentionLayer):
                continue
            snapshots[layer_idx] = (
                layer.conv_states.clone(),
                layer.recurrent_states.clone(),
            )
        return snapshots

    def _restore_linear_states(self, snapshots):
        with torch.inference_mode():
            for layer_idx, (conv_states, recurrent_states) in snapshots.items():
                layer = self.cache.layers[layer_idx]
                layer.conv_states.copy_(conv_states)
                layer.recurrent_states.copy_(recurrent_states)

    def _capture_decode_graph(self, seed_token, input_length, rope_delta):
        self._build_decode_step()
        linear_state_snapshots = self._snapshot_linear_states()
        self.graph_input_token = seed_token[:, None].clone()
        initial_position = input_length + rope_delta.to(seed_token.device)
        self.graph_position = (
            initial_position.reshape(1, 1, 1).expand(3, 1, 1).clone()
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
        self._restore_linear_states(linear_state_snapshots)
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
        # CUDA graph capture does not guarantee usable captured outputs on all
        # Windows/PyTorch combinations. Restore the prefill state and make the
        # first real replay authoritative.
        self._restore_linear_states(linear_state_snapshots)
        self.cache.set_seq_length(input_length)
        self._reset_decode_graph(seed_token, input_length, rope_delta)

    def _reset_decode_graph(self, seed_token, input_length, rope_delta):
        self.graph_input_token.copy_(seed_token[:, None])
        initial_position = input_length + rope_delta.to(seed_token.device)
        self.graph_position.copy_(
            initial_position.reshape(1, 1, 1).expand(3, 1, 1)
        )

    def _eager_decode(
        self,
        seed_token,
        input_length,
        rope_delta,
        eos_ids,
        max_new_tokens,
    ):
        if self.decode_step is None:
            self._build_decode_step()
        tokens = [int(seed_token[0].item())]
        next_token = seed_token[:, None]
        if tokens[0] in eos_ids:
            return tokens, 0
        with torch.inference_mode(), torch.autocast(
            "cuda",
            dtype=self.model.dtype,
        ):
            for offset in range(max_new_tokens - 1):
                position = input_length + offset + rope_delta.to(seed_token.device)
                position_ids = position.reshape(1, 1, 1).expand(3, 1, 1)
                next_token = self.decode_step(next_token, position_ids)[:, None]
                token_id = int(next_token[0, 0].item())
                tokens.append(token_id)
                if token_id in eos_ids:
                    break
        return tokens, len(tokens) - 1

    def _graph_decode(
        self,
        seed_token,
        input_length,
        rope_delta,
        eos_ids,
        max_new_tokens,
    ):
        captured_now = self.decode_graph is None
        if captured_now:
            self._capture_decode_graph(seed_token, input_length, rope_delta)
        else:
            self._reset_decode_graph(seed_token, input_length, rope_delta)

        token_list = [int(seed_token[0].item())]
        if token_list[0] in eos_ids or max_new_tokens == 1:
            return token_list, 0
        decode_steps = 0
        while len(token_list) < max_new_tokens:
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
        return token_list, decode_steps

    def generate(self, inputs, *, max_new_tokens: int | None = None):
        if self.restored:
            raise RuntimeError("The optimized engine has been restored.")
        if int(inputs["input_ids"].shape[0]) != 1:
            raise ValueError("Optimized Surya is single-page only.")
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
        with torch.inference_mode(), torch.autocast(
            "cuda",
            dtype=self.model.dtype,
        ):
            if self.use_dynamic_prefill:
                from transformers import DynamicCache

                dynamic_cache = DynamicCache(config=self.model.config)
                outputs = self.model(
                    **prefill_inputs,
                    past_key_values=dynamic_cache,
                    use_cache=True,
                    logits_to_keep=1,
                )
                self._copy_dynamic_cache(dynamic_cache)
                del dynamic_cache
            else:
                outputs = self.model(
                    **prefill_inputs,
                    past_key_values=self.cache,
                    use_cache=True,
                    logits_to_keep=1,
                )
        torch.cuda.synchronize()
        prefill_ms = (time.perf_counter() - prefill_started) * 1000

        seed_token = outputs.logits[:, -1].argmax(dim=-1)
        eos_ids = normalize_eos_token_ids(self.model)
        rope_delta = self.model.model.rope_deltas
        torch.cuda.synchronize()
        decode_started = time.perf_counter()
        if self.use_cuda_graph:
            token_list, decode_steps = self._graph_decode(
                seed_token,
                input_length,
                rope_delta,
                eos_ids,
                generation_limit,
            )
        else:
            token_list, decode_steps = self._eager_decode(
                seed_token,
                input_length,
                rope_delta,
                eos_ids,
                generation_limit,
            )
        torch.cuda.synchronize()
        decode_ms = (time.perf_counter() - decode_started) * 1000
        tokens = torch.tensor(
            [token_list],
            device=seed_token.device,
            dtype=torch.long,
        )
        return HybridFlashGeneration(
            token_ids=tokens,
            prefill_ms=prefill_ms,
            decode_ms=decode_ms,
            generated_tokens=len(token_list),
            decode_steps=decode_steps,
        )
