//! Froglight-owned purchase DTOs.
//!
//! These mirror the platform-neutral foundation contract
//! (`packages/foundation/src/purchases/contract.ts`) with camelCase JSON so
//! the TypeScript store can validate them unchanged. The native providers
//! (Swift RevenueCat client on iOS) produce exactly these shapes; Rust
//! validates them at the mobile boundary so a malformed native payload
//! becomes a structured error instead of a panic or a corrupt snapshot.

use serde::{Deserialize, Serialize};

/// Localized price. `amount_micros` is best-effort (absent when the store
/// does not report a numeric price); `formatted` is always authoritative.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePrice {
    pub formatted: String,
    pub currency_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount_micros: Option<i64>,
}

/// Subscription period. `None` means one-time/unknown — never guess.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NativePeriod {
    #[serde(rename = "week")]
    Week,
    #[serde(rename = "month")]
    Month,
    #[serde(rename = "twoMonths")]
    TwoMonths,
    #[serde(rename = "threeMonths")]
    ThreeMonths,
    #[serde(rename = "sixMonths")]
    SixMonths,
    #[serde(rename = "year")]
    Year,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProduct {
    pub id: String,
    pub title: String,
    pub description: String,
    pub price: NativePrice,
    pub period: Option<NativePeriod>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum NativePackageKind {
    #[serde(rename = "weekly")]
    Weekly,
    #[serde(rename = "monthly")]
    Monthly,
    #[serde(rename = "twoMonth")]
    TwoMonth,
    #[serde(rename = "threeMonth")]
    ThreeMonth,
    #[serde(rename = "sixMonth")]
    SixMonth,
    #[serde(rename = "annual")]
    Annual,
    #[serde(rename = "lifetime")]
    Lifetime,
    #[serde(rename = "custom")]
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePackage {
    pub id: String,
    pub kind: NativePackageKind,
    pub product: NativeProduct,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOffering {
    pub id: String,
    pub packages: Vec<NativePackage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEntitlementInfo {
    pub active: bool,
    pub product_id: Option<String>,
    pub expiration_date: Option<String>,
    pub will_renew: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCustomerState {
    pub app_user_id: String,
    #[serde(default)]
    pub active_entitlement_ids: Vec<String>,
    #[serde(default)]
    pub entitlements: std::collections::HashMap<String, NativeEntitlementInfo>,
}

/// Result of `purchase_package`. Cancellation is a first-class outcome —
/// never an error — so the webview can keep the paywall usable without an
/// alarming error message. `customer` is `None` only when the purchase was
/// cancelled before any customer state was available.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePurchaseResult {
    pub cancelled: bool,
    pub customer: Option<NativeCustomerState>,
}

/// Plugin configuration from `tauri.conf.json` (`plugins.froglight-purchases`).
///
/// Legacy setup-time fallback only. The canonical path is runtime
/// `configure` via Tauri IPC with `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY`
/// from `apps/native/.env` (see `apps/native/src/main.ts`).
///
/// Only the public RevenueCat SDK key (`appl_...`, `test_...`) belongs here
/// or in the Vite env. Secret keys (`sk_...`), App Store Connect private
/// keys, and webhook secrets must never enter this file — the key is public
/// by RevenueCat's model, everything else stays out of the repository.
///
/// The plugin registers with `Option<PurchasePluginConfig>` so an absent
/// section decodes to `None`: a missing key leaves the backend
/// unconfigured and commands fail fast with `NOT_CONFIGURED` instead of
/// failing app boot. A present-but-misshaped section fails plugin
/// initialization loudly so bad purchase configuration cannot hide.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasePluginConfig {
    #[serde(default)]
    pub api_key: Option<String>,
}

impl PurchasePluginConfig {
    pub fn configured_key(&self) -> Option<&str> {
        self.api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
    }
}

/// Arguments for `configure` (runtime path). Public SDK key only —
/// never a secret key. Tauri flattens this to `{ apiKey }` on the wire;
/// the struct documents the shape alongside the other wire types.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureArgs {
    pub api_key: String,
}

/// Arguments for `purchase_package`. Semantic identifiers only — the
/// webview never hands a product object back to native; the provider
/// resolves the RevenueCat package from the current offering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchasePackageArgs {
    pub offering_id: String,
    pub package_id: String,
}

/// Arguments for `log_in`. Must be a stable opaque Froglight account
/// identifier (never email, device id, vault path, or per-launch random).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInArgs {
    pub app_user_id: String,
}

