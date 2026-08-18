#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::StatusCode;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    env, fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
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
const MAX_OCR_IMAGE_BASE64_BYTES: usize = 28 * 1024 * 1024;
const CHATGPT_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CHATGPT_CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_OCR_MODEL: &str = "gpt-5.6-luna";
const CHATGPT_OCR_PROMPT: &str = r#"Tu es un moteur OCR de page/crop de manga. Extrais uniquement les textes visibles dans les bulles, cartouches ou onomatopees lisibles, avec leur bbox. Renvoie un JSON strict: { "bubbles": [ { "content": "texte exact", "bbox": [x1, y1, x2, y2] } ] } Regles: - Coordonnees normalisees entre 0 et 1000 dans le repere de l'image fournie. - Ordre de lecture japonais: haut droite vers bas gauche. - Garde le francais, ne traduis pas. - Corrige seulement les erreurs OCR evidentes de ponctuation/casse. - Les bbox doivent entourer parfaitement le texte dans les bulles, pas les bulles directement - Ignore les bulles vides ou illisibles. - N'ajoute aucun texte hors JSON. - Rétablis la casse naturelle (ALLEZ-Y ! -> Allez-y !)."#;

#[derive(Clone)]
struct ChatGptState {
    client: reqwest::Client,
    session: Arc<Mutex<Option<ChatGptSession>>>,
}

#[derive(Clone)]
struct ChatGptSession {
    access_token: String,
    refresh_token: Option<String>,
    account_id: String,
    email: Option<String>,
    expires_at: Instant,
}

impl Default for ChatGptState {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            session: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ChatGptTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ChatGptAuthStatus {
    connected: bool,
    email: Option<String>,
    account_id: Option<String>,
    model: &'static str,
}

#[derive(Debug, Serialize)]
struct ChatGptOcrResponse {
    bubbles: Vec<Bubble>,
    elapsed_ms: u64,
    model: &'static str,
}

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
    integrity_error: Option<String>,
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
    integrity_error: Option<String>,
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

fn url_encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn url_decode_component(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                    .map_err(|_| "Callback OAuth invalide.".to_string())?;
                decoded.push(
                    u8::from_str_radix(hex, 16)
                        .map_err(|_| "Callback OAuth invalide.".to_string())?,
                );
                index += 3;
            }
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(decoded).map_err(|_| "Callback OAuth invalide.".to_string())
}

fn query_parameter(path: &str, name: &str) -> Result<Option<String>, String> {
    let query = path
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == name {
            return url_decode_component(value).map(Some);
        }
    }
    Ok(None)
}

fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Impossible d'ouvrir le navigateur: {err}"))
}

fn wait_for_oauth_callback(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("Impossible de preparer le callback OAuth: {err}"))?;
    let deadline = Instant::now() + Duration::from_secs(180);

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut request = [0_u8; 16 * 1024];
                let size = stream.read(&mut request).unwrap_or(0);
                let first_line = String::from_utf8_lossy(&request[..size])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let path = first_line.split_whitespace().nth(1).unwrap_or_default();
                let returned_state = query_parameter(path, "state")?;
                let code = query_parameter(path, "code")?;
                let error = query_parameter(path, "error")?;
                let valid = returned_state.as_deref() == Some(expected_state) && code.is_some();
                let body = if valid {
                    "<!doctype html><meta charset=utf-8><title>Poneglyph</title><h1>Connexion terminee</h1><p>Vous pouvez fermer cette fenetre et revenir dans Poneglyph.</p>"
                } else {
                    "<!doctype html><meta charset=utf-8><title>Poneglyph</title><h1>Connexion refusee</h1><p>Revenez dans Poneglyph et recommencez.</p>"
                };
                let status = if valid { "200 OK" } else { "400 Bad Request" };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                if let Some(error) = error {
                    return Err(format!("Connexion ChatGPT refusee: {error}"));
                }
                if returned_state.as_deref() != Some(expected_state) {
                    return Err("Etat OAuth ChatGPT invalide.".to_string());
                }
                return code.ok_or_else(|| "Code OAuth ChatGPT manquant.".to_string());
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("Connexion ChatGPT expiree. Reessayez.".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(format!("Erreur du callback OAuth: {err}")),
        }
    }
}

