use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::KeyboardInsetExt;

/// Cached snapshot returned by the trusted native readback command.
///
/// This is host infrastructure, not a public SDK capability. It repairs a
/// missed direct-eval delivery; it does not expose a second geometry system.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeKeyboardInsetState {
    pub height: f64,
    pub is_open: bool,
    pub is_hiding: bool,
}

/// Retract the soft keyboard through the OS. Resolves as a no-op where no
/// soft keyboard exists (desktop, iOS `show` path excluded).
#[tauri::command]
pub async fn hide<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    app.keyboard_inset().hide()
}

/// Summon the soft keyboard for the currently focused input. The input must
/// already hold focus so an IME connection exists. No-op on desktop and iOS
/// (iOS only shows the keyboard on user-initiated focus).
#[tauri::command]
pub async fn show<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    app.keyboard_inset().show()
}

/// Read cached native keyboard state without changing focus or WebView size.
/// iOS returns the same canonical height used by direct events; other targets
/// return the neutral default state.
#[tauri::command]
pub async fn get_state<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<NativeKeyboardInsetState> {
    app.keyboard_inset().get_state()
}