impl NativeCustomerState {
    /// Minimal structural validation for payloads arriving from the mobile
    /// backend: an empty app user id means the provider is broken, and the
    /// webview must not seed from it.
    pub fn validate(&self) -> Result<(), crate::PurchaseError> {
        if self.app_user_id.is_empty() {
            return Err(crate::PurchaseError::unknown(
                "native host returned customer state without an app user id",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn customer() -> NativeCustomerState {
        NativeCustomerState {
            app_user_id: "anon-123".to_string(),
            active_entitlement_ids: vec!["pro".to_string()],
            entitlements: [(
                "pro".to_string(),
                NativeEntitlementInfo {
                    active: true,
                    product_id: Some("froglight_pro_annual".to_string()),
                    expiration_date: Some("2027-09-30T00:00:00.000Z".to_string()),
                    will_renew: Some(true),
                },
            )]
            .into_iter()
            .collect(),
        }
    }

    #[test]
    fn customer_state_uses_camel_case_contract() {
        let value = serde_json::to_value(customer()).expect("serializes");
        assert_eq!(value["appUserId"], "anon-123");
        assert_eq!(value["activeEntitlementIds"], serde_json::json!(["pro"]));
        assert_eq!(
            value["entitlements"]["pro"]["productId"],
            "froglight_pro_annual"
        );
        assert_eq!(
            value["entitlements"]["pro"]["expirationDate"],
            "2027-09-30T00:00:00.000Z"
        );
        assert_eq!(value["entitlements"]["pro"]["willRenew"], true);
    }

    #[test]
    fn offerings_round_trip_with_periods_and_kinds() {
        let offering = NativeOffering {
            id: "default".to_string(),
            packages: vec![NativePackage {
                id: "$rc_annual".to_string(),
                kind: NativePackageKind::Annual,
                product: NativeProduct {
                    id: "froglight_pro_annual".to_string(),
                    title: "Annual".to_string(),
                    description: "Annual sub".to_string(),
                    price: NativePrice {
                        formatted: "$49.99".to_string(),
                        currency_code: Some("USD".to_string()),
                        amount_micros: Some(49_990_000),
                    },
                    period: Some(NativePeriod::Year),
                },
            }],
        };
        let json = serde_json::to_value(&offering).expect("serializes");
        assert_eq!(json["packages"][0]["kind"], "annual");
        assert_eq!(json["packages"][0]["product"]["period"], "year");
        assert_eq!(
            json["packages"][0]["product"]["price"]["currencyCode"],
            "USD"
        );
        let back: NativeOffering = serde_json::from_value(json).expect("round-trips");
        assert_eq!(back, offering);
    }

    #[test]
    fn amount_micros_is_optional_and_omitted_when_absent() {
        let price = NativePrice {
            formatted: "£3.99".to_string(),
            currency_code: Some("GBP".to_string()),
            amount_micros: None,
        };
        let value = serde_json::to_value(price).expect("serializes");
        assert!(value.get("amountMicros").is_none());
    }

    #[test]
    fn plugin_config_accepts_public_key_and_absent_section() {
        let config: PurchasePluginConfig =
            serde_json::from_value(serde_json::json!({ "apiKey": "appl_test" }))
                .expect("decodes");
        assert_eq!(config.configured_key(), Some("appl_test"));
        assert!(PurchasePluginConfig::default().configured_key().is_none());
        // Absent section decodes to None (never a boot failure).
        let missing: Option<PurchasePluginConfig> =
            serde_json::from_value(serde_json::Value::Null).expect("decodes");
        assert!(missing.is_none());
    }

    #[test]
    fn configure_args_use_camel_case_key() {
        let args: ConfigureArgs =
            serde_json::from_value(serde_json::json!({ "apiKey": "test_abc" }))
                .expect("decodes");
        assert_eq!(args.api_key, "test_abc");
        let value = serde_json::to_value(&args).expect("serializes");
        assert_eq!(value["apiKey"], "test_abc");
    }

    #[test]
    fn empty_app_user_id_fails_validation() {
        let mut state = customer();
        state.app_user_id.clear();
        let err = state.validate().expect_err("must reject");
        assert_eq!(err.code(), "UNKNOWN");
    }

    #[test]
    fn purchase_result_models_cancellation_explicitly() {
        let cancelled = NativePurchaseResult {
            cancelled: true,
            customer: None,
        };
        let value = serde_json::to_value(&cancelled).expect("serializes");
        assert_eq!(value["cancelled"], true);
        assert!(value["customer"].is_null());
    }

    #[test]
    fn malformed_native_payloads_fail_to_deserialize() {
        assert!(serde_json::from_value::<NativeCustomerState>(
            serde_json::json!({ "appUserId": 42 })
        )
        .is_err());
        assert!(serde_json::from_value::<NativeCustomerState>(
            serde_json::json!(null)
        )
        .is_err());
    }
}