fn decode_base64_url(value: &str) -> Result<Vec<u8>, String> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }

    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut accumulator = 0_u32;
    let mut bits = 0_u8;
    for byte in value.bytes().filter(|byte| *byte != b'=') {
        let value = sextet(byte).ok_or_else(|| "Jeton ChatGPT invalide.".to_string())? as u32;
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((accumulator >> bits) & 0xff) as u8);
        }
    }
    Ok(output)
}

fn jwt_claims(token: &str) -> Result<serde_json::Value, String> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| "Jeton ChatGPT invalide.".to_string())?;
    serde_json::from_slice(&decode_base64_url(payload)?)
        .map_err(|_| "Jeton ChatGPT invalide.".to_string())
}

fn find_string_claim(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for key in keys {
                if let Some(value) = map.get(*key).and_then(serde_json::Value::as_str) {
                    return Some(value.to_string());
                }
            }
            map.values()
                .find_map(|value| find_string_claim(value, keys))
        }
        serde_json::Value::Array(values) => values
            .iter()
            .find_map(|value| find_string_claim(value, keys)),
        _ => None,
    }
}

fn session_from_token_response(tokens: ChatGptTokenResponse) -> Result<ChatGptSession, String> {
    let access_claims = jwt_claims(&tokens.access_token)?;
    let account_id = find_string_claim(
        &access_claims,
        &[
            "chatgpt_account_id",
            "https://api.openai.com/auth.chatgpt_account_id",
        ],
    )
    .ok_or_else(|| "Compte ChatGPT introuvable dans le jeton.".to_string())?;
    let email = tokens
        .id_token
        .as_deref()
        .and_then(|token| jwt_claims(token).ok())
        .and_then(|claims| find_string_claim(&claims, &["email"]));
    let expires_in = tokens.expires_in.unwrap_or(3600).max(60);
    Ok(ChatGptSession {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        account_id,
        email,
        expires_at: Instant::now() + Duration::from_secs(expires_in),
    })
}

fn auth_status(session: Option<&ChatGptSession>) -> ChatGptAuthStatus {
    ChatGptAuthStatus {
        connected: session.is_some(),
        email: session.and_then(|session| session.email.clone()),
        account_id: session.map(|session| session.account_id.clone()),
        model: CHATGPT_OCR_MODEL,
    }
}

async fn refresh_chatgpt_session(state: &ChatGptState) -> Result<ChatGptSession, String> {
    let current = state
        .session
        .lock()
        .map_err(|_| "Session ChatGPT indisponible.".to_string())?
        .clone()
        .ok_or_else(|| "Connectez-vous a ChatGPT dans la configuration API.".to_string())?;
    if current.expires_at > Instant::now() + Duration::from_secs(60) {
        return Ok(current);
    }
    let refresh_token = current
        .refresh_token
        .as_deref()
        .ok_or_else(|| "Session ChatGPT expiree. Reconnectez-vous.".to_string())?;
    let response = state
        .client
        .post(CHATGPT_TOKEN_URL)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "client_id": CHATGPT_CLIENT_ID,
            "refresh_token": refresh_token,
        }))
        .send()
        .await
        .map_err(|_| "Impossible de renouveler la session ChatGPT.".to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Session ChatGPT expiree ({status}). Reconnectez-vous."
        ));
    }
    let mut tokens: ChatGptTokenResponse = serde_json::from_str(&text)
        .map_err(|_| "Reponse de renouvellement ChatGPT invalide.".to_string())?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = current.refresh_token;
    }
    let session = session_from_token_response(tokens)?;
    let session = ChatGptSession {
        email: session.email.or(current.email),
        ..session
    };
    *state
        .session
        .lock()
        .map_err(|_| "Session ChatGPT indisponible.".to_string())? = Some(session.clone());
    Ok(session)
}

