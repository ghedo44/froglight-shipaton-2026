use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{error::VaultStorageError, models::*};

// `fn() -> R` keeps the state Send + Sync for any Runtime: tauri >= 2.11 no longer bounds
// Runtime by Send/Sync, so a plain PhantomData<R> marker fails Manager::manage/state bounds.
pub struct VaultStorage<R: Runtime>(std::marker::PhantomData<fn() -> R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<VaultStorage<R>, tauri::Error> {
    Ok(VaultStorage(std::marker::PhantomData))
}

impl<R: Runtime> VaultStorage<R> {
    pub async fn pick_folder(&self) -> Result<FolderHandle, VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn forget_folder(&self, _folder_id: String) -> Result<(), VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn list_folders(&self) -> Result<Vec<FolderHandle>, VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn read_dir(&self, _req: ReadDirRequest) -> Result<Vec<DirEntry>, VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn stat(&self, _req: StatRequest) -> Result<FileStat, VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn read_file(
        &self,
        _req: ReadFileRequest,
    ) -> Result<ReadFileResponse, VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn write_file(&self, _req: WriteFileRequest) -> Result<(), VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn mkdir(&self, _req: MkdirRequest) -> Result<(), VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn remove_file(&self, _req: RemoveFileRequest) -> Result<(), VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn remove_dir(&self, _req: RemoveDirRequest) -> Result<(), VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
    pub async fn rename(&self, _req: RenameRequest) -> Result<(), VaultStorageError> {
        Err(VaultStorageError::Unsupported)
    }
}
