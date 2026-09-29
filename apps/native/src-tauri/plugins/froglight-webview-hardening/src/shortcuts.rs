//! Flag-to-shortcut table for WebView default-action suppression.
//!
//! The table mirrors the browser-default coverage of the reference plugin
//! (`ferreira-tb/tauri-plugin-prevent-default`): the
//! *behavioral coverage* (which key combinations count as browser defaults)
//! is the compatibility surface being reproduced. Key names are stored
//! lowercase because the injected guard normalizes `event.key` the same way.

/// One keyboard combination whose browser-default action should be suppressed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyBinding {
    /// Lowercase `KeyboardEvent.key` value, e.g. `"f3"` or `"f"`.
    pub key: &'static str,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
}

impl KeyBinding {
    const fn plain(key: &'static str) -> Self {
        Self {
            key,
            ctrl: false,
            shift: false,
            alt: false,
            meta: false,
        }
    }

    const fn ctrl(key: &'static str) -> Self {
        Self {
            key,
            ctrl: true,
            shift: false,
            alt: false,
            meta: false,
        }
    }

    const fn ctrl_shift(key: &'static str) -> Self {
        Self {
            key,
            ctrl: true,
            shift: true,
            alt: false,
            meta: false,
        }
    }

    const fn shift(key: &'static str) -> Self {
        Self {
            key,
            ctrl: false,
            shift: true,
            alt: false,
            meta: false,
        }
    }
}

/// Flag bits in declaration order. The `u16` values are an internal detail;
///
/// [`ALL_KEY_GROUPS`] is the single flag-to-group mapping shared by the
/// script renderer, so a new group cannot be added to one table and
/// forgotten in the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuppressedGroup {
    Find,
    CaretBrowsing,
    DevTools,
    Downloads,
    FocusMove,
    Reload,
    Source,
    Open,
    Print,
}

/// All keyboard bindings suppressed when `group` is enabled, in stable order.
pub fn bindings_for_group(group: SuppressedGroup) -> &'static [KeyBinding] {
    match group {
        SuppressedGroup::Find => &FIND_BINDINGS,
        SuppressedGroup::CaretBrowsing => &CARET_BROWSING_BINDINGS,
        SuppressedGroup::DevTools => &DEV_TOOLS_BINDINGS,
        SuppressedGroup::Downloads => &DOWNLOADS_BINDINGS,
        // Shift+Tab moves focus out of the WebView; inside the app focus is
        // owned by the workbench, so the browser default is suppressed.
        SuppressedGroup::FocusMove => &FOCUS_MOVE_BINDINGS,
        SuppressedGroup::Reload => &RELOAD_BINDINGS,
        SuppressedGroup::Source => &SOURCE_BINDINGS,
        SuppressedGroup::Open => &OPEN_BINDINGS,
        SuppressedGroup::Print => &PRINT_BINDINGS,
    }
}

/// Flag-to-group mapping in bit order, covering every keyboard group. The
/// single pointer group (`CONTEXT_MENU`) has no keyboard bindings and is
/// handled separately by the script renderer.
pub const ALL_KEY_GROUPS: [(super::HardeningFlags, SuppressedGroup); 9] = [
    (super::HardeningFlags::FIND, SuppressedGroup::Find),
    (
        super::HardeningFlags::CARET_BROWSING,
        SuppressedGroup::CaretBrowsing,
    ),
    (super::HardeningFlags::DEV_TOOLS, SuppressedGroup::DevTools),
    (super::HardeningFlags::DOWNLOADS, SuppressedGroup::Downloads),
    (
        super::HardeningFlags::FOCUS_MOVE,
        SuppressedGroup::FocusMove,
    ),
    (super::HardeningFlags::RELOAD, SuppressedGroup::Reload),
    (super::HardeningFlags::SOURCE, SuppressedGroup::Source),
    (super::HardeningFlags::OPEN, SuppressedGroup::Open),
    (super::HardeningFlags::PRINT, SuppressedGroup::Print),
];

const FIND_BINDINGS: [KeyBinding; 4] = [
    KeyBinding::plain("f3"),
    KeyBinding::ctrl("f"),
    KeyBinding::ctrl("g"),
    KeyBinding::ctrl_shift("g"),
];

const CARET_BROWSING_BINDINGS: [KeyBinding; 1] = [KeyBinding::plain("f7")];

const DEV_TOOLS_BINDINGS: [KeyBinding; 1] = [KeyBinding::ctrl_shift("i")];

const DOWNLOADS_BINDINGS: [KeyBinding; 1] = [KeyBinding::ctrl("j")];

const FOCUS_MOVE_BINDINGS: [KeyBinding; 1] = [KeyBinding::shift("tab")];

const RELOAD_BINDINGS: [KeyBinding; 5] = [
    KeyBinding::plain("f5"),
    KeyBinding::ctrl("f5"),
    KeyBinding::shift("f5"),
    KeyBinding::ctrl("r"),
    KeyBinding::ctrl_shift("r"),
];

const SOURCE_BINDINGS: [KeyBinding; 1] = [KeyBinding::ctrl("u")];

const OPEN_BINDINGS: [KeyBinding; 1] = [KeyBinding::ctrl("o")];

const PRINT_BINDINGS: [KeyBinding; 2] = [
    KeyBinding::ctrl("p"),
    KeyBinding::ctrl_shift("p"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_group_covers_browser_find_shortcuts() {
        assert_eq!(
            bindings_for_group(SuppressedGroup::Find),
            &[
                KeyBinding::plain("f3"),
                KeyBinding::ctrl("f"),
                KeyBinding::ctrl("g"),
                KeyBinding::ctrl_shift("g"),
            ]
        );
    }

    #[test]
    fn single_key_groups_cover_one_binding_each() {
        assert_eq!(
            bindings_for_group(SuppressedGroup::CaretBrowsing),
            &[KeyBinding::plain("f7")]
        );
        assert_eq!(
            bindings_for_group(SuppressedGroup::DevTools),
            &[KeyBinding::ctrl_shift("i")]
        );
        assert_eq!(
            bindings_for_group(SuppressedGroup::Downloads),
            &[KeyBinding::ctrl("j")]
        );
        assert_eq!(
            bindings_for_group(SuppressedGroup::FocusMove),
            &[KeyBinding::shift("tab")]
        );
        assert_eq!(
            bindings_for_group(SuppressedGroup::Source),
            &[KeyBinding::ctrl("u")]
        );
        assert_eq!(
            bindings_for_group(SuppressedGroup::Open),
            &[KeyBinding::ctrl("o")]
        );
    }

    #[test]
    fn reload_group_covers_all_reload_variants() {
        assert_eq!(
            bindings_for_group(SuppressedGroup::Reload),
            &[
                KeyBinding::plain("f5"),
                KeyBinding::ctrl("f5"),
                KeyBinding::shift("f5"),
                KeyBinding::ctrl("r"),
                KeyBinding::ctrl_shift("r"),
            ]
        );
    }

    #[test]
    fn print_group_covers_print_and_system_print() {
        assert_eq!(
            bindings_for_group(SuppressedGroup::Print),
            &[KeyBinding::ctrl("p"), KeyBinding::ctrl_shift("p")]
        );
    }
}
