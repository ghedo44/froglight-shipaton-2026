//! Froglight-owned external file ingress (`froglight.file-drop`).
//!
//! The browser/WebView HTML5 drop path stays primary on every desktop host
//! and on iPadOS (Tauri's native interception is disabled so `DataTransfer`
//! keeps working). This plugin exists for Android, where cross-application
//! drops arrive as `DragEvent` + `ClipData` + `content://` URIs rather than
//! reliably becoming WebView `File` objects.
//!
//! Design notes:
//! - Drop events travel to the page through a direct `evaluateJavaScript`
//!   hook (`window.__FROGLIGHT_FILE_DROP_EVENT__`), the same mechanism as
//!   the stylus and keyboard-inset plugins: drops must feel instant, and
//!   the Tauri plugin event channel adds latency.
//! - Shared application code never sees filesystem paths or `content://`
//!   URIs. The native side mints opaque tokens (`token -> URI`) and emits
//!   `{ token, name, mimeType, size }`; the TS adapter resolves bytes
//!   lazily through `read_drop_file`.
//! - Whole files are never sent as base64 through JS evaluation.
//! - Desktop and iOS backends are managed no-ops until device testing
//!   proves a gap: the HTML5 path already covers them.

#[cfg(desktop)]
mod desktop;
mod commands;
mod error;
#[cfg(mobile)]
mod mobile;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
use desktop::FileDrop;
#[cfg(mobile)]
use mobile::FileDrop;

pub use error::{FileDropError, Result};

/// State accessor for the managed file-drop handle.
pub trait FileDropExt<R: Runtime> {
    fn file_drop(&self) -> &FileDrop<R>;
}

impl<R: Runtime, T: Manager<R>> FileDropExt<R> for T {
    fn file_drop(&self) -> &FileDrop<R> {
        self.state::<FileDrop<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("froglight-file-drop")
        .invoke_handler(tauri::generate_handler![
            commands::read_drop_file,
            commands::release_drop_file
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let drop = mobile::init(app, api)?;
            #[cfg(desktop)]
            let drop = desktop::init(app, api)?;
            app.manage(drop);
            Ok(())
        })
        .build()
}
