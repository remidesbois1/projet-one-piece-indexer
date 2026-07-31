import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import local_ocr_server as server  # noqa: E402
import pinned_dependencies  # noqa: E402


def manifest_for(contents, revision="a" * 40):
    return {
        "repo_id": "example/model",
        "revision": revision,
        "dir_name": "model",
        "trust_remote_code": False,
        "files": [
            {
                "path": relative_path,
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
            for relative_path, content in contents.items()
        ],
    }


def runtime_contents(prefix=b"safe"):
    return {
        relative_path: prefix + relative_path.encode("utf-8")
        for relative_path in sorted(server.RUNTIME_MODEL_FILES)
    }


def write_contents(root: Path, contents) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for relative_path, content in contents.items():
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


class ModelRegistryTests(unittest.TestCase):
    def setUp(self):
        state = server.get_model_state(server.BBOX_MODEL_KEY)
        server.clear_loaded_model_state(state)
        state["integrity_error"] = None
        state["last_error"] = None

    def tearDown(self):
        state = server.get_model_state(server.BBOX_MODEL_KEY)
        server.clear_loaded_model_state(state)
        state["integrity_error"] = None
        state["last_error"] = None

    def test_embedded_registry_has_immutable_verified_weight_pins(self):
        expected = {
            "bbox": (
                "8bdf97f30cb8006d17624407a847b6766fa2374b",
                2011367496,
                "a981e7e51584cd86b1f4e7bec2e786f4e28661003c3a5f9f6bfe6c6a00bd05c0",
            ),
            "base": (
                "3d5181ce138e7d92132a741f1e54c3a9e602e129",
                2011367496,
                "941647735280ef32d60fd575ddf8103e5526ff36edb8d1778ca953e2f5b16153",
            ),
            "surya": (
                "7d7b358c545cfe757329f780da6ed4100bb5909f",
                1331461328,
                "9d3554f1487caa1fd33c30e6a397d306b0d71fe041639f8668482ad3b02a223d",
            ),
            "surya_bbox": (
                "95e841b7dfcfa3cd7ea18f4d87a1c112490c909c",
                1331461328,
                "20bd380b1029b9b706fb32d0ef72e6c989de87669a21a1cfd6c31bc242a17b00",
            ),
        }
        for model_key, (revision, size, sha256) in expected.items():
            entry = server.model_registry_entry(model_key)
            weight = next(item for item in entry["files"] if item["path"] == "model.safetensors")
            self.assertEqual(entry["revision"], revision)
            self.assertIs(entry["trust_remote_code"], False)
            self.assertEqual(weight["size"], size)
            self.assertEqual(weight["sha256"], sha256)

    def test_registry_integrity_anchor_rejects_tampering(self):
        payload = server.MODEL_REGISTRY_PATH.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp_dir:
            tampered_path = Path(tmp_dir, "model_registry.json")
            tampered_path.write_text(
                payload.replace("Remidesbois/", "attacker/", 1),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "ancre integree"):
                server.load_model_registry(tampered_path)

    def test_manifest_verifier_rejects_missing_wrong_size_and_wrong_hash(self):
        contents = {"config.json": b"{}", "model.safetensors": b"weights"}
        manifest = manifest_for(contents)
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            write_contents(root, contents)
            server.verify_snapshot_against_manifest(root, manifest)

            (root / "config.json").unlink()
            with self.assertRaisesRegex(server.ModelIntegrityError, "absent"):
                server.verify_snapshot_against_manifest(root, manifest)

            (root / "config.json").write_bytes(b"too-long")
            with self.assertRaisesRegex(server.ModelIntegrityError, "Taille invalide"):
                server.verify_snapshot_against_manifest(root, manifest)

            (root / "config.json").write_bytes(b"[]")
            with self.assertRaisesRegex(server.ModelIntegrityError, "SHA256 invalide"):
                server.verify_snapshot_against_manifest(root, manifest)

            (root / "config.json").write_bytes(contents["config.json"])
            (root / "adapter_config.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(server.ModelIntegrityError, "Fichiers inattendus"):
                server.verify_snapshot_against_manifest(
                    root,
                    manifest,
                    reject_unexpected=True,
                )

            (root / "adapter_config.json").unlink()
            (root / "unexpected.py").write_text("raise SystemExit", encoding="utf-8")
            with self.assertRaisesRegex(server.ModelIntegrityError, "executables non manifestes"):
                server.verify_snapshot_against_manifest(
                    root,
                    manifest,
                    reject_unexpected=True,
                )

    def test_download_uses_revision_allowlist_and_promotes_verified_staging(self):
        contents = runtime_contents()
        manifest = manifest_for(contents, revision="b" * 40)
        calls = []

        def fake_snapshot_download(**kwargs):
            calls.append(kwargs)
            write_contents(Path(kwargs["local_dir"]), contents)
            Path(kwargs["local_dir"], ".cache").mkdir()
            return kwargs["local_dir"]

        fake_hub = types.SimpleNamespace(snapshot_download=fake_snapshot_download)
        with tempfile.TemporaryDirectory() as tmp_dir:
            destination = Path(tmp_dir, "model")
            destination.mkdir()
            (destination / "old.txt").write_text("old", encoding="utf-8")
            with (
                mock.patch.dict(server.MODEL_REGISTRY, {server.BBOX_MODEL_KEY: manifest}),
                mock.patch.object(server, "default_app_model_dir", return_value=str(destination)),
                mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}),
                mock.patch.dict(os.environ, {"PONEGLYPH_BBOX_MODEL_DIR": ""}, clear=False),
            ):
                server.download_model(server.BBOX_MODEL_KEY)

            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["repo_id"], manifest["repo_id"])
            self.assertEqual(calls[0]["revision"], manifest["revision"])
            self.assertEqual(set(calls[0]["allow_patterns"]), set(contents))
            self.assertFalse((destination / "old.txt").exists())
            self.assertTrue((destination / server.MODEL_INSTALL_METADATA_FILENAME).is_file())
            server.verify_snapshot_against_manifest(destination, manifest)

    def test_failed_staging_keeps_previous_installation(self):
        contents = runtime_contents()
        manifest = manifest_for(contents, revision="c" * 40)

        def fake_snapshot_download(**kwargs):
            corrupted = dict(contents)
            corrupted["config.json"] = b"x" * len(contents["config.json"])
            write_contents(Path(kwargs["local_dir"]), corrupted)
            return kwargs["local_dir"]

        fake_hub = types.SimpleNamespace(snapshot_download=fake_snapshot_download)
        with tempfile.TemporaryDirectory() as tmp_dir:
            destination = Path(tmp_dir, "model")
            destination.mkdir()
            (destination / "old.txt").write_text("preserved", encoding="utf-8")
            with (
                mock.patch.dict(server.MODEL_REGISTRY, {server.BBOX_MODEL_KEY: manifest}),
                mock.patch.object(server, "default_app_model_dir", return_value=str(destination)),
                mock.patch.dict(sys.modules, {"huggingface_hub": fake_hub}),
                mock.patch.dict(os.environ, {"PONEGLYPH_BBOX_MODEL_DIR": ""}, clear=False),
            ):
                with self.assertRaisesRegex(server.ModelIntegrityError, "SHA256 invalide"):
                    server.download_model(server.BBOX_MODEL_KEY)

            self.assertEqual((destination / "old.txt").read_text(encoding="utf-8"), "preserved")
            self.assertEqual(list(Path(tmp_dir).glob(".model.staging-*")), [])

    def test_promotion_rolls_back_when_activation_rename_fails(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir)
            destination = root / "model"
            staging = root / ".model.staging-test"
            destination.mkdir()
            staging.mkdir()
            (destination / "old.txt").write_text("preserved", encoding="utf-8")
            (staging / "new.txt").write_text("new", encoding="utf-8")
            real_replace = os.replace

            def fail_staging_activation(source, target):
                if Path(source) == staging:
                    raise OSError("simulated activation failure")
                return real_replace(source, target)

            with mock.patch.object(server.os, "replace", side_effect=fail_staging_activation):
                with self.assertRaisesRegex(OSError, "simulated activation failure"):
                    server.promote_staged_model(staging, destination)

            self.assertEqual(
                (destination / "old.txt").read_text(encoding="utf-8"),
                "preserved",
            )
            self.assertTrue(staging.is_dir())

    def test_orphaned_valid_backup_is_recovered(self):
        contents = runtime_contents()
        manifest = manifest_for(contents, revision="e" * 40)
        with tempfile.TemporaryDirectory() as tmp_dir:
            destination = Path(tmp_dir, "model")
            backup = Path(tmp_dir, ".model.backup-123")
            write_contents(backup, contents)
            with (
                mock.patch.dict(server.MODEL_REGISTRY, {server.BBOX_MODEL_KEY: manifest}),
                mock.patch.object(server, "default_app_model_dir", return_value=str(destination)),
                mock.patch.dict(os.environ, {"PONEGLYPH_BBOX_MODEL_DIR": ""}, clear=False),
                mock.patch.object(
                    server,
                    "get_torch",
                    side_effect=RuntimeError("stop after recovery"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "stop after recovery"):
                    server.load_model(server.BBOX_MODEL_KEY)

            self.assertTrue(destination.is_dir())
            self.assertFalse(backup.exists())

    def test_non_default_model_dir_requires_explicit_unsafe_flag(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            override = str(Path(tmp_dir, "custom"))
            with mock.patch.dict(
                os.environ,
                {
                    "PONEGLYPH_BBOX_MODEL_DIR": override,
                    server.UNSAFE_MODEL_DIR_OVERRIDE_ENV: "0",
                },
                clear=False,
            ):
                with self.assertRaisesRegex(RuntimeError, server.UNSAFE_MODEL_DIR_OVERRIDE_ENV):
                    server.get_model_dir(server.BBOX_MODEL_KEY)

            with mock.patch.dict(
                os.environ,
                {
                    "PONEGLYPH_BBOX_MODEL_DIR": override,
                    server.UNSAFE_MODEL_DIR_OVERRIDE_ENV: "1",
                },
                clear=False,
            ):
                self.assertEqual(server.get_model_dir(server.BBOX_MODEL_KEY), override)
                self.assertTrue(server.model_uses_unsafe_dir_override(server.BBOX_MODEL_KEY))
                with self.assertRaisesRegex(RuntimeError, "telechargement Hub est desactive"):
                    server.download_model(server.BBOX_MODEL_KEY)

    def test_rejected_override_returns_degraded_endpoint_payloads(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            override = str(Path(tmp_dir, "custom"))
            with mock.patch.dict(
                os.environ,
                {
                    "PONEGLYPH_BBOX_MODEL_DIR": override,
                    server.UNSAFE_MODEL_DIR_OVERRIDE_ENV: "0",
                },
                clear=False,
            ):
                status = server.model_status(server.BBOX_MODEL_KEY)
                self.assertFalse(status["installed"])
                self.assertEqual(status["model_dir"], "")
                self.assertIn(server.UNSAFE_MODEL_DIR_OVERRIDE_ENV, status["error"])
                self.assertEqual(server.model_load(server.BBOX_MODEL_KEY).status_code, 500)
                self.assertEqual(server.model_download(server.BBOX_MODEL_KEY).status_code, 500)
                health = server.health()
                self.assertIn(server.BBOX_MODEL_KEY, health["models"])
                self.assertFalse(health["models"][server.BBOX_MODEL_KEY]["installed"])

    def test_load_rejects_same_size_corruption_before_transformers(self):
        contents = runtime_contents()
        manifest = manifest_for(contents, revision="d" * 40)
        with tempfile.TemporaryDirectory() as tmp_dir:
            destination = Path(tmp_dir, "model")
            write_contents(destination, contents)
            original = contents["config.json"]
            (destination / "config.json").write_bytes(b"x" * len(original))
            with (
                mock.patch.dict(server.MODEL_REGISTRY, {server.BBOX_MODEL_KEY: manifest}),
                mock.patch.object(server, "default_app_model_dir", return_value=str(destination)),
                mock.patch.dict(os.environ, {"PONEGLYPH_BBOX_MODEL_DIR": ""}, clear=False),
                mock.patch.object(server, "get_torch") as get_torch,
            ):
                with self.assertRaisesRegex(RuntimeError, "controle d'integrite"):
                    server.load_model(server.BBOX_MODEL_KEY)
                get_torch.assert_not_called()
                status = server.model_status_payload(server.BBOX_MODEL_KEY)
                self.assertFalse(status["installed"])
                self.assertIn("SHA256 invalide", status["integrity_error"])

    def test_flash_attention_kernel_is_pinned_and_offline_only(self):
        install_calls = []
        sentinel = object()

        def install_kernel(repo_id, revision, **kwargs):
            install_calls.append((repo_id, revision, kwargs))
            return "flash_attn_2_cuda", Path("cached-variant")

        fake_kernels = types.SimpleNamespace(
            install_kernel=install_kernel,
            get_local_kernel=lambda path, package: sentinel,
        )
        with mock.patch.dict(sys.modules, {"kernels": fake_kernels}):
            self.assertIs(
                pinned_dependencies.load_pinned_flash_attention_kernel(),
                sentinel,
            )

        self.assertEqual(
            install_calls,
            [
                (
                    pinned_dependencies.FLASH_ATTN_KERNEL_REPO_ID,
                    pinned_dependencies.FLASH_ATTN_KERNEL_REVISION,
                    {"local_files_only": True},
                )
            ],
        )
        self.assertRegex(pinned_dependencies.FLASH_ATTN_KERNEL_REVISION, r"^[0-9a-f]{40}$")
        self.assertEqual(
            server.transformer_attention_attempts("cuda"),
            [
                ("sdpa", {"attn_implementation": "sdpa"}),
                ("default", {}),
            ],
        )

    def test_release_bundle_includes_registry(self):
        build_script = ROOT.parent / "build_desktop.ps1"
        source = build_script.read_text(encoding="utf-8")
        self.assertIn('"--add-data", "model_registry.json;."', source)

    def test_build_cleanup_removes_only_backend_python_bytecode(self):
        powershell = shutil.which("powershell") or shutil.which("pwsh")
        if powershell is None:
            self.skipTest("PowerShell is required to exercise build_desktop.ps1")

        build_script = ROOT.parent / "build_desktop.ps1"
        script = r"""
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:PONEGLYPH_TEST_BUILD_SCRIPT,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    $parseErrors | ForEach-Object { Write-Error $_ }
    exit 10
}
foreach ($functionName in @('Remove-GeneratedBackendPath', 'Remove-GeneratedPythonBytecode')) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) {
        Write-Error "Missing function: $functionName"
        exit 11
    }
    Invoke-Expression $functionAst.Extent.Text
}
Remove-GeneratedPythonBytecode -BackendRoot $env:PONEGLYPH_TEST_BACKEND_ROOT
try {
    Remove-GeneratedBackendPath `
        -TargetPath $env:PONEGLYPH_TEST_OUTSIDE_FILE `
        -BackendRoot $env:PONEGLYPH_TEST_BACKEND_ROOT
    exit 12
} catch {
    if (-not $_.Exception.Message.StartsWith('Refusing to remove generated path')) { throw }
}
exit 0
"""
        with tempfile.TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir, "desktop_backend")
            cache_dir = root / "nested" / "__pycache__"
            outside_dir = Path(tmp_dir, "desktop_backend-outside")
            cache_dir.mkdir(parents=True)
            outside_dir.mkdir()
            (cache_dir / "module.pyc").write_bytes(b"bytecode")
            (cache_dir / "note.txt").write_text("remove cache dir", encoding="utf-8")
            loose_bytecode = root / "loose.pyc"
            loose_bytecode.write_bytes(b"bytecode")
            keep_file = root / "keep.py"
            keep_file.write_text("print('keep')", encoding="utf-8")
            outside_file = outside_dir / "outside.pyc"
            outside_file.write_bytes(b"outside")
            env = dict(os.environ)
            env.update(
                {
                    "PONEGLYPH_TEST_BUILD_SCRIPT": str(build_script),
                    "PONEGLYPH_TEST_BACKEND_ROOT": str(root),
                    "PONEGLYPH_TEST_OUTSIDE_FILE": str(outside_file),
                }
            )
            completed = subprocess.run(
                [powershell, "-NoProfile", "-Command", script],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                completed.returncode,
                0,
                msg=f"PowerShell stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
            )

            self.assertFalse(cache_dir.exists())
            self.assertFalse(loose_bytecode.exists())
            self.assertTrue(keep_file.is_file())
            self.assertTrue(outside_file.is_file())


if __name__ == "__main__":
    unittest.main()
