const COMMANDS: &[&str] = &["hide", "show", "get_state"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
