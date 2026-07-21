// LPO Queue Runner — wraps the deployed dialer and adds the one native
// capability a browser can't have: playing a voicemail recording into the
// virtual audio device (BlackHole) that feeds Quo's microphone.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, OutputStream, Sink};
use std::io::Cursor;

#[cfg(target_os = "macos")]
mod audio_setup;

const VM_DEVICE_NAME: &str = "BlackHole 2ch";

/// The webview blocks tel: navigation — hand it to the OS so the default
/// calling app (Quo desktop) picks it up. Quo then shows a "start call"
/// confirmation whose call button is the default action — auto-confirm by
/// pressing Return in Quo (requires the one-time Accessibility/Automation
/// grant; if denied, the rep just clicks like before).
#[tauri::command]
fn open_tel(url: String) -> Result<(), String> {
    if !url.starts_with("tel:") {
        return Err("only tel: urls".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(900));
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to tell process \"Quo\" to keystroke return",
            ])
            .output();
    });
    Ok(())
}

/// Electron apps hide their UI from the accessibility tree until
/// AXManualAccessibility is set on them via the native AX API (AppleScript
/// can't do this). Must run before any AX inspection of Quo.
#[cfg(target_os = "macos")]
fn enable_quo_accessibility() -> Result<(), String> {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::CFString;

    let pid_out = std::process::Command::new("pgrep")
        .args(["-x", "Quo"])
        .output()
        .map_err(|e| e.to_string())?;
    let pid: i32 = String::from_utf8_lossy(&pid_out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .parse()
        .map_err(|_| "Quo is not running".to_string())?;

    unsafe {
        let app = accessibility_sys::AXUIElementCreateApplication(pid);
        let attr = CFString::new("AXManualAccessibility");
        let err = accessibility_sys::AXUIElementSetAttributeValue(
            app,
            attr.as_concrete_TypeRef(),
            CFBoolean::true_value().as_CFTypeRef(),
        );
        if err != accessibility_sys::kAXErrorSuccess {
            return Err(format!("AXManualAccessibility set failed ({err})"));
        }
    }
    Ok(())
}

/// Hang up the active Quo call: focus Quo, send its end-call shortcut
/// (⇧⌘H), and hand focus straight back to the dialer.
#[tauri::command]
fn end_call() -> Result<String, String> {
    let script = r#"
tell application "Quo" to activate
delay 0.2
tell application "System Events" to keystroke "h" using {command down, shift down}
delay 0.1
tell application "LPO Queue Runner" to activate
return "sent"
"#;
    let out = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(if stderr.is_empty() { "accessibility error".into() } else { stderr });
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

/// One-click creation of the "Mic + VM" aggregate device.
#[tauri::command]
fn setup_audio() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        audio_setup::create_mic_vm_aggregate()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("macOS only".into())
    }
}

/// Environment check for the UI: is BlackHole installed / aggregate present?
#[tauri::command]
fn audio_status() -> serde_json::Value {
    let host = cpal::default_host();
    let outputs: Vec<String> = host
        .output_devices()
        .map(|d| d.filter_map(|x| x.name().ok()).collect())
        .unwrap_or_default();
    let inputs: Vec<String> = host
        .input_devices()
        .map(|d| d.filter_map(|x| x.name().ok()).collect())
        .unwrap_or_default();
    serde_json::json!({
        "blackhole": outputs.iter().any(|n| n.contains("BlackHole")),
        "aggregate": inputs.iter().any(|n| n == "Mic + VM"),
    })
}

#[tauri::command]
fn list_output_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|devices| devices.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// Download the signed WAV URL and play it synchronously into the virtual
/// device. Blocks until playback finishes so the UI can hang up after.
#[tauri::command]
async fn play_vm(url: String, device: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = reqwest::blocking::get(&url)
            .map_err(|e| format!("download: {e}"))?
            .bytes()
            .map_err(|e| format!("download body: {e}"))?;

        let wanted = device.unwrap_or_else(|| VM_DEVICE_NAME.to_string());
        let host = cpal::default_host();
        let out = host
            .output_devices()
            .map_err(|e| format!("devices: {e}"))?
            .find(|d| d.name().map(|n| n == wanted).unwrap_or(false))
            .ok_or_else(|| format!("audio device '{wanted}' not found — is BlackHole installed?"))?;

        let (_stream, handle) =
            OutputStream::try_from_device(&out).map_err(|e| format!("open device: {e}"))?;
        let sink = Sink::try_new(&handle).map_err(|e| format!("sink: {e}"))?;
        let source =
            Decoder::new(Cursor::new(bytes.to_vec())).map_err(|e| format!("decode: {e}"))?;
        sink.append(source);
        sink.sleep_until_end();
        Ok(())
    })
    .await
    .map_err(|e| format!("task: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            play_vm,
            list_output_devices,
            setup_audio,
            audio_status,
            open_tel,
            end_call
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
