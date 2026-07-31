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
fn production_window_starts_from_bundled_content_with_a_strict_csp() {
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
        serde_json::json!(["local-privileged", "remote-readonly"])
    );
}

#[test]
fn remote_origins_receive_no_native_permissions() {
    let local = read_json("capabilities/default.json");
    let remote = read_json("capabilities/remote-readonly.json");
    let local_urls = local["remote"]["urls"]
        .as_array()
        .expect("local development URLs must be explicit");

    assert_eq!(local["identifier"], "local-privileged");
    assert!(local_urls.iter().all(|url| {
        let url = url.as_str().unwrap_or_default();
        url.starts_with("http://localhost:3000/") || url.starts_with("http://127.0.0.1:3000/")
    }));
    assert_eq!(remote["identifier"], "remote-readonly");
    assert!(remote["permissions"].as_array().is_some_and(Vec::is_empty));
    assert!(remote["remote"]["urls"]
        .as_array()
        .is_some_and(|urls| urls.iter().all(|url| {
            url.as_str()
                .is_some_and(|url| url.starts_with("https://") && url.contains("poneglyph.fr/"))
        })));
}

#[test]
fn remote_site_is_sandboxed_and_cannot_replace_the_local_shell() {
    let html = read_text("desktop-fallback/index.html");
    let rust = read_text("src/main.rs");
    let build_script = read_text("build.rs");

    assert!(html.contains("sandbox=\""));
    assert!(!html.contains("allow-top-navigation"));
    assert!(!html.contains("window.location"));
    assert!(!rust.contains("switch_frontend_origin"));
    assert!(build_script.contains("AppManifest::new().commands(COMMANDS)"));
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
