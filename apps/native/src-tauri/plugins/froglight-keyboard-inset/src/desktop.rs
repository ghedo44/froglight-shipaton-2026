use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::commands::NativeKeyboardInsetState;

// `fn() -> R` keeps the state Send + Sync for any Runtime: tauri >= 2.11 no
// longer bounds Runtime by Send/Sync, so a plain PhantomData<R> marker fails
// Manager::manage/state bounds.
pub struct KeyboardInset<R: Runtime>(std::marker::PhantomData<fn() -> R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<KeyboardInset<R>, tauri::Error> {
    Ok(KeyboardInset(std::marker::PhantomData))
}

impl<R: Runtime> KeyboardInset<R> {
    pub fn hide(&self) -> crate::Result<()> {
        Ok(())
    }

    pub fn show(&self) -> crate::Result<()> {
        Ok(())
    }

    pub fn get_state(&self) -> crate::Result<NativeKeyboardInsetState> {
        Ok(NativeKeyboardInsetState::default())
    }
}
