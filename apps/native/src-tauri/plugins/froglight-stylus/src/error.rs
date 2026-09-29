use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, StylusError>;

#[derive(Debug, thiserror::Error)]
pub enum StylusError {
    #[error("unsupported on this platform")]
    Unsupported,
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for StylusError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
