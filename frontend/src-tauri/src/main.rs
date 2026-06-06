#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::StatusCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    env, fs,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager, State, Url};
use tokio::time::sleep;

const BBOX_MODEL_DIR_NAME: &str = "lighton-ocr-poneglyph-bbox";
const TEXT_MODEL_DIR_NAME: &str = "lighton-ocr-poneglyph";
const SURYA_MODEL_DIR_NAME: &str = "surya-bubble-ocr-poneglyph";
const SURYA_BBOX_MODEL_DIR_NAME: &str = "surya-ocr-2-poneglyph-bbox";
const BBOX_MODEL_KEY: &str = "bbox";
const TEXT_MODEL_KEY: &str = "base";
const SURYA_MODEL_KEY: &str = "surya";
const SURYA_BBOX_MODEL_KEY: &str = "surya_bbox";
const FRONTEND_PRODUCTION_ORIGIN: &str = "https://poneglyph.fr";
const FRONTEND_LOCAL_ORIGIN: &str = "http://localhost:3000";
const FRONTEND_LOCAL_API_HEALTH_URL: &str = "http://localhost:3001/";

#[derive(Clone)]
struct LocalBackendState {
    inner: Arc<LocalBackendInner>,
}

struct LocalBackendInner {
    client: reqwest::Client,
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    startup_error: Mutex<Option<String>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl Default for LocalBackendState {
    fn default() -> Self {
        Self {
            inner: Arc::new(LocalBackendInner {
                client: reqwest::Client::builder()
                    .timeout(Duration::from_secs(600))
                    .build()
                    .unwrap_or_else(|_| reqwest::Client::new()),
                child: Mutex::new(None),
                port: Mutex::new(None),
                startup_error: Mutex::new(None),
                start_lock: tokio::sync::Mutex::new(()),
            }),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct DownloadStatus {
    active: bool,
    ok: Option<bool>,
    error: Option<String>,
    total_bytes: Option<u64>,
    downloaded_bytes: Option<u64>,
    started_at: Option<f64>,
    finished_at: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PythonModelStatus {
    installed: bool,
    loaded: bool,
    loading: bool,
    ready: bool,
    model_dir: String,
    device: Option<String>,
    dtype: Option<String>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
    error: Option<String>,
    download: Option<DownloadStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
struct LocalModelStatus {
    installed: bool,
    loaded: bool,
    loading: bool,
    ready: bool,
    model_dir: String,
    error: Option<String>,
    device: Option<String>,
    dtype: Option<String>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
    download: Option<DownloadStatus>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DownloadResponse {
    ok: bool,
    model_dir: String,
    started: Option<bool>,
    download: Option<DownloadStatus>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct HealthcheckResponse {
    ok: bool,
    python_available: bool,
    torch_available: bool,
    cuda_available: Option<bool>,
    mps_available: Option<bool>,
    device: Option<String>,
    torch_version: Option<String>,
    cuda_version: Option<String>,
    gpu_name: Option<String>,
    gpu_memory_total_mb: Option<u64>,
    gpu_memory_allocated_mb: Option<u64>,
    gpu_memory_reserved_mb: Option<u64>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
    perf_options: Option<serde_json::Value>,
    model_loaded: Option<bool>,
    models: Option<serde_json::Value>,
    port: Option<u16>,
    error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Bubble {
    content: String,
    bbox: [i64; 4],
}

#[derive(Debug, Deserialize, Serialize)]
struct PythonOcrResponse {
    bubbles: Vec<Bubble>,
    raw_text: Option<String>,
    elapsed_ms: Option<u64>,
    preprocess_ms: Option<u64>,
    generate_ms: Option<u64>,
    postprocess_ms: Option<u64>,
    device: Option<String>,
    dtype: Option<String>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PythonTextOcrResponse {
    text: String,
    raw_text: Option<String>,
    elapsed_ms: Option<u64>,
    preprocess_ms: Option<u64>,
    generate_ms: Option<u64>,
    postprocess_ms: Option<u64>,
    device: Option<String>,
    dtype: Option<String>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct LocalOcrResponse {
    bubbles: Vec<Bubble>,
    raw_text: Option<String>,
    elapsed_ms: Option<u64>,
    preprocess_ms: Option<u64>,
    generate_ms: Option<u64>,
    postprocess_ms: Option<u64>,
    device: Option<String>,
    dtype: Option<String>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
    backend: &'static str,
}

#[derive(Debug, Serialize)]
struct LocalTextOcrResponse {
    text: String,
    raw_text: Option<String>,
    elapsed_ms: Option<u64>,
    preprocess_ms: Option<u64>,
    generate_ms: Option<u64>,
    postprocess_ms: Option<u64>,
    device: Option<String>,
    dtype: Option<String>,
    requested_backend: Option<String>,
    active_backend: Option<String>,
    backend_fallback_reason: Option<String>,
    backend: &'static str,
}

impl LocalBackendState {
    async fn ensure_started(&self, app_handle: AppHandle) -> Result<u16, String> {
        self.prune_dead_child()?;
        if let Some(port) = self.port()? {
            return Ok(port);
        }

        let _guard = self.inner.start_lock.lock().await;
        self.prune_dead_child()?;
        if let Some(port) = self.port()? {
            return Ok(port);
        }

        let port = reserve_local_port()?;
        let backend_dir = locate_desktop_backend(&app_handle)?;

        let bbox_model_dir = default_bbox_model_dir()?;
        let text_model_dir = default_text_model_dir()?;
        let surya_model_dir = default_surya_model_dir()?;
        let surya_bbox_model_dir = default_surya_bbox_model_dir()?;
        fs::create_dir_all(&bbox_model_dir)
            .map_err(|err| format!("Impossible de creer le dossier modele: {err}"))?;
        fs::create_dir_all(&text_model_dir)
            .map_err(|err| format!("Impossible de creer le dossier modele OCR texte: {err}"))?;
        fs::create_dir_all(&surya_model_dir)
            .map_err(|err| format!("Impossible de creer le dossier modele Surya: {err}"))?;
        fs::create_dir_all(&surya_bbox_model_dir)
            .map_err(|err| format!("Impossible de creer le dossier modele Surya-BBox: {err}"))?;

        let child = spawn_backend(
            &backend_dir,
            port,
            &bbox_model_dir,
            &text_model_dir,
            &surya_model_dir,
            &surya_bbox_model_dir,
        )?;
        {
            let mut child_guard = self
                .inner
                .child
                .lock()
                .map_err(|_| "Etat backend verrouille".to_string())?;
            *child_guard = Some(child);
        }
        {
            let mut port_guard = self
                .inner
                .port
                .lock()
                .map_err(|_| "Etat port verrouille".to_string())?;
            *port_guard = Some(port);
        }

        match self.wait_until_reachable(port).await {
            Ok(()) => {
                eprintln!("[Poneglyph] Backend local demarre sur le port {port}");
                self.set_startup_error(None);
                Ok(port)
            }
            Err(err) => {
                self.shutdown();
                self.set_startup_error(Some(err.clone()));
                Err(err)
            }
        }
    }

    fn set_startup_error(&self, error: Option<String>) {
        if let Ok(mut guard) = self.inner.startup_error.lock() {
            *guard = error;
        }
    }

    fn startup_error(&self) -> Option<String> {
        self.inner
            .startup_error
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn port(&self) -> Result<Option<u16>, String> {
        self.inner
            .port
            .lock()
            .map(|guard| *guard)
            .map_err(|_| "Etat port verrouille".to_string())
    }

    fn clear_backend_state(&self) {
        if let Ok(mut child_guard) = self.inner.child.lock() {
            *child_guard = None;
        }
        if let Ok(mut port_guard) = self.inner.port.lock() {
            *port_guard = None;
        }
    }

    fn prune_dead_child(&self) -> Result<(), String> {
        let should_clear = {
            let mut child_guard = self
                .inner
                .child
                .lock()
                .map_err(|_| "Etat backend verrouille".to_string())?;

            match child_guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        eprintln!("[Poneglyph] Backend local termine: {status}");
                        true
                    }
                    Ok(None) => false,
                    Err(err) => {
                        eprintln!("[Poneglyph] Impossible de verifier le backend local: {err}");
                        true
                    }
                },
                None => self.port()?.is_some(),
            }
        };

        if should_clear {
            self.clear_backend_state();
        }

        Ok(())
    }

    fn base_url(&self, port: u16) -> String {
        format!("http://127.0.0.1:{port}")
    }

    fn request_error(&self, err: reqwest::Error) -> String {
        self.shutdown();
        format!("Backend OCR local perdu, redemarrage au prochain diagnostic: {err}")
    }

    async fn wait_until_reachable(&self, port: u16) -> Result<(), String> {
        let url = format!("{}/health", self.base_url(port));
        for _ in 0..120 {
            if let Ok(response) = self.inner.client.get(&url).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }
            sleep(Duration::from_millis(250)).await;
        }

        Err(
            "Le backend Python local ne repond pas au healthcheck apres 30s. Verifiez que Python et PyTorch sont installes."
                .to_string(),
        )
    }

    async fn get_json<T: DeserializeOwned>(&self, port: u16, path: &str) -> Result<T, String> {
        let response = self
            .inner
            .client
            .get(format!("{}{}", self.base_url(port), path))
            .send()
            .await
            .map_err(|err| self.request_error(err))?;

        read_response_json(response).await
    }

    async fn post_empty_json<T: DeserializeOwned>(
        &self,
        port: u16,
        path: &str,
    ) -> Result<T, String> {
        let response = self
            .inner
            .client
            .post(format!("{}{}", self.base_url(port), path))
            .send()
            .await
            .map_err(|err| self.request_error(err))?;

        read_response_json(response).await
    }

    async fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        port: u16,
        path: &str,
        body: &B,
    ) -> Result<T, String> {
        let response = self
            .inner
            .client
            .post(format!("{}{}", self.base_url(port), path))
            .json(body)
            .send()
            .await
            .map_err(|err| self.request_error(err))?;

        read_response_json(response).await
    }

    fn shutdown(&self) {
        if let Ok(mut child_guard) = self.inner.child.lock() {
            if let Some(mut child) = child_guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut port_guard) = self.inner.port.lock() {
            *port_guard = None;
        }
        eprintln!("[Poneglyph] Backend local arrete.");
    }
}

async fn read_response_json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    let status = response.status();
    let text = response.text().await.map_err(|err| err.to_string())?;

    if !status.is_success() {
        return Err(extract_error_message(status, &text));
    }

    serde_json::from_str(&text).map_err(|err| format!("JSON local invalide: {err}"))
}

fn extract_error_message(status: StatusCode, text: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
            return error.to_string();
        }
        if let Some(detail) = value.get("detail").and_then(|item| item.as_str()) {
            return detail.to_string();
        }
    }

    format!("Backend local HTTP {status}: {text}")
}

fn to_local_model_status(
    status: PythonModelStatus,
    startup_error: Option<String>,
) -> LocalModelStatus {
    LocalModelStatus {
        installed: status.installed,
        loaded: status.loaded,
        loading: status.loading,
        ready: status.ready && status.loaded,
        model_dir: status.model_dir,
        error: status.error.or(startup_error),
        device: status.device,
        dtype: status.dtype,
        requested_backend: status.requested_backend,
        active_backend: status.active_backend,
        backend_fallback_reason: status.backend_fallback_reason,
        download: status.download,
    }
}

fn reserve_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|err| format!("Impossible de reserver un port local: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| err.to_string())
}

fn locate_desktop_backend(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        candidates.push(resource_dir.join("desktop_backend"));
    }

    if let Some(frontend_dir) = manifest_dir.parent() {
        if let Some(repo_root) = frontend_dir.parent() {
            candidates.push(repo_root.join("desktop_backend"));
        }
        candidates.push(frontend_dir.join("desktop_backend"));
    }
    candidates.push(manifest_dir.join("desktop_backend"));

    candidates
        .into_iter()
        .find(|path| {
            path.join("local_ocr_server.py").exists() || path.join("local_ocr_server.exe").exists()
        })
        .ok_or_else(|| "Dossier desktop_backend introuvable.".to_string())
}

fn default_models_base_dir() -> Result<PathBuf, String> {
    let base = if cfg!(target_os = "windows") {
        env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
            env::var_os("USERPROFILE")
                .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
        })
    } else if cfg!(target_os = "macos") {
        env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
        })
    } else {
        env::var_os("XDG_DATA_HOME").map(PathBuf::from).or_else(|| {
            env::var_os("HOME").map(|home| PathBuf::from(home).join(".local").join("share"))
        })
    }
    .ok_or_else(|| "Impossible de determiner le dossier de donnees utilisateur.".to_string())?;

    Ok(base.join("poneglyph").join("models"))
}

