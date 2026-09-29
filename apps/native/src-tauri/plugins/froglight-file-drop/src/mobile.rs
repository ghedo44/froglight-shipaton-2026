use serde::de::DeserializeOwned;
#[cfg(target_os = "android")]
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::PluginApi,
    AppHandle, Runtime,
};
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;

#[cfg(target_os = "android")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<FileDrop<R>> {
    let handle =
        api.register_android_plugin("io.froglight.filedrop", "FroglightFileDropPlugin")?;
    Ok(FileDrop(handle))
}

// iOS stays inert: WKWebView already receives Files.app drops through the
// normal HTML drop APIs, and a UIDropInteraction backend would risk
// competing with (and duplicating) that path.
#[cfg(target_os = "ios")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<FileDrop<R>> {
    Ok(FileDrop(std::marker::PhantomData))
}

/// Access to the file-drop native APIs (opaque token -> bytes).
#[cfg(target_os = "android")]
pub struct FileDrop<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "ios")]
pub struct FileDrop<R: Runtime>(std::marker::PhantomData<fn() -> R>);

#[cfg(target_os = "android")]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadDropFileRequest {
    token: String,
}

#[cfg(target_os = "android")]
#[derive(Debug, Deserialize)]
struct ReadDropFileResponse {
    data: Vec<u8>,
}

#[cfg(target_os = "android")]
impl<R: Runtime> FileDrop<R> {
    pub fn read_drop_file(&self, token: String) -> crate::Result<Vec<u8>> {
        if token.is_empty() {
            return Err(crate::FileDropError::UnknownToken);
        }
        let response: ReadDropFileResponse = self
            .0
            .run_mobile_plugin("readDropFile", ReadDropFileRequest { token })?;
        Ok(response.data)
    }

    pub fn release_drop_file(&self, token: String) -> crate::Result<()> {
        if token.is_empty() {
            return Ok(());
        }
        self.0
            .run_mobile_plugin::<(), _>(
                "releaseDropFile",
                ReadDropFileRequest { token },
            )
            .map_err(Into::into)
    }
}

#[cfg(target_os = "ios")]
impl<R: Runtime> FileDrop<R> {
    pub fn read_drop_file(&self, _token: String) -> crate::Result<Vec<u8>> {
        Err(crate::FileDropError::UnknownToken)
    }

    pub fn release_drop_file(&self, _token: String) -> crate::Result<()> {
        Ok(())
    }
}
