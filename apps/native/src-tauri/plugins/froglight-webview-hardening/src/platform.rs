//! Windows WebView2 settings applied below the script layer.
//!
//! The injected guard script suppresses browser defaults at the DOM level on
//! every platform. On Windows the native WebView2 control has its own
//! accelerator keys, context menus, and script dialogs that run beneath the
//! page: disabling them at the settings level is what makes the shell feel
//! native rather than merely quiet.
//!
//! [`PlatformOptions`] is plain data on every platform so host composition
//! code stays uniform; only [`apply_webview_settings`] is Windows-gated.

/// Native WebView2 toggles. Every field defaults to unset (`None`), which
/// leaves the corresponding WebView2 setting untouched.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlatformOptions {
    browser_accelerator_keys: Option<bool>,
    default_context_menus: Option<bool>,
    default_script_dialogs: Option<bool>,
}

impl PlatformOptions {
    /// Create options with every setting untouched.
    pub fn new() -> Self {
        Self::default()
    }

    /// Froglight's native-shell policy: no browser accelerator keys, no
    /// platform context menus, no default script dialogs. Everything else
    /// stays untouched.
    pub fn native_defaults() -> Self {
        Self::new()
            .browser_accelerator_keys(false)
            .default_context_menus(false)
            .default_script_dialogs(false)
    }

    /// Whether browser-specific accelerator keys are enabled.
    pub fn browser_accelerator_keys(mut self, enabled: bool) -> Self {
        self.browser_accelerator_keys = Some(enabled);
        self
    }

    /// Whether the default WebView context menus are shown.
    pub fn default_context_menus(mut self, enabled: bool) -> Self {
        self.default_context_menus = Some(enabled);
        self
    }

    /// Whether the WebView renders default JavaScript dialogs.
    pub fn default_script_dialogs(mut self, enabled: bool) -> Self {
        self.default_script_dialogs = Some(enabled);
        self
    }
}

/// Apply `options` to a live WebView2 control. Windows-only: the COM
/// settings interfaces do not exist on other platforms. `options` is taken
/// by value because `with_webview` requires a `'static` closure, so borrowed
/// settings cannot be captured. Every failure is deliberately ignored
/// (`let _`): hardening must never break window creation, and the DOM-level
/// guard still applies if a setting fails.
#[cfg(all(target_os = "windows", feature = "platform-windows"))]
pub(crate) fn apply_webview_settings<R>(webview: &tauri::Webview<R>, options: PlatformOptions)
where
    R: tauri::Runtime,
{
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;

    let _ = webview.with_webview(move |platform_webview| unsafe {
        let Ok(core) = platform_webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };

        if let Some(default_context_menus) = options.default_context_menus {
            let _ = settings.SetAreDefaultContextMenusEnabled(default_context_menus);
        }

        if let Some(default_script_dialogs) = options.default_script_dialogs {
            let _ = settings.SetAreDefaultScriptDialogsEnabled(default_script_dialogs);
        }

        if let Some(browser_accelerator_keys) = options.browser_accelerator_keys {
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(browser_accelerator_keys);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_options_leave_everything_untouched() {
        let options = PlatformOptions::new();
        assert_eq!(options.browser_accelerator_keys, None);
        assert_eq!(options.default_context_menus, None);
        assert_eq!(options.default_script_dialogs, None);
    }

    #[test]
    fn native_defaults_disable_browser_chrome() {
        let options = PlatformOptions::native_defaults();
        assert_eq!(options.browser_accelerator_keys, Some(false));
        assert_eq!(options.default_context_menus, Some(false));
        assert_eq!(options.default_script_dialogs, Some(false));
    }
}