fn default_bbox_model_dir() -> Result<PathBuf, String> {
    Ok(default_models_base_dir()?.join(BBOX_MODEL_DIR_NAME))
}

fn default_text_model_dir() -> Result<PathBuf, String> {
    Ok(default_models_base_dir()?.join(TEXT_MODEL_DIR_NAME))
}

fn default_surya_model_dir() -> Result<PathBuf, String> {
    Ok(default_models_base_dir()?.join(SURYA_MODEL_DIR_NAME))
}

fn default_surya_bbox_model_dir() -> Result<PathBuf, String> {
    Ok(default_models_base_dir()?.join(SURYA_BBOX_MODEL_DIR_NAME))
}

fn normalize_local_model_key(model_key: Option<String>) -> Result<&'static str, String> {
    let raw = model_key.as_deref().unwrap_or(BBOX_MODEL_KEY);
    match raw {
        BBOX_MODEL_KEY => Ok(BBOX_MODEL_KEY),
        TEXT_MODEL_KEY => Ok(TEXT_MODEL_KEY),
        SURYA_MODEL_KEY => Ok(SURYA_MODEL_KEY),
        SURYA_BBOX_MODEL_KEY => Ok(SURYA_BBOX_MODEL_KEY),
        _ => Err(format!("Modele local inconnu: {raw}")),
    }
}

