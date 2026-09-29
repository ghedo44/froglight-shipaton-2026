use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::StylusExt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StylusInputContext {
    Default,
    Drawing,
    TextEntry,
}

#[tauri::command]
pub async fn set_input_context<R: Runtime>(
    app: AppHandle<R>,
    context: StylusInputContext,
) -> crate::Result<()> {
    app.stylus().set_input_context(context)
}

#[cfg(test)]
mod tests {
    use super::StylusInputContext;

    #[test]
    fn validates_input_context() {
        for (wire, value) in [
            ("default", StylusInputContext::Default),
            ("drawing", StylusInputContext::Drawing),
            ("text-entry", StylusInputContext::TextEntry),
        ] {
            let json = serde_json::to_string(wire).unwrap();
            assert_eq!(
                serde_json::from_str::<StylusInputContext>(&json).unwrap(),
                value
            );
            assert_eq!(serde_json::to_string(&value).unwrap(), json);
        }
        for malformed in ["\"unknown\"", "\"textEntry\"", "null", "42", "{}"] {
            assert!(serde_json::from_str::<StylusInputContext>(malformed).is_err());
        }
    }
}

/// Current native-host stylus capability state.
///
/// Returned as state via `get_capabilities` so JavaScript bootstrap can seed
/// `StylusService` after installing the event forwarder instead of relying
/// on a fire-and-forget load-time report that may arrive before the hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStylusCapabilities {
    pub available: bool,
    pub pressure: bool,
    pub tilt: bool,
    pub twist: bool,
    pub hover: bool,
    pub eraser: bool,
    pub barrel_button: bool,
    pub double_tap: bool,
    pub squeeze: bool,
}

/// Query the current native-host capability state.
#[tauri::command]
pub async fn get_capabilities<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<NativeStylusCapabilities> {
    app.stylus().get_capabilities()
}
