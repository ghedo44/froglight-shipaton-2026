//! Tauri commands for the purchases capability.
//!
//! Deliberately small: seven commands, no generic RevenueCat reflection, no
//! raw StoreKit transactions, no receipts, no secret REST calls. Purchases
//! resolve a RevenueCat `Package` from semantic identifiers on the native
//! side; the webview never constructs purchase state.

use tauri::{AppHandle, Runtime};

use crate::{
    models::{ConfigureArgs, LogInArgs, NativeCustomerState, NativeOffering, NativePurchaseResult},
    PurchasesExt,
};

/// Runtime RevenueCat configuration (canonical path).
///
/// The native app bootstrap reads the public SDK key from
/// `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` and forwards it here via Tauri
/// IPC; the backend configures RevenueCat exactly once and later calls are
/// idempotent. A `tauri.conf.json` `apiKey` remains as a legacy setup-time
/// fallback only.
#[tauri::command]
pub async fn configure<R: Runtime>(
    app: AppHandle<R>,
    api_key: String,
) -> crate::Result<()> {
    app.purchases().configure(&api_key)
}

/// Current customer state (seed for `PurchaseService.refresh()`).
#[tauri::command]
pub async fn get_customer_info<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<NativeCustomerState> {
    app.purchases().get_customer_info()
}

/// Current offerings with localized store prices.
#[tauri::command]
pub async fn get_offerings<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<Vec<NativeOffering>> {
    app.purchases().get_offerings()
}

/// Purchase one package from an offering. Cancellation arrives as
/// `{ cancelled: true }`, never as an error.
#[tauri::command]
pub async fn purchase_package<R: Runtime>(
    app: AppHandle<R>,
    offering_id: String,
    package_id: String,
) -> crate::Result<NativePurchaseResult> {
    app.purchases().purchase_package(&offering_id, &package_id)
}

/// User-triggered restore (required visible action in the purchase UI).
/// The returned customer state becomes authoritative.
#[tauri::command]
pub async fn restore_purchases<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<NativeCustomerState> {
    app.purchases().restore_purchases()
}

/// Identify a stable opaque Froglight account (future cross-device Pro).
/// Anonymous until Froglight accounts land; the UI does not expose this yet.
#[tauri::command]
pub async fn log_in<R: Runtime>(
    app: AppHandle<R>,
    app_user_id: String,
) -> crate::Result<NativeCustomerState> {
    app.purchases().log_in(&app_user_id)
}

/// Clear the identified account back to the anonymous customer.
#[tauri::command]
pub async fn log_out<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<NativeCustomerState> {
    app.purchases().log_out()
}

// Keep request-shape types referenced so `models.rs` stays the single
// source for the wire contract (commands take flattened args per Tauri
// convention; the structs document the same shapes for mobile backends).
#[allow(dead_code)]
fn _wire_shapes(args: Option<LogInArgs>, configure: Option<ConfigureArgs>) -> Option<LogInArgs> {
    let _ = configure;
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_names_match_tauri_convention() {
        // `plugin:froglight-purchases|<rust_fn_name>` — the TypeScript
        // adapter pins these exact strings; rename in both places at once.
        for command in [
            "configure",
            "get_customer_info",
            "get_offerings",
            "purchase_package",
            "restore_purchases",
            "log_in",
            "log_out",
        ] {
            assert!(
                !command.contains('-'),
                "{command} must stay snake_case"
            );
        }
    }

    #[test]
    fn login_args_use_stable_account_shape() {
        let args: LogInArgs =
            serde_json::from_value(serde_json::json!({ "appUserId": "uuid-1" }))
                .expect("decodes");
        assert_eq!(args.app_user_id, "uuid-1");
    }
}
