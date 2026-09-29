//! Stable purchase error codes.
//!
//! Every expected failure is a [`PurchaseError`] carrying a machine-readable
//! `code` from the foundation contract — consumers match on `code` and never
//! parse messages. User cancellation is not an error and never produces a
//! `PurchaseError`; it travels as `cancelled: true` in
//! [`crate::NativePurchaseResult`]. Serialized as `{ code, message }` so the
//! TypeScript store (`normalizePurchaseError`) keeps the code across IPC.

use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, PurchaseError>;

/// Stable codes shared with `packages/foundation/src/purchases/errors.ts`.
/// Keep the two in sync; the webview matches on these strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurchaseErrorCode {
    NotConfigured,
    Network,
    StoreUnavailable,
    ProductUnavailable,
    PurchaseNotAllowed,
    InvalidOffering,
    InvalidPackage,
    ReceiptInvalid,
    Configuration,
    Unsupported,
    Unknown,
}

impl PurchaseErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            PurchaseErrorCode::NotConfigured => "NOT_CONFIGURED",
            PurchaseErrorCode::Network => "NETWORK",
            PurchaseErrorCode::StoreUnavailable => "STORE_UNAVAILABLE",
            PurchaseErrorCode::ProductUnavailable => "PRODUCT_UNAVAILABLE",
            PurchaseErrorCode::PurchaseNotAllowed => "PURCHASE_NOT_ALLOWED",
            PurchaseErrorCode::InvalidOffering => "INVALID_OFFERING",
            PurchaseErrorCode::InvalidPackage => "INVALID_PACKAGE",
            PurchaseErrorCode::ReceiptInvalid => "RECEIPT_INVALID",
            PurchaseErrorCode::Configuration => "CONFIGURATION",
            PurchaseErrorCode::Unsupported => "UNSUPPORTED",
            PurchaseErrorCode::Unknown => "UNKNOWN",
        }
    }

    /// Parse a wire code, returning `None` for unknown/future codes so
    /// callers can degrade to `UNKNOWN` instead of trusting a code the
    /// webview cannot match on.
    pub fn parse(code: &str) -> Option<PurchaseErrorCode> {
        Some(match code {
            "NOT_CONFIGURED" => PurchaseErrorCode::NotConfigured,
            "NETWORK" => PurchaseErrorCode::Network,
            "STORE_UNAVAILABLE" => PurchaseErrorCode::StoreUnavailable,
            "PRODUCT_UNAVAILABLE" => PurchaseErrorCode::ProductUnavailable,
            "PURCHASE_NOT_ALLOWED" => PurchaseErrorCode::PurchaseNotAllowed,
            "INVALID_OFFERING" => PurchaseErrorCode::InvalidOffering,
            "INVALID_PACKAGE" => PurchaseErrorCode::InvalidPackage,
            "RECEIPT_INVALID" => PurchaseErrorCode::ReceiptInvalid,
            "CONFIGURATION" => PurchaseErrorCode::Configuration,
            "UNSUPPORTED" => PurchaseErrorCode::Unsupported,
            "UNKNOWN" => PurchaseErrorCode::Unknown,
            _ => return None,
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PurchaseError {
    #[error("[{code}] {message}", code = .0.as_str(), message = .1)]
    Coded(PurchaseErrorCode, String),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl PurchaseError {
    pub fn new(code: PurchaseErrorCode, message: impl Into<String>) -> Self {
        PurchaseError::Coded(code, message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            PurchaseError::Coded(code, _) => code.as_str(),
            #[cfg(mobile)]
            PurchaseError::PluginInvoke(_) => PurchaseErrorCode::Unknown.as_str(),
        }
    }

    pub fn not_configured(message: impl Into<String>) -> Self {
        Self::new(PurchaseErrorCode::NotConfigured, message)
    }

    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(PurchaseErrorCode::Unknown, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(PurchaseErrorCode::Unsupported, message)
    }

    /// Map a mobile-plugin invocation failure to a stable error.
    ///
    /// The Swift backend rejects with `"CODE human message"` where `CODE`
    /// is one of the stable codes (see `FroglightPurchasesPlugin`). The
    /// leading token is trusted only when it parses as a known code;
    /// everything else — transport failures, serialization failures,
    /// future codes — degrades to `UNKNOWN` with the raw text preserved.
    #[cfg(mobile)]
    pub fn from_invoke(error: tauri::plugin::mobile::PluginInvokeError) -> Self {
        use tauri::plugin::mobile::PluginInvokeError;
        match &error {
            PluginInvokeError::InvokeRejected(response) => {
                if let Some(message) = response.message.as_deref() {
                    let mut parts = message.splitn(2, ' ');
                    if let Some(head) = parts.next() {
                        if let Some(code) = PurchaseErrorCode::parse(head) {
                            let rest = parts.next().unwrap_or("").trim();
                            let text = if rest.is_empty() {
                                format!("purchase request failed ({})", code.as_str())
                            } else {
                                rest.to_string()
                            };
                            return Self::new(code, text);
                        }
                    }
                    return Self::unknown(message.to_string());
                }
                Self::unknown(error.to_string())
            }
            _ => Self::unknown(error.to_string()),
        }
    }
}

#[derive(Serialize)]
struct CodedError<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for PurchaseError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        CodedError {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message_for_the_webview() {
        let error = PurchaseError::new(
            PurchaseErrorCode::InvalidPackage,
            "no such package",
        );
        let value = serde_json::to_value(&error).expect("serializes");
        assert_eq!(value["code"], "INVALID_PACKAGE");
        assert!(value["message"]
            .as_str()
            .expect("message")
            .contains("no such package"));
    }

    #[test]
    fn codes_round_trip_through_parse() {
        for code in [
            "NOT_CONFIGURED",
            "NETWORK",
            "STORE_UNAVAILABLE",
            "PRODUCT_UNAVAILABLE",
            "PURCHASE_NOT_ALLOWED",
            "INVALID_OFFERING",
            "INVALID_PACKAGE",
            "RECEIPT_INVALID",
            "CONFIGURATION",
            "UNSUPPORTED",
            "UNKNOWN",
        ] {
            assert_eq!(
                PurchaseErrorCode::parse(code).map(|c| c.as_str()),
                Some(code)
            );
        }
        assert_eq!(PurchaseErrorCode::parse("RC_FUTURE_CODE"), None);
        assert_eq!(PurchaseErrorCode::parse(""), None);
    }

    #[test]
    fn unsupported_and_not_configured_carry_stable_codes() {
        assert_eq!(
            PurchaseError::unsupported("nope").code(),
            "UNSUPPORTED"
        );
        assert_eq!(
            PurchaseError::not_configured("no key").code(),
            "NOT_CONFIGURED"
        );
    }
}
