use tauri::{AppHandle, Runtime};

use crate::FileDropExt;

fn validated_token(value: &str) -> crate::Result<String> {
    let token = value.trim();
    if token.is_empty() {
        Err(crate::FileDropError::UnknownToken)
    } else {
        Ok(token.to_string())
    }
}

/// Resolve one opaque drop token to bytes.
///
/// The token was minted by the native drop backend (Android
/// `ClipData`/`content://` URIs); shared application code never sees the
/// underlying URI or path. Tokens expire after a successful read or an
/// explicit `release_drop_file`.
#[tauri::command]
pub async fn read_drop_file<R: Runtime>(
    app: AppHandle<R>,
    token: String,
) -> crate::Result<Vec<u8>> {
    let token = validated_token(&token)?;
    app.file_drop().read_drop_file(token)
}

/// Deterministic cleanup when an import fails or is cancelled. Releasing an
/// unknown token is a no-op so cancel paths stay infallible.
#[tauri::command]
pub async fn release_drop_file<R: Runtime>(
    app: AppHandle<R>,
    token: String,
) -> crate::Result<()> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    app.file_drop().release_drop_file(trimmed.to_string())
}
