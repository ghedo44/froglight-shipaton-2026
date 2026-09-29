//! Mobile purchases backend.
//!
//! Thin forwarder over the iOS Swift plugin (`FroglightPurchasesPlugin`),
//! which owns RevenueCat configuration, DTO translation, and
//! `PurchasesDelegate` customer-info updates. Rust validates identifiers
//! and payloads at this boundary; commerce semantics stay native.
//!
//! Android has no Kotlin provider yet (later slice behind the same token):
//! the Android backend reports `UNSUPPORTED` from every command instead of
//! failing setup, so the app still boots and the capability graph resolves
//! uniformly on every host.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::PurchasePluginConfig;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_froglight_purchases);

#[cfg(target_os = "ios")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
    config: PurchasePluginConfig,
) -> crate::Result<Purchases<R>> {
    let handle = api.register_ios_plugin(init_plugin_froglight_purchases)?;
    let purchases = Purchases {
        handle: Some(handle),
        configured: AtomicBool::new(false),
    };
    // Legacy fallback: a public SDK key in `tauri.conf.json` configures
    // RevenueCat during setup. The canonical path is runtime `configure`
    // via Tauri IPC with `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` from the
    // native app env (see `apps/native/src/main.ts`). A missing key leaves
    // the backend unconfigured (commands report NOT_CONFIGURED); a rejected
    // key fails setup loudly so bad purchase configuration cannot hide.
    if let Some(key) = config.configured_key() {
        purchases.configure(key)?;
    }
    Ok(purchases)
}

#[cfg(target_os = "android")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
    _config: PurchasePluginConfig,
) -> crate::Result<Purchases<R>> {
    Ok(Purchases {
        handle: None,
        configured: AtomicBool::new(false),
    })
}

/// Access to the purchases native APIs.
pub struct Purchases<R: Runtime> {
    handle: Option<PluginHandle<R>>,
    configured: AtomicBool,
}

impl<R: Runtime> Purchases<R> {
    #[cfg(target_os = "ios")]
    pub fn configure(&self, api_key: &str) -> crate::Result<()> {
        let key = api_key.trim();
        if key.is_empty() {
            return Err(crate::PurchaseError::new(
                crate::PurchaseErrorCode::Configuration,
                "RevenueCat API key must not be empty",
            ));
        }
        // Idempotent: a second configure is a no-op so repeated bootstrap
        // (e.g. HMR, re-seed) never re-initializes the RevenueCat SDK.
        if self.configured.load(Ordering::SeqCst) {
            return Ok(());
        }
        let handle = self.handle.as_ref().ok_or_else(|| {
            crate::PurchaseError::not_configured("purchases backend is unavailable")
        })?;
        handle
            .run_mobile_plugin::<()>(
                "configure",
                serde_json::json!({ "apiKey": key }),
            )
            .map_err(crate::PurchaseError::from_invoke)?;
        self.configured.store(true, Ordering::SeqCst);
        Ok(())
    }

    #[cfg(target_os = "android")]
    pub fn configure(&self, api_key: &str) -> crate::Result<()> {
        if api_key.trim().is_empty() {
            return Err(crate::PurchaseError::new(
                crate::PurchaseErrorCode::Configuration,
                "RevenueCat API key must not be empty",
            ));
        }
        Err(crate::PurchaseError::unsupported(
            "purchases are not supported on Android yet",
        ))
    }

    fn require_ios(&self) -> crate::Result<&PluginHandle<R>> {
        #[cfg(target_os = "android")]
        {
            let _ = self;
            return Err(crate::PurchaseError::unsupported(
                "purchases are not supported on Android yet",
            ));
        }
        #[cfg(not(target_os = "android"))]
        {
            let handle = self.handle.as_ref().ok_or_else(|| {
                crate::PurchaseError::not_configured("purchases backend is unavailable")
            })?;
            if !self.configured.load(Ordering::SeqCst) {
                return Err(crate::PurchaseError::not_configured(
                    "RevenueCat API key is not configured",
                ));
            }
            Ok(handle)
        }
    }

