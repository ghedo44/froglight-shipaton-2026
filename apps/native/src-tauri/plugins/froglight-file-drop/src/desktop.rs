use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

// `fn() -> R` keeps the state Send + Sync for any Runtime: tauri >= 2.11 no
// longer bounds Runtime by Send/Sync, so a plain PhantomData<R> marker fails
// Manager::manage/state bounds.
//
// Desktop hosts are HTML5-first: the WebView already receives OS file drops
// through `DataTransfer.files` once `dragDropEnabled: false` stops Tauri's
// native interception (which on Windows disables the HTML5 APIs). Native
// Win32 OLE, AppKit, and GTK backends land only for gaps hardware testing
// proves. Until then this is a managed no-op handle so the capability graph
// resolves uniformly on every host.
pub struct FileDrop<R: Runtime>(std::marker::PhantomData<fn() -> R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<FileDrop<R>, tauri::Error> {
    Ok(FileDrop(std::marker::PhantomData))
}

impl<R: Runtime> FileDrop<R> {
    pub fn read_drop_file(&self, _token: String) -> crate::Result<Vec<u8>> {
        Err(crate::FileDropError::UnknownToken)
    }

    pub fn release_drop_file(&self, _token: String) -> crate::Result<()> {
        Ok(())
    }
}