fn extract_response_text(value: &serde_json::Value) -> Option<String> {
    if let Some(text) = value.get("output_text").and_then(serde_json::Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("text").and_then(serde_json::Value::as_str) {
        return Some(text.to_string());
    }
    value
        .get("output")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items.iter().find_map(|item| {
                item.get("content")
                    .and_then(serde_json::Value::as_array)
                    .and_then(|parts| parts.iter().find_map(extract_response_text))
            })
        })
}

fn parse_codex_response(body: &str) -> Result<Vec<Bubble>, String> {
    let mut output_text = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| extract_response_text(&value));

    for line in body.lines() {
        let Some(data) = line.strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(data) else {
            continue;
        };
        if event.get("type").and_then(serde_json::Value::as_str)
            == Some("response.output_text.done")
        {
            output_text = event
                .get("text")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
        if let Some(response) = event.get("response") {
            output_text = extract_response_text(response).or(output_text);
        }
    }

    let text = output_text.ok_or_else(|| "Le modele n'a renvoye aucun texte OCR.".to_string())?;
    let trimmed = text.trim();
    let without_prefix = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    let json_text = without_prefix
        .strip_suffix("```")
        .unwrap_or(without_prefix)
        .trim();
    let value: serde_json::Value = serde_json::from_str(json_text)
        .map_err(|_| "GPT-5.6 Luna a renvoye un JSON OCR invalide.".to_string())?;
    let bubbles: Vec<Bubble> = serde_json::from_value(
        value
            .get("bubbles")
            .cloned()
            .ok_or_else(|| "Le JSON OCR ne contient pas bubbles.".to_string())?,
    )
    .map_err(|_| "Le tableau bubbles est invalide.".to_string())?;
    for bubble in &bubbles {
        let [x1, y1, x2, y2] = bubble.bbox;
        if bubble.content.trim().is_empty()
            || !(0..=1000).contains(&x1)
            || !(0..=1000).contains(&y1)
            || !(0..=1000).contains(&x2)
            || !(0..=1000).contains(&y2)
            || x2 <= x1
            || y2 <= y1
        {
            return Err("GPT-5.6 Luna a renvoye une bulle OCR invalide.".to_string());
        }
    }
    Ok(bubbles)
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
        ensure_model_parent_directories(&[
            bbox_model_dir.as_path(),
            text_model_dir.as_path(),
            surya_model_dir.as_path(),
            surya_bbox_model_dir.as_path(),
        ])?;

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
        // Keep the backend alive across transient HTTP failures. Killing the
        // child here would destroy every loaded model and force a full reload
        // on the next call. If the process actually died, prune_dead_child
        // (called by ensure_started) will detect it and respawn on next use.
        format!("Backend OCR local injoignable sur cette requete (conservé en mémoire): {err}")
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

    decode_response_json(status, &text)
}

fn decode_response_json<T: DeserializeOwned>(status: StatusCode, text: &str) -> Result<T, String> {
    match serde_json::from_str(text) {
        Ok(value) => Ok(value),
        Err(error) if status.is_success() => Err(format!("JSON local invalide: {error}")),
        Err(_) => Err(extract_error_message(status, text)),
    }
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
    let integrity_error = status.integrity_error;
    let error = integrity_error.clone().or(status.error).or(startup_error);
    LocalModelStatus {
        installed: status.installed,
        loaded: status.loaded,
        loading: status.loading,
        ready: status.ready && status.loaded,
        model_dir: status.model_dir,
        error,
        device: status.device,
        dtype: status.dtype,
        requested_backend: status.requested_backend,
        active_backend: status.active_backend,
        backend_fallback_reason: status.backend_fallback_reason,
        download: status.download,
        integrity_error,
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

fn ensure_model_parent_directories(model_dirs: &[&Path]) -> Result<(), String> {
    for model_dir in model_dirs {
        let parent = model_dir.parent().ok_or_else(|| {
            format!(
                "Dossier parent introuvable pour le modele: {}",
                model_dir.display()
            )
        })?;
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Impossible de creer le dossier parent des modeles {}: {err}",
                parent.display()
            )
        })?;
    }
    Ok(())
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
                installed: false,
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
                integrity_error: None,
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
                installed: false,
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
                integrity_error: None,
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
                installed: false,
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
                integrity_error: None,
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
                installed: false,
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
                integrity_error: None,
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
            installed: false,
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
            integrity_error: None,
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
            installed: false,
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
            integrity_error: None,
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
            installed: false,
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
            integrity_error: None,
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
            installed: false,
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
            integrity_error: None,
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