    fn invoke<T: DeserializeOwned>(
        &self,
        command: &str,
        payload: serde_json::Value,
    ) -> crate::Result<T> {
        let handle = self.require_ios()?;
        handle
            .run_mobile_plugin(command, payload)
            .map_err(crate::PurchaseError::from_invoke)
    }

    pub fn get_customer_info(&self) -> crate::Result<crate::NativeCustomerState> {
        let state: crate::NativeCustomerState =
            self.invoke("getCustomerInfo", serde_json::Value::Null)?;
        state.validate()?;
        Ok(state)
    }

    pub fn get_offerings(&self) -> crate::Result<Vec<crate::NativeOffering>> {
        self.invoke("getOfferings", serde_json::Value::Null)
    }

    pub fn purchase_package(
        &self,
        offering_id: &str,
        package_id: &str,
    ) -> crate::Result<crate::NativePurchaseResult> {
        if offering_id.trim().is_empty() {
            return Err(crate::PurchaseError::new(
                crate::PurchaseErrorCode::InvalidOffering,
                "offering id must not be empty",
            ));
        }
        if package_id.trim().is_empty() {
            return Err(crate::PurchaseError::new(
                crate::PurchaseErrorCode::InvalidPackage,
                "package id must not be empty",
            ));
        }
        let result: crate::NativePurchaseResult = self.invoke(
            "purchasePackage",
            serde_json::json!({ "offeringId": offering_id, "packageId": package_id }),
        )?;
        if let Some(customer) = result.customer.as_ref() {
            customer.validate()?;
        }
        Ok(result)
    }

    pub fn restore_purchases(&self) -> crate::Result<crate::NativeCustomerState> {
        let state: crate::NativeCustomerState =
            self.invoke("restorePurchases", serde_json::Value::Null)?;
        state.validate()?;
        Ok(state)
    }

    pub fn log_in(&self, app_user_id: &str) -> crate::Result<crate::NativeCustomerState> {
        if app_user_id.trim().is_empty() {
            return Err(crate::PurchaseError::new(
                crate::PurchaseErrorCode::Configuration,
                "app user id must not be empty",
            ));
        }
        let state: crate::NativeCustomerState = self.invoke(
            "logIn",
            serde_json::json!({ "appUserId": app_user_id }),
        )?;
        state.validate()?;
        Ok(state)
    }

    pub fn log_out(&self) -> crate::Result<crate::NativeCustomerState> {
        let state: crate::NativeCustomerState =
            self.invoke("logOut", serde_json::Value::Null)?;
        state.validate()?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_keys_mean_unconfigured() {
        for key in ["", "   "] {
            let config = PurchasePluginConfig {
                api_key: Some(key.to_string()),
            };
            assert!(config.configured_key().is_none());
        }
    }

    #[test]
    fn public_key_trims() {
        let config = PurchasePluginConfig {
            api_key: Some("  appl_x  ".to_string()),
        };
        assert_eq!(config.configured_key(), Some("appl_x"));
    }

    #[test]
    fn empty_runtime_key_is_configuration_error() {
        let backend = Purchases::<tauri::Wry> {
            handle: None,
            configured: AtomicBool::new(false),
        };
        for key in ["", "   "] {
            assert_eq!(backend.configure(key).unwrap_err().code(), "CONFIGURATION");
        }
    }

    #[cfg(target_os = "ios")]
    #[test]
    fn runtime_configure_is_idempotent_once_configured() {
        // An already-configured backend never touches the mobile plugin
        // again (no handle needed): repeated bootstrap is a no-op.
        let backend = Purchases::<tauri::Wry> {
            handle: None,
            configured: AtomicBool::new(true),
        };
        assert!(backend.configure("  appl_x  ").is_ok());
        assert!(backend.configured.load(Ordering::SeqCst));
    }

    #[cfg(target_os = "android")]
    #[test]
    fn android_runtime_configure_stays_unsupported() {
        let backend = Purchases::<tauri::Wry> {
            handle: None,
            configured: AtomicBool::new(false),
        };
        assert_eq!(
            backend.configure("appl_x").unwrap_err().code(),
            "UNSUPPORTED"
        );
    }
}
