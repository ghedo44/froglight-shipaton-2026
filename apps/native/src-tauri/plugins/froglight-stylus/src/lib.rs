//! Froglight-owned stylus accessory events and input policy.
//!
//! Low-frequency input policy and accessories — double-tap, squeeze, eraser,
//! barrel buttons, proximity, capabilities. High-frequency stroke samples stay in
//! the WebView's `PointerEvent` pipeline and never cross the native bridge:
//! forwarding every sample over IPC would add serialization, allocation,
//! dispatch, and jitter for data the WebView already delivers.
//!
//! Native accessory reports travel to the page through a direct
//! `evaluateJavaScript` hook (`window.__FROGLIGHT_STYLUS_EVENT__`), the
//! same mechanism as the keyboard-inset plugin: accessory actions must
//! feel instant, and the Tauri plugin event channel adds latency.
//!
//! Platform order: iPadOS (double-tap/squeeze/capabilities)
//! and Android (eraser/buttons/hover/capabilities) first; Windows
//! (`GetPointerPenInfo`/`WM_POINTER*`), macOS (`NSEvent` tablet monitor),
//! and Linux (GTK/GDK axes, never direct libinput) fill proven gaps only.
//! Drawing on every host works with `PointerEvent` alone from day one.

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
use desktop::Stylus;
#[cfg(mobile)]
use mobile::Stylus;

pub use commands::{NativeStylusCapabilities, StylusInputContext};
pub use error::{Result, StylusError};

/// State accessor for the managed stylus handle.
pub trait StylusExt<R: Runtime> {
    fn stylus(&self) -> &Stylus<R>;
}

impl<R: Runtime, T: Manager<R>> StylusExt<R> for T {
    fn stylus(&self) -> &Stylus<R> {
        self.state::<Stylus<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("froglight-stylus")
        .invoke_handler(tauri::generate_handler![
            commands::get_capabilities,
            commands::set_input_context
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let stylus = mobile::init(app, api)?;
            #[cfg(desktop)]
            let stylus = desktop::init(app, api)?;
            app.manage(stylus);
            Ok(())
        })
        .build()
}
