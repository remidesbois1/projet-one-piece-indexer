"""Production batch-one fused MLP kernels for Surya's Qwen3.5 decoder."""

from __future__ import annotations

import torch
import triton
import triton.language as tl


@triton.autotune(
    configs=[
        triton.Config({"BLOCK_N": block_n}, num_warps=num_warps)
        for block_n in (1, 2, 4, 8)
        for num_warps in (4, 8)
    ],
    key=["N", "K"],
)
@triton.jit
def _fused_swiglu_kernel(
    x_ptr,
    gate_weight_ptr,
    up_weight_ptr,
    output_ptr,
    N: tl.constexpr,
    K: tl.constexpr,
    BLOCK_N: tl.constexpr,
    BLOCK_K: tl.constexpr,
):
    row_ids = tl.program_id(0) * BLOCK_N + tl.arange(0, BLOCK_N)
    row_offsets = row_ids[:, None]
    column_offsets = tl.arange(0, BLOCK_K)[None, :]
    mask = (row_offsets < N) & (column_offsets < K)
    inputs = tl.load(
        x_ptr + column_offsets,
        mask=column_offsets < K,
        other=0.0,
    ).to(tl.float32)
    gate_weights = tl.load(
        gate_weight_ptr + row_offsets * K + column_offsets,
        mask=mask,
        other=0.0,
    ).to(tl.float32)
    up_weights = tl.load(
        up_weight_ptr + row_offsets * K + column_offsets,
        mask=mask,
        other=0.0,
    ).to(tl.float32)
    gate = tl.sum(gate_weights * inputs, axis=1)
    up = tl.sum(up_weights * inputs, axis=1)
    output = gate * tl.sigmoid(gate) * up
    tl.store(output_ptr + row_ids, output, mask=row_ids < N)


def launch_fused_swiglu(
    inputs: torch.Tensor,
    gate_weight: torch.Tensor,
    up_weight: torch.Tensor,
) -> torch.Tensor:
    if inputs.ndim != 1 or gate_weight.ndim != 2:
        raise ValueError("Fused SwiGLU expects one vector and two matrices.")
    if gate_weight.shape != up_weight.shape:
        raise ValueError("Gate and up projection shapes must match.")
    n, k = gate_weight.shape
    if inputs.shape[0] != k:
        raise ValueError("Fused SwiGLU input dimensions do not match.")
    if (
        inputs.dtype != torch.bfloat16
        or gate_weight.dtype != torch.bfloat16
        or up_weight.dtype != torch.bfloat16
    ):
        raise ValueError("Fused SwiGLU requires BF16 tensors.")
    output = torch.empty(n, device=inputs.device, dtype=inputs.dtype)
    grid = lambda meta: (triton.cdiv(n, meta["BLOCK_N"]),)
    _fused_swiglu_kernel[grid](
        inputs,
        gate_weight,
        up_weight,
        output,
        N=n,
        K=k,
        BLOCK_K=triton.next_power_of_2(k),
    )
    return output


@torch.library.custom_op(
    "surya_bbox_bench::fused_swiglu",
    mutates_args=(),
)
def fused_swiglu(
    inputs: torch.Tensor,
    gate_weight: torch.Tensor,
    up_weight: torch.Tensor,
) -> torch.Tensor:
    return launch_fused_swiglu(inputs, gate_weight, up_weight)


@fused_swiglu.register_fake
def fake_fused_swiglu(
    inputs: torch.Tensor,
    gate_weight: torch.Tensor,
    up_weight: torch.Tensor,
) -> torch.Tensor:
    del up_weight
    return torch.empty(
        gate_weight.shape[0],
        device=inputs.device,
        dtype=inputs.dtype,
    )
