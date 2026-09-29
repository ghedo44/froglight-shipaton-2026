use serde::Serialize;
use thiserror::Error;

pub const NATIVE_ERROR_PREFIX: &str = "FROGLIGHT_VAULT_ERROR:";

#[derive(Debug, Error)]
pub enum VaultStorageError {
    #[error("unsupported on this platform")]
    Unsupported,
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("folder not found: {0}")]
    FolderNotFound(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("not a directory: {0}")]
    NotDirectory(String),
    #[error("is a directory: {0}")]
    IsDirectory(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("cancelled")]
    Cancelled,
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("stale bookmark: {0}")]
    StaleBookmark(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("native error: {0}")]
    Native(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
}

impl VaultStorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported => "UNSUPPORTED",
            Self::InvalidPath(_) => "INVALID_PATH",
            Self::FolderNotFound(_) => "FOLDER_NOT_FOUND",
            Self::NotFound(_) => "NOT_FOUND",
            Self::AlreadyExists(_) => "ALREADY_EXISTS",
            Self::NotDirectory(_) => "NOT_DIRECTORY",
            Self::IsDirectory(_) => "IS_DIRECTORY",
            Self::Conflict(_) => "CONFLICT",
            Self::PermissionDenied(_) => "PERMISSION_DENIED",
            Self::Cancelled => "CANCELLED",
            Self::InvalidArgument(_) => "INVALID_ARGUMENT",
            Self::StaleBookmark(_) => "STALE_BOOKMARK",
            Self::Io(_) => "IO_ERROR",
            Self::Native(_) => "NATIVE_ERROR",
        }
    }

    pub fn payload(&self) -> ErrorPayload {
        ErrorPayload {
            code: self.code().to_string(),
            message: self.to_string(),
        }
    }

    // Mobile-only helpers: used by `mobile.rs` (cfg mobile). On desktop builds
    // they are dead code, but they are part of the mobile error contract.
    #[allow(dead_code)]
    pub fn from_code_message(code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        match code {
            "UNSUPPORTED" => Self::Unsupported,
            "INVALID_PATH" => Self::InvalidPath(message),
            "FOLDER_NOT_FOUND" => Self::FolderNotFound(message),
            "NOT_FOUND" => Self::NotFound(message),
            "ALREADY_EXISTS" => Self::AlreadyExists(message),
            "NOT_DIRECTORY" => Self::NotDirectory(message),
            "IS_DIRECTORY" => Self::IsDirectory(message),
            "CONFLICT" => Self::Conflict(message),
            "PERMISSION_DENIED" => Self::PermissionDenied(message),
            "CANCELLED" => Self::Cancelled,
            "INVALID_ARGUMENT" => Self::InvalidArgument(message),
            "STALE_BOOKMARK" => Self::StaleBookmark(message),
            "IO_ERROR" => Self::Io(message),
            "NATIVE_ERROR" => Self::Native(message),
            _ => Self::Native(message),
        }
    }

    #[allow(dead_code)]
    pub fn from_native_message(message: &str) -> Self {
        if let Some(payload) = message
            .split_once(NATIVE_ERROR_PREFIX)
            .map(|(_, payload)| payload)
            .or_else(|| message.strip_prefix(NATIVE_ERROR_PREFIX))
        {
            let mut parts = payload.splitn(2, ':');
            let code = parts.next().unwrap_or("NATIVE_ERROR");
            let detail = parts.next().unwrap_or("native command failed").trim();
            return Self::from_code_message(code, detail);
        }
        Self::Native(message.to_string())
    }
}

impl serde::Serialize for VaultStorageError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.payload().serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_portable_contract() {
        assert_eq!(VaultStorageError::Unsupported.code(), "UNSUPPORTED");
        assert_eq!(VaultStorageError::InvalidPath("x".into()).code(), "INVALID_PATH");
        assert_eq!(VaultStorageError::FolderNotFound("x".into()).code(), "FOLDER_NOT_FOUND");
        assert_eq!(VaultStorageError::NotFound("x".into()).code(), "NOT_FOUND");
        assert_eq!(VaultStorageError::AlreadyExists("x".into()).code(), "ALREADY_EXISTS");
        assert_eq!(VaultStorageError::NotDirectory("x".into()).code(), "NOT_DIRECTORY");
        assert_eq!(VaultStorageError::IsDirectory("x".into()).code(), "IS_DIRECTORY");
        assert_eq!(VaultStorageError::Conflict("x".into()).code(), "CONFLICT");
        assert_eq!(VaultStorageError::PermissionDenied("x".into()).code(), "PERMISSION_DENIED");
        assert_eq!(VaultStorageError::Cancelled.code(), "CANCELLED");
        assert_eq!(VaultStorageError::InvalidArgument("x".into()).code(), "INVALID_ARGUMENT");
        assert_eq!(VaultStorageError::StaleBookmark("x".into()).code(), "STALE_BOOKMARK");
        assert_eq!(VaultStorageError::Io("x".into()).code(), "IO_ERROR");
        assert_eq!(VaultStorageError::Native("x".into()).code(), "NATIVE_ERROR");
    }

    #[test]
    fn native_message_round_trip_preserves_quota_and_permission_codes() {
        for code in ["QUOTA_EXCEEDED", "PERMISSION_DENIED", "CANCELLED", "STALE_BOOKMARK"] {
            let message = format!("{NATIVE_ERROR_PREFIX}{code}:detail");
            let err = VaultStorageError::from_native_message(&message);
            // Unknown portable codes fall back to Native, but the payload prefix
            // must survive the round trip for the TS bridge to map them.
            let payload = err.payload();
            assert!(!payload.message.is_empty(), "code {code} must keep a message");
        }
        let quota = VaultStorageError::from_code_message("IO_ERROR", "ENOSPC: no space");
        assert_eq!(quota.code(), "IO_ERROR");
    }

    #[test]
    fn stale_bookmark_maps_to_permission_denied_in_ts_bridge() {
        // The TS bridge (`tauri-vault.ts`) maps STALE_BOOKMARK → PERMISSION_DENIED.
        // This test pins the Rust side of that contract.
        assert_eq!(VaultStorageError::StaleBookmark("x".into()).code(), "STALE_BOOKMARK");
    }
}
