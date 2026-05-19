import os
import sys
import tempfile
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    original_env = dict(os.environ)
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            os.environ["PONEGLYPH_BBOX_MODEL_DIR"] = str(tmp_path / "bbox")
            os.environ["PONEGLYPH_BASE_MODEL_DIR"] = str(tmp_path / "base")

            import local_ocr_server as server

            status = server.model_status_payload(server.BBOX_MODEL_KEY)
            require(status["installed"] is False, "status should not require an installed model")
            require(status["loaded"] is False, "status should not load a model")
            require("requested_backend" in status, "status should expose requested_backend")
            require("active_backend" in status, "status should expose active_backend")
            require("backend_fallback_reason" in status, "status should expose fallback reason")
            require("perf_options" in status, "status should expose perf_options")
            print("import/status without model ok")

            os.environ["PONEGLYPH_INFERENCE_BACKEND"] = "transformers"
            require(server.get_requested_backend() == server.BACKEND_TRANSFORMERS, "transformers env")
            require(
                server.backend_attempt_order(server.BACKEND_TRANSFORMERS, "cuda")
                == [server.BACKEND_TRANSFORMERS],
                "transformers backend must not try vLLM",
            )

            os.environ["PONEGLYPH_INFERENCE_BACKEND"] = "auto"
            require(
                server.backend_attempt_order(server.BACKEND_AUTO, "cuda")
                == [server.BACKEND_VLLM, server.BACKEND_TRANSFORMERS],
                "auto/cuda should try vLLM then transformers",
            )
            require(
                server.backend_attempt_order(server.BACKEND_AUTO, "cpu")
                == [server.BACKEND_TRANSFORMERS],
                "auto/cpu should use transformers",
            )
            require(
                server.backend_attempt_order(server.BACKEND_AUTO, "mps")
                == [server.BACKEND_TRANSFORMERS],
                "auto/mps should use transformers",
            )
            print("backend selection ok")

            with mock.patch.dict(sys.modules, {"vllm": None}):
                available, reason = server.inspect_vllm_availability("cuda")
            require(available is False, "missing vLLM should be reported unavailable")
            require("vLLM runtime import failed" in reason, "missing vLLM reason should be explicit")
            fallback_reason = server.format_backend_fallback_reason(RuntimeError(reason))
            require("transformers fallback" in fallback_reason, "fallback reason should name transformers")
            with mock.patch.object(server, "model_architectures", return_value=["OtherVisionModel"]):
                try:
                    server.ensure_vllm_model_supported("unused")
                except RuntimeError as exc:
                    require(
                        "vLLM unavailable/unsupported for this architecture" in str(exc),
                        "unsupported vLLM architecture should be explicit",
                    )
                else:
                    raise AssertionError("unsupported vLLM architecture should fail")
            print("vLLM optional fallback ok")

            os.environ["PONEGLYPH_TEXT_MAX_NEW_TOKENS"] = "77"
            os.environ["PONEGLYPH_BBOX_MAX_NEW_TOKENS"] = "333"
            require(server.get_max_new_tokens(server.TEXT_MODEL_KEY) == 77, "text max tokens env")
            require(server.get_max_new_tokens(server.BBOX_MODEL_KEY) == 333, "bbox max tokens env")
            perf_options = server.perf_options_payload()
            require(perf_options["text_max_new_tokens"] == 77, "perf text max tokens")
            require(perf_options["bbox_max_new_tokens"] == 333, "perf bbox max tokens")
            print("env vars ok")

            route_paths = {route.path for route in server.app.routes}
            for route_path in {"/health", "/model/status", "/model/load", "/ocr", "/ocr/text"}:
                require(route_path in route_paths, f"missing FastAPI route {route_path}")
            print("FastAPI routes ok")

            health = server.health()
            require("requested_backend" in health, "health should expose requested_backend")
            require("active_backend" in health, "health should expose active_backend")
            require("perf_options" in health, "health should expose perf_options")

        print("verify_inference_backends.py: all checks passed")
        return 0
    finally:
        os.environ.clear()
        os.environ.update(original_env)


if __name__ == "__main__":
    raise SystemExit(main())
