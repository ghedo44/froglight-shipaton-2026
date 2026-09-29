use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{mobile::PluginInvokeError, PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{error::VaultStorageError, models::*};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.froglight.vaultstorage";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_froglight_vault_storage);

pub struct VaultStorage<R: Runtime>(PluginHandle<R>);

fn map_plugin_error(error: PluginInvokeError) -> VaultStorageError {
    VaultStorageError::from_native_message(&error.to_string())
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> Result<VaultStorage<R>, PluginInvokeError> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VaultStoragePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_froglight_vault_storage)?;
    Ok(VaultStorage(handle))
}

impl<R: Runtime> VaultStorage<R> {
    async fn run<T: DeserializeOwned, A: Serialize>(
        &self,
        command: &str,
        args: A,
    ) -> Result<T, VaultStorageError> {
        let started = std::time::Instant::now();
        let result = self
            .0
            .run_mobile_plugin_async::<T>(command, args)
            .await
            .map_err(map_plugin_error);
        log::trace!(
            "mobile_vault operation={} duration_us={} success={}",
            command,
            started.elapsed().as_micros(),
            result.is_ok()
        );
        result
    }

    pub async fn pick_folder(&self) -> Result<FolderHandle, VaultStorageError> {
        self.0
            .run_mobile_plugin_async::<PickFolderResponse>("pickFolder", ())
            .await
            .map(|response| response.folder)
            .map_err(map_plugin_error)
    }

    pub async fn forget_folder(&self, folder_id: String) -> Result<(), VaultStorageError> {
        self.run("forgetFolder", FolderIdRequest { folder_id })
            .await
    }

    pub async fn list_folders(&self) -> Result<Vec<FolderHandle>, VaultStorageError> {
        self.run::<ListFoldersResponse, _>("listFolders", ())
            .await
            .map(|response| response.folders)
    }

    pub async fn read_dir(&self, req: ReadDirRequest) -> Result<Vec<DirEntry>, VaultStorageError> {
        self.run::<ReadDirResponse, _>("readDir", req)
            .await
            .map(|response| response.entries)
    }

    pub async fn stat(&self, req: StatRequest) -> Result<FileStat, VaultStorageError> {
        self.run("stat", req).await
    }

    pub async fn read_file(
        &self,
        req: ReadFileRequest,
    ) -> Result<ReadFileResponse, VaultStorageError> {
        self.run("readFile", req).await
    }

    pub async fn write_file(&self, req: WriteFileRequest) -> Result<(), VaultStorageError> {
        self.run("writeFile", req).await
    }

    pub async fn mkdir(&self, req: MkdirRequest) -> Result<(), VaultStorageError> {
        self.run("mkdir", req).await
    }

    pub async fn remove_file(&self, req: RemoveFileRequest) -> Result<(), VaultStorageError> {
        self.run("removeFile", req).await
    }

    pub async fn remove_dir(&self, req: RemoveDirRequest) -> Result<(), VaultStorageError> {
        self.run("removeDir", req).await
    }

    pub async fn rename(&self, req: RenameRequest) -> Result<(), VaultStorageError> {
        self.run("rename", req).await
    }
}

#[derive(Debug, Deserialize)]
struct PickFolderResponse {
    folder: FolderHandle,
}
