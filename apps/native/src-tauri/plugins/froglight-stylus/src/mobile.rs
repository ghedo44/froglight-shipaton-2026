use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_froglight_stylus);

#[cfg(target_os = "android")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Stylus<R>> {
    let handle = api.register_android_plugin("io.froglight.stylus", "FroglightStylusPlugin")?;
    Ok(Stylus(handle))
}

#[cfg(target_os = "ios")]
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Stylus<R>> {
    let handle = api.register_ios_plugin(init_plugin_froglight_stylus)?;
    Ok(Stylus(handle))
}

/// Access to the stylus native APIs (stateful capabilities + events).
pub struct Stylus<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Stylus<R> {
    pub fn set_input_context(&self, context: crate::StylusInputContext) -> crate::Result<()> {
        #[cfg(target_os = "ios")]
        {
            let _: () = self
                .0
                .run_mobile_plugin("setInputContext", serde_json::json!({ "context": context }))?;
        }
        #[cfg(not(target_os = "ios"))]
        let _ = context;
        Ok(())
    }

    /// Query the current native-host capability state (never fails open:
    /// transport errors propagate so JS keeps defaults instead of trusting
    /// a partial report).
    pub fn get_capabilities(&self) -> crate::Result<crate::NativeStylusCapabilities> {
        let value: crate::NativeStylusCapabilities =
            self.0.run_mobile_plugin("getCapabilities", ())?;
        Ok(value)
    }
}
