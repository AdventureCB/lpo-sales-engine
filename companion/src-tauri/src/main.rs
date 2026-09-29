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
/// Open an app page in its own native window — chat popouts for dual-screen.
/// Shares the main webview's cookie store, so the session carries over.
/// Restricted to the app's own origin.
#[tauri::command]
fn open_url_window(app: tauri::AppHandle, url: String, label: String) -> Result<(), String> {
    use tauri::Manager;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if parsed.host_str() != Some("lpo-sales-engine.vercel.app") {
        return Err("origin not allowed".into());
    }
    let safe: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if let Some(w) = app.get_webview_window(&safe) {
        let _ = w.set_focus();
        return Ok(());
    }
    // macOS requires window creation on the main thread.
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = tauri::WebviewWindowBuilder::new(&app2, &safe, tauri::WebviewUrl::External(parsed))
            .title("LPO Text")
            .inner_size(430.0, 680.0)
            .build()
        {
            eprintln!("open_url_window build failed: {e}");
        }
    })
    .map_err(|e| format!("main thread: {e}"))?;
    Ok(())
}

/// Bring the main window to the front — invoked when a call rings while the
/// app is minimized or behind other windows.
// ── Tool idle detection (0.2.4) ────────────────────────────────────────────
// Which tool window is focused right now (window events keep it current).
// A background thread reads the SYSTEM input-idle clock; when the rep goes
// idle ≥2min with a tool focused we emit a synthetic blur (backdated via
// idleFor) and re-emit focus when they return — so "time in Gorgias" means
// time actually working in Gorgias, not a focused window over lunch.
static FOCUSED_TOOL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

/// Force a tool window into the shared tab group. tabbing_identifier alone
/// only makes windows ELIGIBLE — actual tabbing obeys the user's macOS
/// "Prefer tabs" setting (default: full-screen only → separate windows,
/// Kyle 9/9). setTabbingMode:preferred + an explicit addTabbedWindow: on
/// any existing group member makes it deterministic. Main thread only.
#[cfg(target_os = "macos")]
fn attach_to_tool_tab_group(app: &tauri::AppHandle, w: &tauri::WebviewWindow, own_label: &str) {
    use objc::{msg_send, sel, sel_impl};
    use tauri::Manager;
    let Ok(new_ns) = w.ns_window() else { return };
    let new_ns = new_ns as *mut objc::runtime::Object;
    unsafe {
        let _: () = msg_send![new_ns, setTabbingMode: 1i64]; // NSWindowTabbingModePreferred
    }
    for (label, other) in app.webview_windows() {
        if label == own_label || label == "tool-ops" || !label.starts_with("tool-") {
            continue;
        }
        if let Ok(ex) = other.ns_window() {
            let ex = ex as *mut objc::runtime::Object;
            unsafe {
                let _: () = msg_send![ex, addTabbedWindow: new_ns ordered: 1i64]; // NSWindowAbove
            }
            break;
        }
    }
}


/// Real Safari UA: these are WebKit windows, but sites sniff the default wry
/// UA string and throw "unsupported browser" banners (Gmail/ClickUp 9/9);
/// Google can even hard-block sign-in.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";

/// Floating bar injected into every tool window (and every popup): current
/// URL (editable — Enter navigates, or searches Google), Copy, back/forward,
/// collapse. Survives navigation because it's an initialization script.
/// Skips our own app pages, which have their own chrome.
const TOOL_BAR: &str = r#"(function(){
  if (window.top !== window || window.__lpoNavBar) return; window.__lpoNavBar = true;
  if (/lpo-sales-engine\.vercel\.app$/.test(location.host)) return;
  var mk = function(){
    if (!document.body) { setTimeout(mk, 50); return; }
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;display:flex;gap:4px;align-items:center;background:rgba(20,22,26,.94);border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:5px 7px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.4)';
    var btn = function(txt, fn, title){
      var b = document.createElement('button'); b.textContent = txt; b.title = title;
      b.style.cssText = 'all:unset;cursor:pointer;color:#e7e9ec;font-size:14px;line-height:1;padding:3px 8px;border-radius:6px;white-space:nowrap';
      b.onmouseenter = function(){ b.style.background = 'rgba(255,255,255,.12)'; };
      b.onmouseleave = function(){ b.style.background = 'transparent'; };
      b.onclick = fn; return b;
    };
    bar.appendChild(btn('←', function(){ history.back(); }, 'Back'));
    bar.appendChild(btn('→', function(){ history.forward(); }, 'Forward'));
    var inp = document.createElement('input');
    inp.value = location.href; inp.title = 'Current page — click to select, Enter to go';
    inp.style.cssText = 'background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.14);color:#e7e9ec;border-radius:7px;padding:4px 10px;font-size:12.5px;width:300px;outline:none;text-overflow:ellipsis';
    inp.addEventListener('focus', function(){ setTimeout(function(){ inp.select(); }, 0); });
    inp.addEventListener('keydown', function(e){
      e.stopPropagation();
      if (e.key === 'Escape') { inp.value = location.href; inp.blur(); return; }
      if (e.key !== 'Enter') return;
      var v = inp.value.trim(); if (!v) return;
      var hasScheme = /^[a-z]+:\/\//i.test(v);
      var urlish = hasScheme || (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(v) && v.indexOf(' ') === -1);
      location.href = urlish ? (hasScheme ? v : 'https://' + v) : 'https://www.google.com/search?q=' + encodeURIComponent(v);
    }, true);
    bar.appendChild(inp);
    var copy = btn('⧉', function(){
      var url = location.href;
      var done = function(){ copy.textContent = '✓'; setTimeout(function(){ copy.textContent = '⧉'; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function(){ inp.focus(); inp.select(); document.execCommand('copy'); done(); });
      else { inp.focus(); inp.select(); document.execCommand('copy'); done(); }
    }, 'Copy page URL');
    bar.appendChild(copy);
    var collapsed = false;
    bar.appendChild(btn('–', function(){ collapsed = !collapsed; inp.style.display = collapsed ? 'none' : ''; copy.style.display = collapsed ? 'none' : ''; }, 'Collapse'));
    document.body.appendChild(bar);
    // Keep the URL current across in-page navigation (SPAs, pushState).
    var last = location.href;
    setInterval(function(){ if (location.href !== last) { last = location.href; if (document.activeElement !== inp) inp.value = last; } }, 500);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mk); else mk();
})();"#;