fn normalize_bbox_local_model_key(model_key: Option<String>) -> Result<&'static str, String> {
    let model_key = normalize_local_model_key(model_key)?;
    match model_key {
        BBOX_MODEL_KEY | SURYA_BBOX_MODEL_KEY => Ok(model_key),
        _ => Err(format!(
            "Le modele {model_key} ne fournit pas d'OCR bbox full-page."
        )),
    }
}

fn default_model_dir_for_key(model_key: &str) -> Result<PathBuf, String> {
    match model_key {
        BBOX_MODEL_KEY => default_bbox_model_dir(),
        TEXT_MODEL_KEY => default_text_model_dir(),
        SURYA_MODEL_KEY => default_surya_model_dir(),
        SURYA_BBOX_MODEL_KEY => default_surya_bbox_model_dir(),
        _ => Err(format!("Modele local inconnu: {model_key}")),
    }
}

fn model_endpoint(base_path: &str, model_key: &str, default_model_key: &str) -> String {
    if model_key == default_model_key {
        base_path.to_string()
    } else {
        format!("{base_path}?model_key={model_key}")
    }
}

fn env_or_default(name: &str, default_value: &str) -> String {
    env::var(name).unwrap_or_else(|_| default_value.to_string())
}

fn spawn_backend(
    backend_dir: &Path,
    port: u16,
    bbox_model_dir: &Path,
    text_model_dir: &Path,
    surya_model_dir: &Path,
    surya_bbox_model_dir: &Path,
) -> Result<Child, String> {
    let pyinstaller_bundle_exe = backend_dir
        .join("local_ocr_server_bundle")
        .join("local_ocr_server.exe");
    if pyinstaller_bundle_exe.exists() {
        let bundle_dir = pyinstaller_bundle_exe
            .parent()
            .ok_or_else(|| "Dossier backend PyInstaller invalide.".to_string())?;
        eprintln!(
            "[Poneglyph] Utilisation du backend PyInstaller onedir: {}",
            pyinstaller_bundle_exe.display()
        );
        let mut command = Command::new(&pyinstaller_bundle_exe);
        command
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(bundle_dir)
            .env("PONEGLYPH_MODEL_DIR", bbox_model_dir.as_os_str())
            .env("PONEGLYPH_BBOX_MODEL_DIR", bbox_model_dir.as_os_str())
            .env("PONEGLYPH_BASE_MODEL_DIR", text_model_dir.as_os_str())
            .env("PONEGLYPH_SURYA_MODEL_DIR", surya_model_dir.as_os_str())
            .env(
                "PONEGLYPH_SURYA_BBOX_MODEL_DIR",
                surya_bbox_model_dir.as_os_str(),
            )
            .env(
                "PONEGLYPH_FLASH_ATTN",
                env_or_default("PONEGLYPH_FLASH_ATTN", "1"),
            )
            .env("PONEGLYPH_TF32", env_or_default("PONEGLYPH_TF32", "1"))
            .env("PONEGLYPH_WARMUP", env_or_default("PONEGLYPH_WARMUP", "1"))
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        return command
            .spawn()
            .map_err(|err| format!("Impossible de demarrer le backend PyInstaller onedir: {err}"));
    }

    let pyinstaller_exe = backend_dir.join("local_ocr_server.exe");
    if pyinstaller_exe.exists() {
        eprintln!(
            "[Poneglyph] Utilisation du backend PyInstaller: {}",
            pyinstaller_exe.display()
        );
        let mut command = Command::new(&pyinstaller_exe);
        command
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(backend_dir)
            .env("PONEGLYPH_MODEL_DIR", bbox_model_dir.as_os_str())
            .env("PONEGLYPH_BBOX_MODEL_DIR", bbox_model_dir.as_os_str())
            .env("PONEGLYPH_BASE_MODEL_DIR", text_model_dir.as_os_str())
            .env("PONEGLYPH_SURYA_MODEL_DIR", surya_model_dir.as_os_str())
            .env(
                "PONEGLYPH_SURYA_BBOX_MODEL_DIR",
                surya_bbox_model_dir.as_os_str(),
            )
            .env(
                "PONEGLYPH_FLASH_ATTN",
                env_or_default("PONEGLYPH_FLASH_ATTN", "1"),
            )
            .env("PONEGLYPH_TF32", env_or_default("PONEGLYPH_TF32", "1"))
            .env("PONEGLYPH_WARMUP", env_or_default("PONEGLYPH_WARMUP", "1"))
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        return command
            .spawn()
            .map_err(|err| format!("Impossible de demarrer le backend PyInstaller: {err}"));
    }

    let script_path = backend_dir.join("local_ocr_server.py");
    if !script_path.exists() {
        return Err(format!("Backend introuvable: {}", script_path.display()));
    }

    eprintln!("[Poneglyph] Utilisation de l'interpreteur Python pour le backend");
    let env_python = env::var("PONEGLYPH_PYTHON").ok();
    let mut candidates = Vec::new();
    if let Some(python) = env_python {
        candidates.push((python, Vec::<String>::new()));
    }
    candidates.push(("python".to_string(), Vec::new()));
    candidates.push(("python3".to_string(), Vec::new()));
    candidates.push(("py".to_string(), vec!["-3".to_string()]));

    let mut errors = Vec::new();

    for (program, prefix_args) in candidates {
        let mut command = Command::new(&program);
        for arg in prefix_args {
            command.arg(arg);
        }
        command
            .arg(&script_path)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(backend_dir)
            .env("PONEGLYPH_MODEL_DIR", bbox_model_dir.as_os_str())
            .env("PONEGLYPH_BBOX_MODEL_DIR", bbox_model_dir.as_os_str())
            .env("PONEGLYPH_BASE_MODEL_DIR", text_model_dir.as_os_str())
            .env("PONEGLYPH_SURYA_MODEL_DIR", surya_model_dir.as_os_str())
            .env(
                "PONEGLYPH_SURYA_BBOX_MODEL_DIR",
                surya_bbox_model_dir.as_os_str(),
            )
            .env(
                "PONEGLYPH_FLASH_ATTN",
                env_or_default("PONEGLYPH_FLASH_ATTN", "1"),
            )
            .env("PONEGLYPH_TF32", env_or_default("PONEGLYPH_TF32", "1"))
            .env("PONEGLYPH_WARMUP", env_or_default("PONEGLYPH_WARMUP", "1"))
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        match command.spawn() {
            Ok(child) => {
                eprintln!("[Poneglyph] Backend Python demarre avec: {program}");
                return Ok(child);
            }
            Err(err) => errors.push(format!("{program}: {err}")),
        }
    }

    Err(format!(
        "Impossible de demarrer Python. Installez Python + PyTorch ou definissez PONEGLYPH_PYTHON. Erreurs: {}",
        errors.join(" | ")
    ))
}

