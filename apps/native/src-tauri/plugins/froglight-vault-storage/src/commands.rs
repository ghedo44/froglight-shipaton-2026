use base64::Engine as _;
use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::{error::VaultStorageError, models::*, path::normalize_relative_path, VaultStorage};

const VAULT_WRITE_METADATA_HEADER: &str = "x-froglight-vault-write";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteFileMetadata {
    folder_id: String,
    path: String,
    expected_checksum: Option<String>,
}

fn raw_write_file_request(
    metadata: &str,
    bytes: &[u8],
) -> Result<WriteFileRequest, VaultStorageError> {
    let metadata_bytes = base64::engine::general_purpose::STANDARD
        .decode(metadata)
        .map_err(|_| VaultStorageError::InvalidArgument("write metadata is not base64".into()))?;
    if base64::engine::general_purpose::STANDARD.encode(&metadata_bytes) != metadata {
        return Err(VaultStorageError::InvalidArgument(
            "write metadata must use canonical base64".into(),
        ));
    }
    let metadata: WriteFileMetadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|_| VaultStorageError::InvalidArgument("write metadata is invalid".into()))?;
    Ok(WriteFileRequest {
        folder_id: metadata.folder_id,
        path: metadata.path,
        #[cfg(not(target_os = "ios"))]
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        #[cfg(target_os = "ios")]
        data: String::new(),
        expected_checksum: metadata.expected_checksum,
        data_path: None,
        mime_type: None,
        recursive: None,
    })
}

fn write_file_request(
    request: tauri::ipc::Request<'_>,
) -> Result<WriteFileRequest, VaultStorageError> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            let metadata = request
                .headers()
                .get(VAULT_WRITE_METADATA_HEADER)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    VaultStorageError::InvalidArgument("write request is missing metadata".into())
                })?;
            raw_write_file_request(metadata, bytes)
        }
        tauri::ipc::InvokeBody::Json(value) => {
            let req = value.get("req").cloned().unwrap_or_else(|| value.clone());
            serde_json::from_value(req)
                .map_err(|_| VaultStorageError::InvalidArgument("write request is invalid".into()))
        }
    }
}

#[cfg(test)]
mod write_transport_tests {
    use super::*;

    #[test]
    fn raw_write_metadata_and_all_byte_values_round_trip() {
        let metadata = base64::engine::general_purpose::STANDARD
            .encode(r#"{"folderId":"folder","path":"notes/🖋️.bin"}"#.as_bytes());
        let bytes = (0..=255).collect::<Vec<u8>>();
        let request = raw_write_file_request(&metadata, &bytes).unwrap();
        assert_eq!(request.folder_id, "folder");
        assert_eq!(request.path, "notes/🖋️.bin");
        #[cfg(not(target_os = "ios"))]
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(request.data)
                .unwrap(),
            bytes
        );
        #[cfg(target_os = "ios")]
        assert!(request.data.is_empty());
    }

    #[test]
    fn invalid_or_noncanonical_raw_metadata_is_rejected() {
        assert!(raw_write_file_request("%%%=", &[1, 2]).is_err());
        assert!(raw_write_file_request("AB==", &[1, 2]).is_err());
        let valid_encoding_of_invalid_json =
            base64::engine::general_purpose::STANDARD.encode(b"{} ");
        assert!(raw_write_file_request(&valid_encoding_of_invalid_json, &[1, 2]).is_err());
    }
}

fn validated_folder_id(value: &str) -> Result<String, VaultStorageError> {
    let value = value.trim();
    if value.is_empty() {
        Err(VaultStorageError::InvalidArgument(
            "folderId must not be empty".into(),
        ))
    } else {
        Ok(value.to_string())
    }
}

fn required_path(value: &str) -> Result<String, VaultStorageError> {
    let path = normalize_relative_path(value)?;
    if path.is_empty() {
        Err(VaultStorageError::InvalidPath(
            "path must not be empty".into(),
        ))
    } else {
        Ok(path)
    }
}

#[tauri::command]
pub async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<FolderHandle, VaultStorageError> {
    app.state::<VaultStorage<R>>().inner().pick_folder().await
}

