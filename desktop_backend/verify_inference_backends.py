import os
import sys
import tempfile
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class FakeTensor:
    def __init__(self, values):
        self.values = list(values)
        self.shape = (1, len(self.values))

    def is_floating_point(self):
        return False

    def to(self, **_kwargs):
        return self

    def __getitem__(self, item):
        if isinstance(item, tuple) and len(item) == 2:
            _row, column = item
            if isinstance(column, slice):
                return self.values[column]
        return self.values[item]


class FakeTokenizer:
    eos_token = "<eos>"
    eos_token_id = 2
    pad_token_id = None
    pad_token = None
    padding_side = "right"

    def __len__(self):
        return 1000

    def decode(self, _token_ids, skip_special_tokens=True):
        return "SURYA_OK"


class FakeProcessor:
    tokenizer = FakeTokenizer()
    image_processor = types.SimpleNamespace(default_to_square=True)

    @classmethod
    def from_pretrained(cls, model_dir, trust_remote_code=False):
        require(trust_remote_code is True, "surya processor should trust remote code")
        require(Path(model_dir).joinpath("config.json").exists(), "surya processor model dir")
        return cls()

    def apply_chat_template(self, messages, add_generation_prompt, tokenize):
        require(add_generation_prompt is True, "surya prompt should request generation prompt")
        require(tokenize is False, "surya prompt should render text")
        require(messages[0]["content"][0]["type"] == "image", "surya prompt should include image")
        require(messages[0]["content"][1]["type"] == "text", "surya prompt should include text")
        return "SURYA_PROMPT"

    def __call__(self, text, images, return_tensors):
        require(text == ["SURYA_PROMPT"], "surya processor should receive rendered prompt")
        require(len(images) == 1, "surya processor should receive one image")
        require(return_tensors == "pt", "surya processor should produce torch tensors")
        return {"input_ids": FakeTensor([10, 11, 12])}

    def decode(self, token_ids, skip_special_tokens=True):
        require(token_ids == [200, 201], "surya decode should receive generated ids only")
        return "SURYA_OK"


class FakeSuryaModel:
    def __init__(self):
        self.config = types.SimpleNamespace(use_cache=False, eos_token_id=None, pad_token_id=None)
        self.generation_config = types.SimpleNamespace(
            do_sample=True,
            max_new_tokens=None,
            temperature=1.0,
            top_p=1.0,
            top_k=50,
            eos_token_id=None,
            pad_token_id=None,
        )

    @classmethod
    def from_pretrained(cls, model_dir, **kwargs):
        require(Path(model_dir).joinpath("config.json").exists(), "surya model dir")
        require(kwargs.get("trust_remote_code") is True, "surya model should trust remote code")
        require(kwargs.get("low_cpu_mem_usage") is True, "surya model should use low CPU memory")
        return cls()

    def eval(self):
        return self

    def to(self, **_kwargs):
        return self

    def generate(self, **kwargs):
        require("input_ids" in kwargs, "surya generate should receive input_ids")
        require(kwargs.get("do_sample") is False, "surya generate should be greedy")
        return FakeTensor([10, 11, 12, 200, 201])


class FakeTorch:
    float32 = "float32"
    float16 = "float16"
    bfloat16 = "bfloat16"
    cuda = types.SimpleNamespace(is_available=lambda: False)
    backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: False),
    )

    class inference_mode:
        def __enter__(self):
            return None

        def __exit__(self, *_exc):
            return False