fn validate_ocr_image_payload(image_bytes_base64: &str) -> Result<(), String> {
    if image_bytes_base64.is_empty() {
        return Err("Image OCR vide.".to_string());
    }
    if image_bytes_base64.len() > MAX_OCR_IMAGE_BASE64_BYTES {
        return Err("Image OCR trop volumineuse (20 Mio maximum).".to_string());
    }
    Ok(())
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

    validate_ocr_image_payload(&image_bytes_base64)?;
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

    validate_ocr_image_payload(&image_bytes_base64)?;
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

    validate_ocr_image_payload(&image_bytes_base64)?;
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

    validate_ocr_image_payload(&image_bytes_base64)?;
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
            "localhost:3000 ne repond pas. Lancez d'abord npm run dev.".to_string()
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
        Err("L'API locale ne permet pas localhost:3000. Ajoutez http://localhost:3000 a ALLOWED_ORIGINS."
            .to_string())
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

#[tauri::command(rename_all = "snake_case")]
async fn chatgpt_login(
    code_challenge: String,
    code_verifier: String,
    oauth_state: String,
    state: State<'_, ChatGptState>,
) -> Result<ChatGptAuthStatus, String> {
    let valid_pkce = |value: &str, min: usize, max: usize| {
        (min..=max).contains(&value.len())
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
            })
    };
    if !valid_pkce(&code_verifier, 43, 128)
        || !valid_pkce(&code_challenge, 43, 128)
        || !valid_pkce(&oauth_state, 32, 128)
    {
        return Err("Parametres de connexion ChatGPT invalides.".to_string());
    }

    let listener = TcpListener::bind("127.0.0.1:1455")
        .map_err(|_| "Le port de connexion ChatGPT (1455) est deja utilise.".to_string())?;
    let auth_url = format!(
        "https://auth.openai.com/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&scope=openid%20profile%20email%20offline_access&code_challenge={}&code_challenge_method=S256&state={}&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=poneglyph_desktop",
        url_encode_component(CHATGPT_CLIENT_ID),
        url_encode_component(CHATGPT_REDIRECT_URI),
        url_encode_component(&code_challenge),
        url_encode_component(&oauth_state),
    );
    open_system_browser(&auth_url)?;
    let listener_state = oauth_state.clone();
    let callback = tauri::async_runtime::spawn_blocking(move || {
        wait_for_oauth_callback(listener, &listener_state)
    });
    let code = callback
        .await
        .map_err(|_| "Callback OAuth interrompu.".to_string())??;

    let response = state
        .client
        .post(CHATGPT_TOKEN_URL)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": CHATGPT_CLIENT_ID,
            "code": code,
            "redirect_uri": CHATGPT_REDIRECT_URI,
            "code_verifier": code_verifier,
        }))
        .send()
        .await
        .map_err(|_| "Echange OAuth ChatGPT impossible.".to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Connexion ChatGPT impossible ({status})."));
    }
    let tokens: ChatGptTokenResponse =
        serde_json::from_str(&text).map_err(|_| "Reponse OAuth ChatGPT invalide.".to_string())?;
    let session = session_from_token_response(tokens)?;
    let result = auth_status(Some(&session));
    *state
        .session
        .lock()
        .map_err(|_| "Session ChatGPT indisponible.".to_string())? = Some(session);
    Ok(result)
}

