//! Froglight-owned purchase/entitlement provider.
//!
//! Platform-neutral customer state, offerings, and purchase operations
//! behind seven Tauri commands. RevenueCat is the initial iOS provider
//! (native SDK + StoreKit sheet, React-owned paywall); desktop reports
//! `UNSUPPORTED` and Android follows behind the same token.
//!
//! The plugin knows about entitlements, offerings, packages, and customer
//! state. It never decides what "Froglight Pro" means — that mapping lives
//! in the shared `PurchaseService` policy (`pro` entitlement).

#[cfg(desktop)]
mod desktop;
mod commands;
mod error;
#[cfg(mobile)]
mod mobile;
pub mod models;

use tauri::{
    plugin::{Builder, PluginApi, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(desktop)]
use desktop::Purchases;
#[cfg(mobile)]
use mobile::Purchases;

pub use commands::{
    configure, get_customer_info, get_offerings, log_in, log_out, purchase_package,
    restore_purchases,
};
pub use error::{PurchaseError, PurchaseErrorCode, Result};
pub use models::{
    ConfigureArgs, LogInArgs, NativeCustomerState, NativeEntitlementInfo, NativeOffering,
    NativePackage, NativePackageKind, NativePeriod, NativePrice, NativeProduct,
    NativePurchaseResult, PurchasePackageArgs, PurchasePluginConfig,
};

/// State accessor for the managed purchases handle.
pub trait PurchasesExt<R: Runtime> {
    fn purchases(&self) -> &Purchases<R>;
}

impl<R: Runtime, T: Manager<R>> PurchasesExt<R> for T {
    fn purchases(&self) -> &Purchases<R> {
        self.state::<Purchases<R>>().inner()
    }
}

/// Initializes the plugin.
///
/// The canonical RevenueCat public-key path is runtime `configure` via Tauri
/// IPC with `VITE_FROGLIGHT_REVENUECAT_PUBLIC_KEY` from `apps/native/.env`
/// (see `apps/native/src/main.ts`). Configuration
/// (`plugins.froglight-purchases.apiKey`, public SDK key only) remains as a
/// legacy setup-time fallback: a missing section decodes to `None` and
/// commands fail fast with `NOT_CONFIGURED` instead of failing app boot.
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<PurchasePluginConfig>> {
    Builder::new("froglight-purchases")
        .invoke_handler(tauri::generate_handler![
            commands::configure,
            commands::get_customer_info,
            commands::get_offerings,
            commands::purchase_package,
            commands::restore_purchases,
            commands::log_in,
            commands::log_out,
        ])
        .setup(
            |app: &AppHandle<R>, api: PluginApi<R, Option<PurchasePluginConfig>>| {
                #[cfg(mobile)]
                let purchases = {
                    let config = api.config().clone().unwrap_or_default();
                    mobile::init(app, api, config)?
                };
                #[cfg(desktop)]
                let purchases = desktop::init(app, api)?;
                app.manage(purchases);
                Ok(())
            },
        )
        .build()
}
