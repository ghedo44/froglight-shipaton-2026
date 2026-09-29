//! Froglight-owned WebView default-action suppression.
//!
//! The native shell is a desktop application, not a browser tab: WebView
//! defaults such as reload, view-source, file-open, print dialogs, and the
//! platform context menu break the native illusion and can strand vault
//! state (e.g. an accidental reload drops in-memory session state).
//!
//! Behavior reference only (no dependency, no vendored code):
//! `ferreira-tb/tauri-plugin-prevent-default` (MIT). Froglight reimplements
//! the coverage as owned code: a Tauri initialization script suppresses the
//! defaults with `preventDefault()` (propagation untouched, so app handlers
//! keep working), plus optional Windows WebView2 settings below the script
//! layer.
//!
//! This crate is trusted-native host infrastructure. It exposes no IPC
//! commands, no permissions, and no SDK surface: community plugins cannot
//! reach it, weaken it, or observe it.

mod platform;
mod script;
mod shortcuts;

use bitflags::bitflags;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::Runtime;

pub use platform::PlatformOptions;
use script::render_init_script;

bitflags! {
    /// Which browser defaults the guard suppresses. Default is all.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct HardeningFlags: u16 {
        /// Find (`F3`, `Ctrl+F`, `Ctrl+G`, `Ctrl+Shift+G`).
        const FIND            = 1 << 0;
        /// Caret browsing (`F7`).
        const CARET_BROWSING  = 1 << 1;
        /// Developer tools (`Ctrl+Shift+I`).
        const DEV_TOOLS       = 1 << 2;
        /// Downloads (`Ctrl+J`).
        const DOWNLOADS       = 1 << 3;
        /// Focus move (`Shift+Tab`).
        const FOCUS_MOVE      = 1 << 4;
        /// Reload (`F5`, `Ctrl+F5`, `Shift+F5`, `Ctrl+R`, `Ctrl+Shift+R`).
        const RELOAD          = 1 << 5;
        /// View source (`Ctrl+U`).
        const SOURCE          = 1 << 6;
        /// File open (`Ctrl+O`).
        const OPEN            = 1 << 7;
        /// Print (`Ctrl+P`, `Ctrl+Shift+P`).
        const PRINT           = 1 << 8;
        /// Context menu (right click / long press).
        const CONTEXT_MENU    = 1 << 9;
    }
}

impl HardeningFlags {
    /// Keep `CONTEXT_MENU`, `DEV_TOOLS`, and `RELOAD` enabled in debug builds
    /// so development keeps its inspection/reload loop; release blocks all.
    pub fn debug() -> Self {
        Self::debug_for(cfg!(debug_assertions))
    }

    /// Pure policy behind [`HardeningFlags::debug`], kept separate so both
    /// branches are unit-testable without rebuilding under another profile.
    fn debug_for(is_debug_build: bool) -> Self {
        if is_debug_build {
            Self::all().difference(Self::CONTEXT_MENU | Self::DEV_TOOLS | Self::RELOAD)
        } else {
            Self::all()
        }
    }
}

impl Default for HardeningFlags {
    fn default() -> Self {
        Self::all()
    }
}

/// Configures which browser defaults the guard suppresses.
pub struct Builder {
    flags: HardeningFlags,
    platform: PlatformOptions,
}

impl Default for Builder {
    fn default() -> Self {
        Self {
            flags: HardeningFlags::default(),
            platform: PlatformOptions::native_defaults(),
        }
    }
}

impl Builder {
    /// Create a builder that suppresses every browser default.
    pub fn new() -> Self {
        Self::default()
    }

    /// Restrict suppression to `flags`.
    #[must_use]
    pub fn with_flags(mut self, flags: HardeningFlags) -> Self {
        self.flags = flags;
        self
    }

    /// Override the Windows WebView2 settings. Plain data on every
    /// platform so host composition stays uniform; applied only on
    /// Windows builds with the `platform-windows` feature.
    #[must_use]
    pub fn platform(mut self, options: PlatformOptions) -> Self {
        self.platform = options;
        self
    }

    /// Render the exact init script [`build`](Builder::build) installs.
    /// Public so hosts can snapshot the guarded surface in tests.
    pub fn init_script(&self) -> String {
        render_init_script(self.flags)
    }

    /// Build the Tauri plugin. The script is installed as a WebView
    /// initialization script, so it runs before any page script.
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let script = self.init_script();
        #[allow(unused_mut)]
        let mut builder = PluginBuilder::new("froglight-webview-hardening");

        #[cfg(all(target_os = "windows", feature = "platform-windows"))]
        {
            let options = self.platform;
            builder = builder.on_webview_ready(move |webview| {
                platform::apply_webview_settings(&webview, options.clone());
            });
        }
        // The native settings have no target off Windows; the documented
        // policy is still recorded in the builder for uniform host code.
        #[cfg(not(all(target_os = "windows", feature = "platform-windows")))]
        let _ = self.platform;

        builder.js_init_script(script).build()
    }
}

/// Initialize the plugin, suppressing every browser default.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

/// Debug-policy builder: inspection shortcuts stay enabled in debug builds
/// on every layer — flags keep context-menu/devtools/reload, and the
/// Windows WebView2 settings stay untouched so accelerator keys and
/// platform menus keep working in development.
fn debug_builder() -> Builder {
    Builder::new()
        .with_flags(HardeningFlags::debug())
        .platform(PlatformOptions::new())
}

/// Initialize the plugin with the [`HardeningFlags::debug`] policy:
/// inspection shortcuts stay enabled in debug builds, everything is
/// suppressed in release builds.
pub fn debug<R: Runtime>() -> TauriPlugin<R> {
    debug_builder().build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_policy_keeps_inspection_shortcuts_in_debug_builds() {
        assert_eq!(
            HardeningFlags::debug_for(true),
            HardeningFlags::all()
                .difference(HardeningFlags::CONTEXT_MENU | HardeningFlags::DEV_TOOLS | HardeningFlags::RELOAD)
        );
    }

    #[test]
    fn debug_policy_blocks_everything_in_release_builds() {
        assert_eq!(HardeningFlags::debug_for(false), HardeningFlags::all());
    }

    #[test]
    fn default_flags_block_everything() {
        assert_eq!(HardeningFlags::default(), HardeningFlags::all());
    }

    #[test]
    fn builder_renders_only_selected_flags() {
        let script = Builder::new().with_flags(HardeningFlags::FIND).init_script();
        assert!(script.contains("onKey('f3', {});"), "missing F3");
        assert!(!script.contains("onKey('p'"), "unexpected print binding");
        assert!(!script.contains("onPointer('"), "unexpected pointer binding");
    }

    #[test]
    fn builder_defaults_to_all_flags() {
        let script = Builder::new().init_script();
        assert!(script.contains("onKey('f3', {});"), "missing F3");
        assert!(
            script.contains("onKey('p', { ctrlKey: true });"),
            "missing print binding"
        );
        assert!(
            script.contains("onPointer('contextmenu');"),
            "missing context menu binding"
        );
    }

    #[test]
    fn debug_builder_relaxes_native_settings() {
        // Debug builds keep the inspection loop on every layer: the flags
        // tested above plus untouched WebView2 settings, so Windows dev
        // builds keep accelerator keys and platform menus.
        let builder = debug_builder();
        assert_eq!(builder.flags, HardeningFlags::debug());
        assert_eq!(builder.platform, PlatformOptions::new());
    }

    #[test]
    fn default_builder_hardens_native_settings() {
        assert_eq!(
            Builder::new().platform,
            PlatformOptions::native_defaults()
        );
    }
}
