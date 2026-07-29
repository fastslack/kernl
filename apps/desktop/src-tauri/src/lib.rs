//! Kernl Desktop App - Tauri Backend

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};

/// Get kernel status from the HTTP API
#[tauri::command]
async fn get_kernel_status(base_url: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/health", base_url);
    
    let response = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?;
    
    let status: serde_json::Value = response
        .json()
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(status)
}

/// Send a message to the kernel
#[tauri::command]
async fn send_message(base_url: String, message: String) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/chat", base_url);
    
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .json(&serde_json::json!({ "message": message }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| e.to_string())?;
    
    Ok(result)
}

/// Setup the system tray
fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Kernl")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_kernel_status,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
