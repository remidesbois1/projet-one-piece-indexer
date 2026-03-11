# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License
# Copyright (C)  [2026]  Advanced Micro Devices, Inc. All rights reserved. Portions of this file consist of AI generated content.

import argparse
import glob
import os
import time


def resolve_og_api():
    """Resolve Python API for both regular and local/dev package layouts."""
    # Ensure the intended ORT package is loaded first on Windows.
    # This avoids picking up an older onnxruntime.dll from another location.
    import onnxruntime as _ort  # noqa: F401

    try:
        from onnxruntime_genai import onnxruntime_genai as og_api

        required = ["Config", "Model", "Generator", "GeneratorParams"]
        if all(hasattr(og_api, name) for name in required):
            return og_api
    except Exception:
        pass

    import onnxruntime_genai._dll_directory as dll_directory

    dll_directory.add_onnxruntime_dependency("onnxruntime-genai")
    import onnxruntime_genai.onnxruntime_genai as og_native

    return og_native


# og.set_log_options(enabled=True, model_input_values=True, model_output_values=True)


def _complete(text, state):
    return (glob.glob(text + "*") + [None])[state]


def get_image_paths(user_provided_paths, default_paths, interactive):
    paths = None

    if interactive:
        try:
            import readline

            readline.set_completer_delims(" \t\n;")
            readline.parse_and_bind("tab: complete")
            readline.set_completer(_complete)
        except ImportError:
            # Not available on some platforms. Ignore it.
            pass
        paths = [path.strip() for path in input("Image Path (comma separated; leave empty if no image): ").split(",")]
    else:
        paths = user_provided_paths if user_provided_paths else default_paths

    paths = [path for path in paths if path]
    return paths


def run(args: argparse.Namespace):
    og = resolve_og_api()
    print("Loading model...")

    # Register execution provider library if specified (for plug-in providers)
    if args.ep_library_path:
        print(f"Registering execution provider library: {args.ep_library_path}")

        # Determine the provider registration name based on execution provider
        provider_registration_name = None
        if args.execution_provider == "cuda":
            provider_registration_name = "CUDAExecutionProvider"
        elif args.execution_provider == "NvTensorRtRtx":
            provider_registration_name = "NvTensorRTRTXExecutionProvider"
        else:
            raise ValueError(
                f"Provider library registration not supported for '{args.execution_provider}'. Only 'cuda' and "
                f"'NvTensorRtRtx' support plug-in libraries."
            )

        og.register_execution_provider_library(provider_registration_name, args.ep_library_path)
        print(f"Successfully registered {provider_registration_name} from {args.ep_library_path}")

    config = og.Config(args.model_path)
    if args.execution_provider != "follow_config":
        config.clear_providers()
        if args.execution_provider != "cpu":
            print(f"Setting model to {args.execution_provider}...")
            config.append_provider(args.execution_provider)
    model = og.Model(config)
    print("Model loaded")

    processor = model.create_multimodal_processor()
    tokenizer_stream = processor.create_stream()

    interactive = not args.non_interactive

    while True:
        image_paths = get_image_paths(
            user_provided_paths=args.image_paths,
            default_paths=[],
            interactive=interactive,
        )

        images = None
        # Build prompt with Qwen3-VL format:
        # <|im_start|>user\n<|vision_start|><|image_pad|><|vision_end|>\ntext<|im_end|>\n<|im_start|>assistant\n
        prompt = "<|im_start|>user\n"

        # Get images
        if len(image_paths) == 0:
            print("No image provided")
        else:
            for image_path in image_paths:
                if not os.path.exists(image_path):
                    raise FileNotFoundError(f"Image file not found: {image_path}")
                print(f"Using image: {image_path}")
                # Add vision tokens (the processor will replace with proper image_pad tokens)
                prompt += "<|vision_start|><|vision_end|>\n"
            images = og.Images.open(*image_paths)

        if interactive:
            text = input("Prompt: ")
        else:
            if args.prompt:
                text = args.prompt
            else:
                text = "Describe this image in detail."
        prompt += f"{text}<|im_end|>\n<|im_start|>assistant\n"

        print("Processing inputs...")
        inputs = processor(prompt, images=images)
        print(f"Processor complete. Output keys: {list(inputs.keys())}")

        print("Generating response...")
        params = og.GeneratorParams(model)
        params.set_search_options(max_length=4096)

        generator = og.Generator(model, params)
        generator.set_inputs(inputs)
        start_time = time.time()

        while not generator.is_done():
            generator.generate_next_token()
            new_token = generator.get_next_tokens()[0]
            print(tokenizer_stream.decode(new_token), end="", flush=True)

        print()
        total_run_time = time.time() - start_time
        print(f"Total Time : {total_run_time:.2f}")

        for _ in range(3):
            print()

        # Delete the generator to free the captured graph before creating another one
        del generator

        if not interactive:
            break


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-m", "--model_path", type=str, required=True, help="Path to the folder containing the model")
    parser.add_argument(
        "-e",
        "--execution_provider",
        type=str,
        required=False,
        default="follow_config",
        choices=["cpu", "cuda", "dml", "NvTensorRtRtx", "follow_config"],
        help="Execution provider to run the ONNX Runtime session with. Defaults to follow_config that uses the "
        "execution provider listed in the genai_config.json instead.",
    )
    parser.add_argument(
        "-epl",
        "--ep_library_path",
        type=str,
        required=False,
        default=None,
        help="Path to the execution provider library DLL/SO for plug-in providers. "
        "Use this to load CUDA or NvTensorRT as plug-in providers instead of built-in. "
        "Example: -epl 'C:\\path\\to\\onnxruntime_providers_cuda.dll' or "
        "-epl '/usr/lib/libonnxruntime_providers_cuda.so'",
    )
    parser.add_argument("--image_paths", nargs="*", type=str, required=False, help="Path to the images, mainly for CI usage")
    parser.add_argument("-pr", "--prompt", required=False, help="Input prompts to generate tokens from, mainly for CI usage")
    parser.add_argument(
        "--non-interactive",
        action=argparse.BooleanOptionalAction,
        required=False,
        help="Non-interactive mode, mainly for CI usage",
    )
    args = parser.parse_args()
    run(args)
