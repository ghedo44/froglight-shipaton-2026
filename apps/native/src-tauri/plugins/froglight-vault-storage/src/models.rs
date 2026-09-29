use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderHandle {
    pub id: String,
    pub name: Option<String>,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mime_type: Option<String>,
    pub last_modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mime_type: Option<String>,
    pub last_modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Mobile-only request type (constructed in `mobile.rs`, cfg mobile).
#[allow(dead_code)]
pub struct FolderIdRequest {
    pub folder_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Mobile-only response type (deserialized in `mobile.rs`, cfg mobile).
#[allow(dead_code)]
pub(crate) struct ListFoldersResponse {
    pub folders: Vec<FolderHandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDirRequest {
    pub folder_id: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
// Mobile-only response type (deserialized in `mobile.rs`, cfg mobile).
#[allow(dead_code)]
pub(crate) struct ReadDirResponse {
    pub entries: Vec<DirEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatRequest {
    pub folder_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileRequest {
    pub folder_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResponse {
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileRequest {
    pub folder_id: String,
    pub path: String,
    /// Base64-encoded bytes for the mobile plugin bridge.
    pub data: String,
    pub expected_checksum: Option<String>,
    #[serde(skip_deserializing)]
    pub data_path: Option<String>,
    pub mime_type: Option<String>,
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirRequest {
    pub folder_id: String,
    pub path: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveFileRequest {
    pub folder_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDirRequest {
    pub folder_id: String,
    pub path: String,
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
    pub folder_id: String,
    pub from_path: String,
    pub to_path: String,
}