#[tauri::command]
async fn get_chatgpt_auth_status(
    state: State<'_, ChatGptState>,
) -> Result<ChatGptAuthStatus, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "Session ChatGPT indisponible.".to_string())?;
    Ok(auth_status(session.as_ref()))
}

#[tauri::command]
async fn chatgpt_logout(state: State<'_, ChatGptState>) -> Result<ChatGptAuthStatus, String> {
    *state
        .session
        .lock()
        .map_err(|_| "Session ChatGPT indisponible.".to_string())? = None;
    Ok(auth_status(None))
}

fn chatgpt_ocr_request_body(
    image_bytes_base64: &str,
    mime_type: &str,
    fast_mode: bool,
) -> serde_json::Value {
    serde_json::json!({
        "model": CHATGPT_OCR_MODEL,
        "service_tier": if fast_mode { "priority" } else { "default" },
        "reasoning": {
            "effort": "low"
        },
        "input": [{
            "role": "user",
            "content": [
                { "type": "input_text", "text": CHATGPT_OCR_PROMPT },
                { "type": "input_image", "image_url": format!("data:{mime_type};base64,{image_bytes_base64}") }
            ]
        }],
        "stream": true,
        "store": false,
    })
}

#[tauri::command(rename_all = "snake_case")]
async fn run_chatgpt_page_ocr(
    image_bytes_base64: String,
    mime_type: String,
    fast_mode: bool,
    state: State<'_, ChatGptState>,
) -> Result<ChatGptOcrResponse, String> {
    validate_ocr_image_payload(&image_bytes_base64)?;
    if !matches!(
        mime_type.as_str(),
        "image/jpeg" | "image/png" | "image/webp"
    ) {
        return Err("Format d'image OCR non pris en charge.".to_string());
    }
    let session = refresh_chatgpt_session(&state).await?;
    let started = Instant::now();
    let response = state
        .client
        .post(CHATGPT_CODEX_RESPONSES_URL)
        .bearer_auth(&session.access_token)
        .header("ChatGPT-Account-Id", &session.account_id)
        .header("Originator", "codex_cli_rs")
        .header("OpenAI-Beta", "responses=experimental")
        .json(&chatgpt_ocr_request_body(
            &image_bytes_base64,
            &mime_type,
            fast_mode,
        ))
        .send()
        .await
        .map_err(|_| "Appel OCR GPT-5.6 Luna impossible.".to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        if matches!(status.as_u16(), 401 | 403) {
            *state
                .session
                .lock()
                .map_err(|_| "Session ChatGPT indisponible.".to_string())? = None;
            return Err("Session ChatGPT refusee. Reconnectez-vous.".to_string());
        }
        return Err(format!("Le service OCR GPT-5.6 Luna a repondu {status}."));
    }
    Ok(ChatGptOcrResponse {
        bubbles: parse_codex_response(&body)?,
        elapsed_ms: started.elapsed().as_millis() as u64,
        model: CHATGPT_OCR_MODEL,
    })
}