/// Size a new tool window to the screen: the defaults on a laptop display
/// used to overflow the bottom edge.
fn fit_to_screen(app: &tauri::AppHandle, want_w: f64, want_h: f64) -> (f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size();
        let sw = size.width as f64 / scale;
        let sh = size.height as f64 / scale;
        return (want_w.min((sw - 60.0).max(700.0)), want_h.min((sh - 110.0).max(500.0)));
    }
    (want_w, want_h)
}

/// Nudge the window size after creation so the webview relays out under a
/// freshly added native tab bar (otherwise the last ~28px of page are hidden).
fn relayout_soon(w: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if let Ok(s) = w.inner_size() {
            let _ = w.set_size(tauri::PhysicalSize::new(s.width, s.height + 2));
            std::thread::sleep(std::time::Duration::from_millis(60));
            let _ = w.set_size(s);
        }
    });
}

static POPUP_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// window.open / target=_blank from a tool page → a real, interactive window
/// that shares the opener's WebKit configuration (same cookies + process),
/// with the tool bar injected. Falls back to the platform default if the
/// build fails. Popups of popups use the platform default.
fn popup_handler(app: tauri::AppHandle) -> impl Fn(tauri::Url, tauri::webview::NewWindowFeatures) -> tauri::webview::NewWindowResponse<tauri::Wry> + Send + 'static {
    move |url, features| {
        let n = POPUP_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let label = format!("popup-{n}");
        let (dw, dh) = fit_to_screen(&app, 1000.0, 760.0);
        let (w, h) = match features.size() {
            Some(sz) if sz.width >= 320.0 && sz.height >= 240.0 => (sz.width.min(dw), sz.height.min(dh)),
            _ => (dw, dh),
        };
        let mut b = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
            .title("LPO")
            .initialization_script(TOOL_BAR)
            .user_agent(SAFARI_UA)
            .inner_size(w, h)
            .on_new_window(|_u, _f| tauri::webview::NewWindowResponse::Allow);
        #[cfg(target_os = "macos")]
        {
            b = b.with_webview_configuration(features.opener().target_configuration.clone());
        }
        match b.build() {
            Ok(win) => tauri::webview::NewWindowResponse::Create { window: win },
            Err(e) => {
                eprintln!("popup build failed: {e}");
                tauri::webview::NewWindowResponse::Allow
            }
        }
    }
}

