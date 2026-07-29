"""Triton BF16 GEMV used by the optimized single-page LightOnOCR decode."""

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
def _bf16_gemv_kernel(
    x_ptr,
    weight_ptr,
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
    weights = tl.load(
        weight_ptr + row_offsets * K + column_offsets,
        mask=mask,
        other=0.0,
    ).to(tl.float32)
    inputs = tl.load(
        x_ptr + column_offsets,
        mask=column_offsets < K,
        other=0.0,
    ).to(tl.float32)
    result = tl.sum(weights * inputs, axis=1)
    tl.store(output_ptr + row_ids, result, mask=row_ids < N)


def launch_bf16_gemv(
    inputs: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    if inputs.ndim != 1 or weight.ndim != 2:
        raise ValueError("BF16 GEMV expects a vector and a 2D weight matrix.")
    n, k = weight.shape
    if inputs.shape[0] != k:
        raise ValueError("Input and weight dimensions do not match.")
    if inputs.dtype != torch.bfloat16 or weight.dtype != torch.bfloat16:
        raise ValueError("The optimized GEMV requires BF16 inputs and weights.")

    output = torch.empty(n, device=inputs.device, dtype=inputs.dtype)
    grid = lambda meta: (triton.cdiv(n, meta["BLOCK_N"]),)
    _bf16_gemv_kernel[grid](
        inputs,
        weight,
        output,
        N=n,
        K=k,
        BLOCK_K=triton.next_power_of_2(k),
    )
    return output


@torch.library.custom_op(
    "poneglyph_lighton::bf16_gemv",
    mutates_args=(),
)
def bf16_gemv(
    inputs: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    return launch_bf16_gemv(inputs, weight)


@bf16_gemv.register_fake
def fake_bf16_gemv(
    inputs: torch.Tensor,
    weight: torch.Tensor,
) -> torch.Tensor:
    return torch.empty(
        weight.shape[0],
        device=inputs.device,
        dtype=inputs.dtype,
    )