fn main() {
    let app = tauri::Builder::default()
        .manage(LocalBackendState::default())
        .manage(ChatGptState::default())
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
            get_app_version,
            chatgpt_login,
            get_chatgpt_auth_status,
            chatgpt_logout,
            run_chatgpt_page_ocr
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app_handle.state::<LocalBackendState>().shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        chatgpt_ocr_request_body, decode_response_json, ensure_model_parent_directories,
        frontend_origin_for_target, jwt_claims, normalize_frontend_path, parse_codex_response,
        query_parameter, validate_ocr_image_payload, MAX_OCR_IMAGE_BASE64_BYTES,
    };
    use reqwest::StatusCode;
    use serde_json::Value;
    use std::{env, fs, process, time::SystemTime};

    #[test]
    fn accepts_a_bounded_ocr_payload() {
        assert!(validate_ocr_image_payload("aGVsbG8=").is_ok());
    }

    #[test]
    fn maps_luna_fast_mode_to_priority_service_with_low_reasoning() {
        let fast = chatgpt_ocr_request_body("aGVsbG8=", "image/png", true);
        let standard = chatgpt_ocr_request_body("aGVsbG8=", "image/png", false);
        assert_eq!(fast["service_tier"], "priority");
        assert_eq!(fast["reasoning"]["effort"], "low");
        assert_eq!(standard["service_tier"], "default");
        assert_eq!(standard["reasoning"]["effort"], "low");
    }

    #[test]
    fn frontend_switching_accepts_only_known_origins_and_relative_paths() {
        assert_eq!(
            frontend_origin_for_target("production").unwrap(),
            "https://poneglyph.fr"
        );
        assert_eq!(
            frontend_origin_for_target("local").unwrap(),
            "http://localhost:3000"
        );
        assert!(frontend_origin_for_target("https://attacker.example").is_err());
        assert_eq!(
            normalize_frontend_path(Some("chapter/1".into())).unwrap(),
            "/chapter/1"
        );
        assert!(normalize_frontend_path(Some("https://attacker.example".into())).is_err());
        assert!(normalize_frontend_path(Some("//attacker.example".into())).is_err());
    }

    #[test]
    fn rejects_empty_and_oversized_ocr_payloads() {
        assert!(validate_ocr_image_payload("").is_err());
        let oversized = "A".repeat(MAX_OCR_IMAGE_BASE64_BYTES + 1);
        assert!(validate_ocr_image_payload(&oversized).is_err());
    }

    #[test]
    fn parses_and_validates_chatgpt_ocr_json_from_sse() {
        let body = concat!(
            "event: response.output_text.done\n",
            "data: {\"type\":\"response.output_text.done\",\"text\":\"{\\\"bubbles\\\":[{\\\"content\\\":\\\"Bonjour !\\\",\\\"bbox\\\":[10,20,300,180]}]}\"}\n\n",
            "data: [DONE]\n"
        );
        let bubbles = parse_codex_response(body).expect("valid OCR SSE");
        assert_eq!(bubbles.len(), 1);
        assert_eq!(bubbles[0].content, "Bonjour !");
        assert_eq!(bubbles[0].bbox, [10, 20, 300, 180]);
    }

    #[test]
    fn rejects_out_of_bounds_chatgpt_boxes() {
        let body =
            r#"{"output_text":"{\"bubbles\":[{\"content\":\"Non\",\"bbox\":[0,0,1001,20]}]}"}"#;
        assert!(parse_codex_response(body).is_err());
    }

    #[test]
    fn decodes_oauth_callback_and_jwt_claims_without_extra_dependencies() {
        assert_eq!(
            query_parameter("/auth/callback?code=a%2Fb&state=test", "code").unwrap(),
            Some("a/b".to_string())
        );
        let claims = jwt_claims("e30.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature")
            .expect("JWT payload");
        assert_eq!(claims["email"], "test@example.com");
    }

    #[test]
    fn preserves_structured_error_bodies_for_recoverable_model_status() {
        let payload: Value = decode_response_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"installed":false,"integrity_error":"SHA256 invalide"}"#,
        )
        .expect("structured local status must reach the desktop UI");

        assert_eq!(payload["installed"], false);
        assert_eq!(payload["integrity_error"], "SHA256 invalide");
    }

    #[test]
    fn creates_only_model_parent_directories_before_backend_recovery() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "poneglyph-model-parent-test-{}-{unique}",
            process::id()
        ));
        let bbox_dir = root.join("models").join("bbox");
        let text_dir = root.join("models").join("text");

        ensure_model_parent_directories(&[bbox_dir.as_path(), text_dir.as_path()])
            .expect("model parent creation");

        assert!(root.join("models").is_dir());
        assert!(!bbox_dir.exists());
        assert!(!text_dir.exists());

        fs::remove_dir_all(&root).expect("temporary model parent cleanup");
    }
}
