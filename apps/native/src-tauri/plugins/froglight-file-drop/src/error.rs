use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, FileDropError>;

#[derive(Debug, thiserror::Error)]
pub enum FileDropError {
    #[error("unsupported on this platform")]
    Unsupported,
    #[error("unknown or expired drop token")]
    UnknownToken,
    #[error("could not read dropped file: {0}")]
    Io(String),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for FileDropError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
