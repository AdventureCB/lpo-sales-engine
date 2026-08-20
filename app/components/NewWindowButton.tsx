"use client";

/**
 * ⧉ Open a second app window (CRM, aux mode: no softphone, page-locked
 * against the main window). Companion: native window via open_url_window
 * (shares the session; requires companion ≥ 0.2.0). Browser: a popup.
 */
export function NewWindowButton() {
  const open = () => {
    const url = `${window.location.origin}/crm?aux=1`;
    const tauri = (window as { __TAURI__?: { core: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> } } }).__TAURI__;
    if (tauri?.core?.invoke) {
      void tauri.core.invoke("open_url_window", { url, label: "aux-crm" }).catch(() => {
        window.open(url, "aux-crm", "width=1280,height=850,resizable=yes,popup=yes");
      });
    } else {
      window.open(url, "aux-crm", "width=1280,height=850,resizable=yes,popup=yes");
    }
  };
  return (
    <button
      className="btn ghost"
      style={{ padding: "5px 10px", fontSize: 14 }}
      onClick={open}
      title="Open a second window (CRM lookup — phone stays in this window)"
    >
      ⧉
    </button>
  );
}