#[tauri::command(rename_all = "snake_case")]
async fn get_local_model_status(
    model_key: Option<String>,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let model_key = normalize_local_model_key(model_key)?;
    let model_dir = default_model_dir_for_key(model_key)?
        .to_string_lossy()
        .to_string();

    let port = match state.ensure_started(app_handle).await {
        Ok(port) => port,
        Err(err) => {
            return Ok(LocalModelStatus {
                installed: Path::new(&model_dir).join("config.json").exists(),
                loaded: false,
                loading: false,
                ready: false,
                model_dir,
                error: Some(err),
                device: None,
                dtype: None,
                requested_backend: None,
                active_backend: None,
                backend_fallback_reason: None,
                download: None,
            });
        }
    };

    let endpoint = model_endpoint("/model/status", model_key, BBOX_MODEL_KEY);
    let status: PythonModelStatus = state.get_json(port, &endpoint).await?;
    Ok(to_local_model_status(status, state.startup_error()))
}

#[tauri::command]
async fn get_local_text_model_status(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let model_dir = default_text_model_dir()?.to_string_lossy().to_string();

    let port = match state.ensure_started(app_handle).await {
        Ok(port) => port,
        Err(err) => {
            return Ok(LocalModelStatus {
                installed: Path::new(&model_dir).join("config.json").exists(),
                loaded: false,
                loading: false,
                ready: false,
                model_dir,
                error: Some(err),
                device: None,
                dtype: None,
                requested_backend: None,
                active_backend: None,
                backend_fallback_reason: None,
                download: None,
            });
        }
    };

    let status: PythonModelStatus = state.get_json(port, "/model/status?model_key=base").await?;
    Ok(to_local_model_status(status, state.startup_error()))
}

