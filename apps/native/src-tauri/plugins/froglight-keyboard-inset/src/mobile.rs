use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::commands::NativeKeyboardInsetState;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_froglight_keyboard_inset);

#[cfg(target_os = "android")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<KeyboardInset<R>> {
    let handle =
        api.register_android_plugin("io.froglight.keyboardinset", "FroglightKeyboardInsetPlugin")?;
    Ok(KeyboardInset(handle))
}

#[cfg(target_os = "ios")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<KeyboardInset<R>> {
    let handle = api.register_ios_plugin(init_plugin_froglight_keyboard_inset)?;
    Ok(KeyboardInset(handle))
}

/// Access to the keyboard-inset native APIs.
pub struct KeyboardInset<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> KeyboardInset<R> {
    pub fn hide(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("hide", ()).map_err(Into::into)
    }

    pub fn show(&self) -> crate::Result<()> {
        self.0.run_mobile_plugin("show", ()).map_err(Into::into)
    }

    #[cfg(target_os = "ios")]
    pub fn get_state(&self) -> crate::Result<NativeKeyboardInsetState> {
        self.0
            .run_mobile_plugin("getState", ())
            .map_err(Into::into)
    }

    #[cfg(target_os = "android")]
    pub fn get_state(&self) -> crate::Result<NativeKeyboardInsetState> {
        //  Cached readback is currently iOS-only. Keep the command
        // portable so shared Rust registration never creates an Android-only
        // transport failure if it is called accidentally.
        Ok(NativeKeyboardInsetState::default())
    }
}
