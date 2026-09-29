const COMMANDS: &[&str] = &["get_capabilities", "set_input_context"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