#[tauri::command]
async fn get_local_surya_model_status(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let model_dir = default_surya_model_dir()?.to_string_lossy().to_string();

    let port = match state.ensure_started(app_handle).await {
        Ok(port) => port,
        Err(err) => {
            return Ok(LocalModelStatus {
                installed: Path::new(&model_dir).join("config.json").exists(),
                loaded: false,
                loading: false,
                ready: false,
                model_dir,
                error: Some(err),
                device: None,
                dtype: None,
                requested_backend: None,
                active_backend: None,
                backend_fallback_reason: None,
                download: None,
            });
        }
    };

    let status: PythonModelStatus = state
        .get_json(port, "/model/status?model_key=surya")
        .await?;
    Ok(to_local_model_status(status, state.startup_error()))
}

#[tauri::command]
async fn get_local_surya_bbox_model_status(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let model_dir = default_surya_bbox_model_dir()?
        .to_string_lossy()
        .to_string();

    let port = match state.ensure_started(app_handle).await {
        Ok(port) => port,
        Err(err) => {
            return Ok(LocalModelStatus {
                installed: Path::new(&model_dir).join("config.json").exists(),
                loaded: false,
                loading: false,
                ready: false,
                model_dir,
                error: Some(err),
                device: None,
                dtype: None,
                requested_backend: None,
                active_backend: None,
                backend_fallback_reason: None,
                download: None,
            });
        }
    };

    let status: PythonModelStatus = state
        .get_json(port, "/model/status?model_key=surya_bbox")
        .await?;
    Ok(to_local_model_status(status, state.startup_error()))
}

