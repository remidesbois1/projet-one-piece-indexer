use serde_json::Value;
use std::{fs, path::PathBuf};

fn manifest_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_text(relative: &str) -> String {
    fs::read_to_string(manifest_path(relative))
        .unwrap_or_else(|error| panic!("failed to read {relative}: {error}"))
}

fn read_json(relative: &str) -> Value {
    serde_json::from_str(&read_text(relative))
        .unwrap_or_else(|error| panic!("failed to parse {relative}: {error}"))
}

#[test]
fn desktop_window_uses_the_configured_dev_or_production_frontend() {
    let config = read_json("tauri.conf.json");
    let main_window = &config["app"]["windows"][0];
    let security = &config["app"]["security"];

    assert!(main_window.get("url").is_none());
    let csp = security["csp"].as_str().expect("CSP must be enabled");
    assert!(csp.contains("object-src 'none'"));
    assert!(csp.contains("base-uri 'none'"));
    assert!(csp.contains("script-src 'self'"));
    assert_eq!(
        security["capabilities"],
        serde_json::json!(["poneglyph-desktop"])
    );
}

#[test]
fn native_permissions_are_limited_to_poneglyph_and_local_development() {
    let capability = read_json("capabilities/default.json");
    let urls = capability["remote"]["urls"]
        .as_array()
        .expect("desktop URLs must be explicit");

    assert_eq!(capability["identifier"], "poneglyph-desktop");
    assert!(urls.iter().all(|url| {
        let url = url.as_str().unwrap_or_default();
        url.starts_with("https://poneglyph.fr/")
            || url.starts_with("https://www.poneglyph.fr/")
            || url.starts_with("http://localhost:3000/")
            || url.starts_with("http://127.0.0.1:3000/")
    }));
}

#[test]
fn fallback_only_redirects_to_the_trusted_site() {
    let html = read_text("desktop-fallback/index.html");
    let rust = read_text("src/main.rs");
    let build_script = read_text("build.rs");

    assert!(html.contains("window.location.replace('https://poneglyph.fr')"));
    assert!(!html.contains("Moteurs OCR"));
    assert!(rust.contains("async fn switch_frontend_origin"));
    assert!(rust.contains("frontend_origin_for_target(&target)?"));
    assert!(build_script.contains("AppManifest::new().commands(COMMANDS)"));
}

#[test]
fn chatgpt_commands_are_explicitly_scoped() {
    let capability = read_json("capabilities/default.json");
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions must be explicit");

    for permission in [
        "allow-chatgpt-login",
        "allow-get-chatgpt-auth-status",
        "allow-chatgpt-logout",
        "allow-run-chatgpt-page-ocr",
        "allow-switch-frontend-origin",
    ] {
        assert!(permissions.iter().any(|item| item == permission));
    }
}

#[test]
fn model_installation_is_never_inferred_from_a_single_config_file() {
    let rust = read_text("src/main.rs");

    assert!(!rust.contains("join(\"config.json\").exists()"));
    assert!(!rust.contains("fs::create_dir_all(&bbox_model_dir)"));
    assert!(rust.contains("ensure_model_parent_directories"));
    assert!(rust.contains("integrity_error: Option<String>"));
    assert!(rust.contains("decode_response_json(status, &text)"));
}
