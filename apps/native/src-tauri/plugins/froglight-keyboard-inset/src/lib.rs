//! Froglight-owned overlay keyboard insets.
//!
//! The WebView keeps its full size on mobile and the soft keyboard overlays
//! it. Native inset transitions are reported to the page through a direct
//! `evaluateJavaScript` hook — the Tauri plugin event channel delivers with
//! enough latency that a `willShow` sent through it arrives after the IME
//! animation it announces has already finished.
//!
//! Behavior derived from `dash-chat/tauri-plugin-virtual-keyboard`
//! (MIT OR Apache-2.0); reimplemented as Froglight-owned code with no
//! dependency on that repository.

mod commands;
#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
use desktop::KeyboardInset;
#[cfg(mobile)]
use mobile::KeyboardInset;

pub use commands::NativeKeyboardInsetState;
pub use error::{KeyboardInsetError, Result};

/// State accessor for the managed keyboard-inset handle.
pub trait KeyboardInsetExt<R: Runtime> {
    fn keyboard_inset(&self) -> &KeyboardInset<R>;
}

impl<R: Runtime, T: Manager<R>> KeyboardInsetExt<R> for T {
    fn keyboard_inset(&self) -> &KeyboardInset<R> {
        self.state::<KeyboardInset<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("froglight-keyboard-inset")
        .invoke_handler(tauri::generate_handler![
            commands::hide,
            commands::show,
            commands::get_state
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let inset = mobile::init(app, api)?;
            #[cfg(desktop)]
            let inset = desktop::init(app, api)?;
            app.manage(inset);
            Ok(())
        })
        .build()
}
