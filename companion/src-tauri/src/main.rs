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
            audio_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
