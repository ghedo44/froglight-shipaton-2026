use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

// `fn() -> R` keeps the state Send + Sync for any Runtime: tauri >= 2.11 no
// longer bounds Runtime by Send/Sync, so a plain PhantomData<R> marker fails
// Manager::manage/state bounds.
//
// Desktop hosts are PointerEvent-first: the browser already
// projects pen pressure/tilt/twist/buttons. Native Win32 (`WM_POINTER*` /
// `GetPointerPenInfo`), AppKit (`NSEvent` tablet monitor), and GTK/GDK
// backends land only for gaps physical-device testing proves (eraser
// state, proximity, device identification). Until then this is a managed
// no-op handle so the capability graph resolves uniformly on every host.
pub struct Stylus<R: Runtime>(std::marker::PhantomData<fn() -> R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Stylus<R>, tauri::Error> {
    Ok(Stylus(std::marker::PhantomData))
}

impl<R: Runtime> Stylus<R> {
    pub fn set_input_context(&self, _context: crate::StylusInputContext) -> crate::Result<()> {
        Ok(())
    }

    pub fn get_capabilities(&self) -> crate::Result<crate::NativeStylusCapabilities> {
        Ok(crate::NativeStylusCapabilities {
            available: false,
            pressure: false,
            tilt: false,
            twist: false,
            hover: false,
            eraser: false,
            barrel_button: false,
            double_tap: false,
            squeeze: false,
        })
    }
}