def verify_fake_surya_backend(server, surya_dir: Path):
    surya_dir.mkdir(parents=True, exist_ok=True)
    surya_dir.joinpath("config.json").write_text("{}", encoding="utf-8")

    fake_transformers = types.SimpleNamespace(
        AutoProcessor=FakeProcessor,
        AutoModelForImageTextToText=FakeSuryaModel,
    )
    original_transformers = sys.modules.get("transformers")
    original_get_torch = server.get_torch
    try:
        sys.modules["transformers"] = fake_transformers
        server.get_torch = lambda: FakeTorch()
        server.load_model(server.SURYA_MODEL_KEY)
        status = server.model_status_payload(server.SURYA_MODEL_KEY)
        require(status["ready"] is True, "fake surya model should be ready")
        require(status["active_backend"] == server.BACKEND_TRANSFORMERS, "fake surya backend")
        output = server.generate_with_model(
            server.SURYA_MODEL_KEY,
            object(),
            server.messages_for_model(server.SURYA_MODEL_KEY),
        )
        require(output == "SURYA_OK", "fake surya generation output")
        print("fake Surya load/generate ok")
    finally:
        server.clear_loaded_model_state(server.get_model_state(server.SURYA_MODEL_KEY))
        server.get_torch = original_get_torch
        if original_transformers is None:
            sys.modules.pop("transformers", None)
        else:
            sys.modules["transformers"] = original_transformers


def main():
    original_env = dict(os.environ)
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            os.environ["PONEGLYPH_BBOX_MODEL_DIR"] = str(tmp_path / "bbox")
            os.environ["PONEGLYPH_BASE_MODEL_DIR"] = str(tmp_path / "base")
            os.environ["PONEGLYPH_SURYA_MODEL_DIR"] = str(tmp_path / "surya")

            import local_ocr_server as server

            status = server.model_status_payload(server.BBOX_MODEL_KEY)
            require(status["installed"] is False, "status should not require an installed model")
            require(status["loaded"] is False, "status should not load a model")
            require("requested_backend" in status, "status should expose requested_backend")
            require("active_backend" in status, "status should expose active_backend")
            require("backend_fallback_reason" in status, "status should expose fallback reason")
            require("perf_options" in status, "status should expose perf_options")
            surya_status = server.model_status_payload(server.SURYA_MODEL_KEY)
            require(surya_status["installed"] is False, "surya status should not require a model")
            require(surya_status["model_dir"].endswith("surya"), "surya model dir env")
            print("import/status without model ok")

            require(
                server.get_requested_backend() == server.BACKEND_TRANSFORMERS,
                "local backend should be transformers-only",
            )
            print("transformers-only backend selection ok")

            os.environ["PONEGLYPH_TEXT_MAX_NEW_TOKENS"] = "77"
            os.environ["PONEGLYPH_BBOX_MAX_NEW_TOKENS"] = "333"
            os.environ["PONEGLYPH_SURYA_MAX_NEW_TOKENS"] = "55"
            require(server.get_max_new_tokens(server.TEXT_MODEL_KEY) == 77, "text max tokens env")
            require(server.get_max_new_tokens(server.BBOX_MODEL_KEY) == 333, "bbox max tokens env")
            require(server.get_max_new_tokens(server.SURYA_MODEL_KEY) == 55, "surya max tokens env")
            perf_options = server.perf_options_payload()
            require(perf_options["text_max_new_tokens"] == 77, "perf text max tokens")
            require(perf_options["bbox_max_new_tokens"] == 333, "perf bbox max tokens")
            require(perf_options["surya_max_new_tokens"] == 55, "perf surya max tokens")
            print("env vars ok")

            route_paths = {route.path for route in server.app.routes}
            for route_path in {"/health", "/model/status", "/model/load", "/ocr", "/ocr/text"}:
                require(route_path in route_paths, f"missing FastAPI route {route_path}")
            print("FastAPI routes ok")

            health = server.health()
            require("requested_backend" in health, "health should expose requested_backend")
            require("active_backend" in health, "health should expose active_backend")
            require("perf_options" in health, "health should expose perf_options")

            verify_fake_surya_backend(server, tmp_path / "surya")

        print("verify_inference_backends.py: all checks passed")
        return 0
    finally:
        os.environ.clear()
        os.environ.update(original_env)


if __name__ == "__main__":
    raise SystemExit(main())
