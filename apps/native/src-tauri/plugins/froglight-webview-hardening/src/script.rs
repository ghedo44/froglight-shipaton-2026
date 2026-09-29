//! Init-script rendering for WebView default-action suppression.
//!
//! The [`render_init_script`] seam is the observable contract: given a flag
//! set it produces the exact JavaScript installed as the Tauri
//! initialization script. Tests pin the generated `onKey`/`onPointer` lines
//! rather than the guard skeleton, so the skeleton can evolve without
//! churning the behavioral spec.

use super::shortcuts::{bindings_for_group, KeyBinding, ALL_KEY_GROUPS};
use super::HardeningFlags;

/// Base guard skeleton. Placeholders are replaced with generated calls.
const GUARD_TEMPLATE: &str = include_str!("../assets/guard.js");

/// Render the initialization script for `flags`.
pub fn render_init_script(flags: HardeningFlags) -> String {
    let mut keys = String::new();
    for (flag, group) in ALL_KEY_GROUPS {
        if flags.contains(flag) {
            for binding in bindings_for_group(group) {
                keys.push_str(&render_key_binding(binding));
                keys.push('\n');
            }
        }
    }
    let pointer = render_pointer_bindings(flags);
    GUARD_TEMPLATE
        .replace("/*KEY_BINDINGS*/", keys.trim_end())
        .replace("/*POINTER_BINDINGS*/", pointer.trim_end())
}

/// Render one `onKey` call for `binding`.
fn render_key_binding(binding: &KeyBinding) -> String {
    let mut options = String::new();
    if binding.ctrl {
        options.push_str("ctrlKey: true, ");
    }
    if binding.shift {
        options.push_str("shiftKey: true, ");
    }
    if binding.alt {
        options.push_str("altKey: true, ");
    }
    if binding.meta {
        options.push_str("metaKey: true, ");
    }
    if options.ends_with(", ") {
        options.truncate(options.len() - 2);
        format!("onKey('{}', {{ {} }});", binding.key, options)
    } else {
        format!("onKey('{}', {{}});", binding.key)
    }
}

/// Render the pointer suppression lines for `flags`.
fn render_pointer_bindings(flags: HardeningFlags) -> String {
    if flags.contains(HardeningFlags::CONTEXT_MENU) {
        "onPointer('contextmenu');".to_owned()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_one_onkey_call_per_binding() {
        let script = render_init_script(HardeningFlags::FIND);
        assert!(
            script.contains("onKey('f3', {});"),
            "missing plain F3 binding in:\n{script}"
        );
        assert!(
            script.contains("onKey('f', { ctrlKey: true });"),
            "missing Ctrl+F binding in:\n{script}"
        );
        assert!(
            script.contains("onKey('g', { ctrlKey: true, shiftKey: true });"),
            "missing Ctrl+Shift+G binding in:\n{script}"
        );
    }

    #[test]
    fn leaves_no_template_placeholders_behind() {
        let script = render_init_script(HardeningFlags::all());
        assert!(!script.contains("/*KEY_BINDINGS*/"), "key placeholder leaked");
        assert!(
            !script.contains("/*POINTER_BINDINGS*/"),
            "pointer placeholder leaked"
        );
    }

    #[test]
    fn context_menu_flag_controls_the_pointer_binding() {
        let with_menu = render_init_script(HardeningFlags::CONTEXT_MENU);
        assert!(
            with_menu.contains("onPointer('contextmenu');"),
            "expected contextmenu suppression in:\n{with_menu}"
        );
        let without_menu =
            render_init_script(HardeningFlags::all().difference(HardeningFlags::CONTEXT_MENU));
        assert!(
            !without_menu.contains("onPointer('"),
            "unexpected pointer suppression in:\n{without_menu}"
        );
    }

    #[test]
    fn empty_flags_render_bare_guard() {
        let script = render_init_script(HardeningFlags::empty());
        assert!(!script.contains("onKey('"), "unexpected key binding");
        assert!(
            !script.contains("onPointer('"),
            "unexpected pointer binding"
        );
        assert!(
            script.contains("suppressedKeys"),
            "guard skeleton missing in:\n{script}"
        );
    }

    #[test]
    fn key_group_table_covers_every_keyboard_flag() {
        use super::super::shortcuts::ALL_KEY_GROUPS;

        // A flag added to HardeningFlags without a table entry (or vice
        // versa) must fail here rather than silently diverge.
        let mut covered = HardeningFlags::empty();
        for (flag, _) in ALL_KEY_GROUPS {
            assert!(
                !covered.contains(flag),
                "duplicate table entry for {flag:?}"
            );
            covered.insert(flag);
        }
        assert_eq!(
            covered,
            HardeningFlags::all().difference(HardeningFlags::CONTEXT_MENU)
        );
    }
}
