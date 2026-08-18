fn main() {
    const COMMANDS: &[&str] = &[
        "get_local_model_status",
        "get_local_text_model_status",
        "get_local_surya_model_status",
        "get_local_surya_bbox_model_status",
        "load_local_model",
        "load_local_text_model",
        "load_local_surya_model",
        "load_local_surya_bbox_model",
        "download_local_model",
        "download_local_text_model",
        "download_local_surya_model",
        "download_local_surya_bbox_model",
        "run_local_ocr",
        "run_local_text_ocr",
        "run_local_surya_ocr",
        "run_local_surya_bbox_ocr",
        "healthcheck_local_backend",
        "switch_frontend_origin",
        "get_app_version",
        "chatgpt_login",
        "get_chatgpt_auth_status",
        "chatgpt_logout",
        "run_chatgpt_page_ocr",
    ];

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build the Tauri command manifest");
}
