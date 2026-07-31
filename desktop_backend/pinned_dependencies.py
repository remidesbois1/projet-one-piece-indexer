"""Immutable pins for executable dependencies fetched from the Hub."""

FLASH_ATTN_KERNEL_REPO_ID = "kernels-community/flash-attn2"
FLASH_ATTN_KERNEL_REVISION = "6a810a7a010ba2aad6613f1f0f7b226fb8bdee3c"


def load_pinned_flash_attention_kernel():
    import kernels

    package_name, variant_path = kernels.install_kernel(
        FLASH_ATTN_KERNEL_REPO_ID,
        FLASH_ATTN_KERNEL_REVISION,
        local_files_only=True,
    )
    return kernels.get_local_kernel(variant_path, package_name)
