//! Desktop purchases backend.
//!
//! Desktop v1 has no commerce provider: every command returns a clean
//! `UNSUPPORTED` instead of panicking or presenting a mobile purchase API.
//! The managed no-op handle keeps the capability graph uniform on every
//! host; desktop web-billing flows (if any) arrive as a later provider.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

// `fn() -> R` keeps the state Send + Sync for any Runtime: tauri >= 2.11 no
// longer bounds Runtime by Send/Sync, so a plain PhantomData<R> marker fails
// Manager::manage/state bounds.
pub struct Purchases<R: Runtime>(std::marker::PhantomData<fn() -> R>);

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Purchases<R>, tauri::Error> {
    Ok(Purchases(std::marker::PhantomData))
}

impl<R: Runtime> Purchases<R> {
    fn unsupported<T>() -> crate::Result<T> {
        Err(crate::PurchaseError::unsupported(
            "purchases are not supported on this host",
        ))
    }

    pub fn configure(&self, _api_key: &str) -> crate::Result<()> {
        Self::unsupported()
    }

    pub fn get_customer_info(&self) -> crate::Result<crate::NativeCustomerState> {
        Self::unsupported()
    }

    pub fn get_offerings(&self) -> crate::Result<Vec<crate::NativeOffering>> {
        Self::unsupported()
    }

    pub fn purchase_package(
        &self,
        _offering_id: &str,
        _package_id: &str,
    ) -> crate::Result<crate::NativePurchaseResult> {
        Self::unsupported()
    }

    pub fn restore_purchases(&self) -> crate::Result<crate::NativeCustomerState> {
        Self::unsupported()
    }

    pub fn log_in(&self, _app_user_id: &str) -> crate::Result<crate::NativeCustomerState> {
        Self::unsupported()
    }

    pub fn log_out(&self) -> crate::Result<crate::NativeCustomerState> {
        Self::unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend<R: Runtime>() -> Purchases<R> {
        Purchases(std::marker::PhantomData)
    }

    #[test]
    fn desktop_commands_report_unsupported() {
        assert_eq!(
            backend::<tauri::Wry>().configure("appl_x").unwrap_err().code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            backend::<tauri::Wry>().get_customer_info().unwrap_err().code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            backend::<tauri::Wry>().get_offerings().unwrap_err().code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            backend::<tauri::Wry>()
                .purchase_package("default", "$rc_annual")
                .unwrap_err()
                .code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            backend::<tauri::Wry>().restore_purchases().unwrap_err().code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            backend::<tauri::Wry>().log_in("user-1").unwrap_err().code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            backend::<tauri::Wry>().log_out().unwrap_err().code(),
            "UNSUPPORTED"
        );
    }

    #[test]
    fn unsupported_serializes_with_stable_code() {
        let error = backend::<tauri::Wry>()
            .get_offerings()
            .expect_err("unsupported");
        let value = serde_json::to_value(&error).expect("serializes");
        assert_eq!(value["code"], "UNSUPPORTED");
    }
}