#[tauri::command(rename_all = "snake_case")]
async fn load_local_model(
    model_key: Option<String>,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let model_key = normalize_local_model_key(model_key)?;
    let model_dir = default_model_dir_for_key(model_key)?;
    let endpoint = model_endpoint("/model/load", model_key, BBOX_MODEL_KEY);
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<PythonModelStatus>(port, &endpoint)
        .await
    {
        Ok(status) => Ok(to_local_model_status(status, state.startup_error())),
        Err(error) => Ok(LocalModelStatus {
            installed: model_dir.join("config.json").exists(),
            loaded: false,
            loading: false,
            ready: false,
            model_dir: model_dir.to_string_lossy().to_string(),
            error: Some(error),
            device: None,
            dtype: None,
            requested_backend: None,
            active_backend: None,
            backend_fallback_reason: None,
            download: None,
        }),
    }
}

#[tauri::command]
async fn load_local_text_model(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<PythonModelStatus>(port, "/model/load?model_key=base")
        .await
    {
        Ok(status) => Ok(to_local_model_status(status, state.startup_error())),
        Err(error) => Ok(LocalModelStatus {
            installed: default_text_model_dir()?.join("config.json").exists(),
            loaded: false,
            loading: false,
            ready: false,
            model_dir: default_text_model_dir()?.to_string_lossy().to_string(),
            error: Some(error),
            device: None,
            dtype: None,
            requested_backend: None,
            active_backend: None,
            backend_fallback_reason: None,
            download: None,
        }),
    }
}

#[tauri::command]
async fn load_local_surya_model(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<PythonModelStatus>(port, "/model/load?model_key=surya")
        .await
    {
        Ok(status) => Ok(to_local_model_status(status, state.startup_error())),
        Err(error) => Ok(LocalModelStatus {
            installed: default_surya_model_dir()?.join("config.json").exists(),
            loaded: false,
            loading: false,
            ready: false,
            model_dir: default_surya_model_dir()?.to_string_lossy().to_string(),
            error: Some(error),
            device: None,
            dtype: None,
            requested_backend: None,
            active_backend: None,
            backend_fallback_reason: None,
            download: None,
        }),
    }
}