/// Open (or focus) a native window on an EXTERNAL tool (Gorgias, Shopify,
/// ClickUp, Calendly, a plain browser tab…). A top-level webview ignores
/// X-Frame-Options — the reason these can't be iframed in the app — and the
/// shared cookie store keeps reps signed in across sessions. HTTPS only.
/// Focus/blur/close are reported to the main window as "tool-focus" events
/// so the web app can track per-tool engagement time.
#[tauri::command]
fn open_tool_window(app: tauri::AppHandle, url: String, label: String, title: String, group: Option<String>) -> Result<(), String> {
    use tauri::Manager;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("https only".into());
    }
    let clean: String = label.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let safe = format!("tool-{clean}");
    if let Some(w) = app.get_webview_window(&safe) {
        let _ = w.set_focus();
        return Ok(());
    }
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let (w_px, h_px) = fit_to_screen(&app2, 1240.0, 860.0);
        let mut builder = tauri::WebviewWindowBuilder::new(&app2, &safe, tauri::WebviewUrl::External(parsed))
            .title(&title)
            // Every tool window gets the floating bar (URL + copy + back/forward);
            // it skips our own origin, which has its own chrome.
            .initialization_script(TOOL_BAR)
            .user_agent(SAFARI_UA)
            .inner_size(w_px, h_px)
            // window.open / target=_blank → a REAL window that shares this
            // webview's configuration (cookies, process). "Allow" alone
            // rendered nothing on macOS (Kyle 9/29: "buttons don't work").
            .on_new_window(popup_handler(app2.clone()));
        // macOS native window tabbing: same identifier → windows merge into
        // ONE tabbed window (Kyle 9/9: main app + Ops + one tools window =
        // max 3). Ops passes no group and stays standalone.
        #[cfg(target_os = "macos")]
        if let Some(g) = &group {
            let gid: String = g.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
            builder = builder.tabbing_identifier(&format!("lpo-{gid}"));
        }
        #[cfg(not(target_os = "macos"))]
        let _ = &group;
        let grouped = group.is_some();
        match builder.build()
        {
            Ok(w) => {
                use tauri::{Emitter, Manager};
                #[cfg(target_os = "macos")]
                if grouped {
                    attach_to_tool_tab_group(&app2, &w, &safe);
                }
                #[cfg(not(target_os = "macos"))]
                let _ = grouped;
                // Joining a tab group adds a tab bar the webview frame doesn't
                // account for — the bottom of the page was clipped (Kyle 9/29).
                // A size nudge forces a relayout.
                relayout_soon(w.clone());
                let app3 = app2.clone();
                let lbl = clean.clone();
                // Focus telemetry: the main window's web app turns these into
                // tool-time engagement sessions.
                w.on_window_event(move |ev| {
                    let focused = match ev {
                        tauri::WindowEvent::Focused(f) => Some(*f),
                        tauri::WindowEvent::Destroyed => Some(false),
                        _ => None,
                    };
                    if let Some(f) = focused {
                        if let Ok(mut cur) = FOCUSED_TOOL.lock() {
                            if f {
                                *cur = Some(lbl.clone());
                            } else if cur.as_deref() == Some(lbl.as_str()) {
                                *cur = None;
                            }
                        }
                        if let Some(main) = app3.get_webview_window("main") {
                            let _ = main.emit("tool-focus", serde_json::json!({ "label": lbl, "focused": f }));
                        }
                    }
                });
            }
            Err(e) => eprintln!("open_tool_window build failed: {e}"),
        }
    })
    .map_err(|e| format!("main thread: {e}"))?;
    Ok(())
}

#[tauri::command]
fn focus_main(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

/// Companion version — surfaced on the web app's Settings page.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Open a URL in the default browser — restricted to our own GitHub releases
/// (used by the Settings "update companion" link).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/AdventureCB/lpo-sales-engine") {
        return Err("url not allowed".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("open failed: {e}"))?;
    Ok(())
}

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
        // Give Quo time to open its start-call prompt (slower machines need
        // more), force it frontmost so the Return lands in the prompt, then
        // hand focus back to the dialer.
        std::thread::sleep(std::time::Duration::from_millis(1400));
        let script = r#"
tell application "Quo" to activate
delay 0.4
tell application "System Events" to keystroke return
delay 0.2
tell application "LPO Queue Runner" to activate
"#;
        let _ = std::process::Command::new("osascript").args(["-e", script]).output();
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
/// (⇧⌘H), and hand focus straight back to the dialer. Fire-and-forget on a
/// background thread — blocking the main thread beachballs the whole window.
#[tauri::command]
fn end_call() -> Result<String, String> {
    std::thread::spawn(|| {
        let script = r#"
tell application "Quo" to activate
delay 0.2
tell application "System Events" to keystroke "h" using {command down, shift down}
delay 0.1
tell application "LPO Queue Runner" to activate
"#;
        let _ = std::process::Command::new("osascript").args(["-e", script]).output();
    });
    Ok("sent".into())
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
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::{Emitter, Manager};
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut was_idle = false;
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(10));
                        let idle = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
                        let focused = FOCUSED_TOOL.lock().ok().and_then(|g| g.clone());
                        let Some(main) = handle.get_webview_window("main") else { continue };
                        if idle >= 120.0 && !was_idle {
                            was_idle = true;
                            if let Some(lbl) = &focused {
                                let _ = main.emit(
                                    "tool-focus",
                                    serde_json::json!({ "label": lbl, "focused": false, "idleFor": idle }),
                                );
                            }
                        } else if was_idle && idle < 5.0 {
                            was_idle = false;
                            if let Some(lbl) = &focused {
                                let _ = main.emit("tool-focus", serde_json::json!({ "label": lbl, "focused": true }));
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            play_vm,
            list_output_devices,
            setup_audio,
            audio_status,
            open_tel,
            open_url_window,
            open_tool_window,
            app_version,
            focus_main,
            open_external,
            end_call
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