#[tauri::command]
pub async fn forget_folder<R: Runtime>(
    app: AppHandle<R>,
    folder_id: String,
) -> Result<(), VaultStorageError> {
    app.state::<VaultStorage<R>>()
        .inner()
        .forget_folder(validated_folder_id(&folder_id)?)
        .await
}

#[tauri::command]
pub async fn list_folders<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<FolderHandle>, VaultStorageError> {
    app.state::<VaultStorage<R>>().inner().list_folders().await
}

#[tauri::command]
pub async fn read_dir<R: Runtime>(
    app: AppHandle<R>,
    mut req: ReadDirRequest,
) -> Result<Vec<DirEntry>, VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = req
        .path
        .take()
        .map(|path| normalize_relative_path(&path))
        .transpose()?
        .filter(|path| !path.is_empty());
    app.state::<VaultStorage<R>>().inner().read_dir(req).await
}

#[tauri::command]
pub async fn stat<R: Runtime>(
    app: AppHandle<R>,
    mut req: StatRequest,
) -> Result<FileStat, VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = required_path(&req.path)?;
    app.state::<VaultStorage<R>>().inner().stat(req).await
}

#[tauri::command]
pub async fn read_file<R: Runtime>(
    app: AppHandle<R>,
    mut req: ReadFileRequest,
) -> Result<ReadFileResponse, VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = required_path(&req.path)?;
    app.state::<VaultStorage<R>>().inner().read_file(req).await
}

#[tauri::command]
pub async fn write_file<R: Runtime>(
    app: AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), VaultStorageError> {
    #[cfg(target_os = "ios")]
    let transport_bytes = {
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err(VaultStorageError::InvalidArgument(
                "binary write body required".into(),
            ));
        };
        bytes.clone()
    };
    let mut req = write_file_request(request)?;
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = required_path(&req.path)?;
    #[cfg(target_os = "ios")]
    let transport = {
        use std::io::Write;
        tauri::async_runtime::spawn_blocking(move || {
            let mut file = tempfile::NamedTempFile::new()
                .map_err(|error| VaultStorageError::Io(error.to_string()))?;
            file.write_all(&transport_bytes)
                .map_err(|error| VaultStorageError::Io(error.to_string()))?;
            Ok::<_, VaultStorageError>(file)
        })
        .await
        .map_err(|error| VaultStorageError::Io(error.to_string()))??
    };
    #[cfg(target_os = "ios")]
    {
        req.data_path = Some(transport.path().to_string_lossy().into_owned());
    }
    app.state::<VaultStorage<R>>().inner().write_file(req).await
}

#[tauri::command]
pub async fn mkdir<R: Runtime>(
    app: AppHandle<R>,
    mut req: MkdirRequest,
) -> Result<(), VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = required_path(&req.path)?;
    app.state::<VaultStorage<R>>().inner().mkdir(req).await
}

#[tauri::command]
pub async fn remove_file<R: Runtime>(
    app: AppHandle<R>,
    mut req: RemoveFileRequest,
) -> Result<(), VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = required_path(&req.path)?;
    app.state::<VaultStorage<R>>()
        .inner()
        .remove_file(req)
        .await
}

#[tauri::command]
pub async fn remove_dir<R: Runtime>(
    app: AppHandle<R>,
    mut req: RemoveDirRequest,
) -> Result<(), VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.path = required_path(&req.path)?;
    app.state::<VaultStorage<R>>().inner().remove_dir(req).await
}

#[tauri::command]
pub async fn rename<R: Runtime>(
    app: AppHandle<R>,
    mut req: RenameRequest,
) -> Result<(), VaultStorageError> {
    req.folder_id = validated_folder_id(&req.folder_id)?;
    req.from_path = required_path(&req.from_path)?;
    req.to_path = required_path(&req.to_path)?;
    if req.from_path == req.to_path {
        return Err(VaultStorageError::InvalidArgument(
            "rename source and destination must differ".into(),
        ));
    }
    app.state::<VaultStorage<R>>().inner().rename(req).await
}