#[tauri::command]
async fn load_local_surya_bbox_model(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalModelStatus, String> {
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<PythonModelStatus>(port, "/model/load?model_key=surya_bbox")
        .await
    {
        Ok(status) => Ok(to_local_model_status(status, state.startup_error())),
        Err(error) => Ok(LocalModelStatus {
            installed: default_surya_bbox_model_dir()?.join("config.json").exists(),
            loaded: false,
            loading: false,
            ready: false,
            model_dir: default_surya_bbox_model_dir()?
                .to_string_lossy()
                .to_string(),
            error: Some(error),
            device: None,
            dtype: None,
            requested_backend: None,
            active_backend: None,
            backend_fallback_reason: None,
            download: None,
        }),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn download_local_model(
    model_key: Option<String>,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<DownloadResponse, String> {
    let model_key = normalize_local_model_key(model_key)?;
    let model_dir = default_model_dir_for_key(model_key)?;
    let endpoint = model_endpoint("/model/download", model_key, BBOX_MODEL_KEY);
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<DownloadResponse>(port, &endpoint)
        .await
    {
        Ok(response) => Ok(response),
        Err(error) => Ok(DownloadResponse {
            ok: false,
            model_dir: model_dir.to_string_lossy().to_string(),
            started: None,
            download: None,
            error: Some(error),
        }),
    }
}

#[tauri::command]
async fn download_local_text_model(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<DownloadResponse, String> {
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<DownloadResponse>(port, "/model/download?model_key=base")
        .await
    {
        Ok(response) => Ok(response),
        Err(error) => Ok(DownloadResponse {
            ok: false,
            model_dir: default_text_model_dir()?.to_string_lossy().to_string(),
            started: None,
            download: None,
            error: Some(error),
        }),
    }
}

#[tauri::command]
async fn download_local_surya_model(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<DownloadResponse, String> {
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<DownloadResponse>(port, "/model/download?model_key=surya")
        .await
    {
        Ok(response) => Ok(response),
        Err(error) => Ok(DownloadResponse {
            ok: false,
            model_dir: default_surya_model_dir()?.to_string_lossy().to_string(),
            started: None,
            download: None,
            error: Some(error),
        }),
    }
}

#[tauri::command]
async fn download_local_surya_bbox_model(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<DownloadResponse, String> {
    let port = state.ensure_started(app_handle).await?;
    match state
        .post_empty_json::<DownloadResponse>(port, "/model/download?model_key=surya_bbox")
        .await
    {
        Ok(response) => Ok(response),
        Err(error) => Ok(DownloadResponse {
            ok: false,
            model_dir: default_surya_bbox_model_dir()?
                .to_string_lossy()
                .to_string(),
            started: None,
            download: None,
            error: Some(error),
        }),
    }
}

#[tauri::command(rename_all = "snake_case")]
async fn run_local_ocr(
    image_bytes_base64: String,
    model_key: Option<String>,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalOcrResponse, String> {
    #[derive(Serialize)]
    struct RequestBody<'a> {
        image_bytes_base64: &'a str,
    }

    let model_key = normalize_bbox_local_model_key(model_key)?;
    let endpoint = model_endpoint("/ocr", model_key, BBOX_MODEL_KEY);
    let port = state.ensure_started(app_handle).await?;
    let response: PythonOcrResponse = state
        .post_json(
            port,
            &endpoint,
            &RequestBody {
                image_bytes_base64: &image_bytes_base64,
            },
        )
        .await?;

    Ok(LocalOcrResponse {
        bubbles: response.bubbles,
        raw_text: response.raw_text,
        elapsed_ms: response.elapsed_ms,
        preprocess_ms: response.preprocess_ms,
        generate_ms: response.generate_ms,
        postprocess_ms: response.postprocess_ms,
        device: response.device,
        dtype: response.dtype,
        requested_backend: response.requested_backend,
        active_backend: response.active_backend,
        backend_fallback_reason: response.backend_fallback_reason,
        backend: "local-python",
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn run_local_text_ocr(
    image_bytes_base64: String,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalTextOcrResponse, String> {
    #[derive(Serialize)]
    struct RequestBody<'a> {
        image_bytes_base64: &'a str,
    }

    let port = state.ensure_started(app_handle).await?;
    let response: PythonTextOcrResponse = state
        .post_json(
            port,
            "/ocr/text",
            &RequestBody {
                image_bytes_base64: &image_bytes_base64,
            },
        )
        .await?;

    Ok(LocalTextOcrResponse {
        text: response.text,
        raw_text: response.raw_text,
        elapsed_ms: response.elapsed_ms,
        preprocess_ms: response.preprocess_ms,
        generate_ms: response.generate_ms,
        postprocess_ms: response.postprocess_ms,
        device: response.device,
        dtype: response.dtype,
        requested_backend: response.requested_backend,
        active_backend: response.active_backend,
        backend_fallback_reason: response.backend_fallback_reason,
        backend: "local-python",
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn run_local_surya_ocr(
    image_bytes_base64: String,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalTextOcrResponse, String> {
    #[derive(Serialize)]
    struct RequestBody<'a> {
        image_bytes_base64: &'a str,
    }

    let port = state.ensure_started(app_handle).await?;
    let response: PythonTextOcrResponse = state
        .post_json(
            port,
            "/ocr/text?model_key=surya",
            &RequestBody {
                image_bytes_base64: &image_bytes_base64,
            },
        )
        .await?;

    Ok(LocalTextOcrResponse {
        text: response.text,
        raw_text: response.raw_text,
        elapsed_ms: response.elapsed_ms,
        preprocess_ms: response.preprocess_ms,
        generate_ms: response.generate_ms,
        postprocess_ms: response.postprocess_ms,
        device: response.device,
        dtype: response.dtype,
        requested_backend: response.requested_backend,
        active_backend: response.active_backend,
        backend_fallback_reason: response.backend_fallback_reason,
        backend: "local-python",
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn run_local_surya_bbox_ocr(
    image_bytes_base64: String,
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<LocalOcrResponse, String> {
    #[derive(Serialize)]
    struct RequestBody<'a> {
        image_bytes_base64: &'a str,
    }

    let port = state.ensure_started(app_handle).await?;
    let response: PythonOcrResponse = state
        .post_json(
            port,
            "/ocr?model_key=surya_bbox",
            &RequestBody {
                image_bytes_base64: &image_bytes_base64,
            },
        )
        .await?;

    Ok(LocalOcrResponse {
        bubbles: response.bubbles,
        raw_text: response.raw_text,
        elapsed_ms: response.elapsed_ms,
        preprocess_ms: response.preprocess_ms,
        generate_ms: response.generate_ms,
        postprocess_ms: response.postprocess_ms,
        device: response.device,
        dtype: response.dtype,
        requested_backend: response.requested_backend,
        active_backend: response.active_backend,
        backend_fallback_reason: response.backend_fallback_reason,
        backend: "local-python",
    })
}

#[tauri::command]
async fn healthcheck_local_backend(
    state: State<'_, LocalBackendState>,
    app_handle: AppHandle,
) -> Result<HealthcheckResponse, String> {
    let port = match state.ensure_started(app_handle).await {
        Ok(port) => port,
        Err(err) => {
            return Ok(HealthcheckResponse {
                ok: false,
                python_available: false,
                torch_available: false,
                cuda_available: None,
                mps_available: None,
                device: None,
                torch_version: None,
                cuda_version: None,
                gpu_name: None,
                gpu_memory_total_mb: None,
                gpu_memory_allocated_mb: None,
                gpu_memory_reserved_mb: None,
                requested_backend: None,
                active_backend: None,
                backend_fallback_reason: None,
                perf_options: None,
                model_loaded: None,
                models: None,
                port: None,
                error: Some(err),
            });
        }
    };

    let mut health: HealthcheckResponse = state.get_json(port, "/health").await?;
    health.port = Some(port);
    Ok(health)
}

fn normalize_frontend_path(path: Option<String>) -> Result<String, String> {
    let raw_path = path.unwrap_or_else(|| "/".to_string());
    let trimmed = raw_path.trim();
    if trimmed.contains("://") || trimmed.starts_with("//") || trimmed.contains('\\') {
        return Err("Chemin de navigation invalide.".to_string());
    }

    if trimmed.is_empty() {
        return Ok("/".to_string());
    }

    if trimmed.starts_with('/') {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("/{trimmed}"))
    }
}

fn frontend_origin_for_target(target: &str) -> Result<&'static str, String> {
    match target {
        "production" => Ok(FRONTEND_PRODUCTION_ORIGIN),
        "local" => Ok(FRONTEND_LOCAL_ORIGIN),
        _ => Err("Cible frontend inconnue.".to_string()),
    }
}

async fn ensure_frontend_origin_reachable(origin: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client.get(origin).send().await.map_err(|err| {
        if origin == FRONTEND_LOCAL_ORIGIN {
            format!("localhost:3000 ne repond pas. Lancez d'abord npm run dev.")
        } else {
            format!("Impossible de joindre poneglyph.fr: {err}")
        }
    })?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!("Frontend HTTP {}", response.status()))
    }
}

async fn ensure_local_frontend_stack_reachable() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|err| err.to_string())?;

    let response = client
        .get(FRONTEND_LOCAL_API_HEALTH_URL)
        .header("Origin", FRONTEND_LOCAL_ORIGIN)
        .send()
        .await
        .map_err(|_| {
            "localhost:3001/api ne repond pas. Lancez aussi le backend: cd backend && npm run dev."
                .to_string()
        })?;

    if !response.status().is_success() {
        return Err(format!("API locale HTTP {}", response.status()));
    }

    let cors_origin = response
        .headers()
        .get("access-control-allow-origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if cors_origin == FRONTEND_LOCAL_ORIGIN || cors_origin == "*" {
        Ok(())
    } else {
        Err(
            "L'API locale ne permet pas localhost:3000. Lancez-la en dev ou ajoutez http://localhost:3000 a ALLOWED_ORIGINS."
                .to_string(),
        )
    }
}

#[tauri::command]
async fn switch_frontend_origin(
    target: String,
    path: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let origin = frontend_origin_for_target(&target)?;
    ensure_frontend_origin_reachable(origin).await?;
    if target == "local" {
        ensure_local_frontend_stack_reachable().await?;
    }

    let target_path = normalize_frontend_path(path)?;
    let target_url = Url::parse(&format!("{origin}{target_path}"))
        .map_err(|err| format!("URL frontend invalide: {err}"))?;
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Fenetre principale introuvable.".to_string())?;
    window
        .navigate(target_url)
        .map_err(|err| format!("Navigation frontend impossible: {err}"))
}

#[tauri::command]
async fn get_app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(LocalBackendState::default())
        .setup(|app| {
            let state = app.state::<LocalBackendState>().inner().clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = state.ensure_started(handle).await {
                    eprintln!("[Poneglyph] Avertissement: {err}");
                    state.set_startup_error(Some(err));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_local_model_status,
            get_local_text_model_status,
            get_local_surya_model_status,
            get_local_surya_bbox_model_status,
            load_local_model,
            load_local_text_model,
            load_local_surya_model,
            load_local_surya_bbox_model,
            download_local_model,
            download_local_text_model,
            download_local_surya_model,
            download_local_surya_bbox_model,
            run_local_ocr,
            run_local_text_ocr,
            run_local_surya_ocr,
            run_local_surya_bbox_ocr,
            healthcheck_local_backend,
            switch_frontend_origin,
            get_app_version
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<LocalBackendState>().shutdown();
        }
    });
}
