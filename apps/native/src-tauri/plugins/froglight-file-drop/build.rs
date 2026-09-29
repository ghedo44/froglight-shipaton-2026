const COMMANDS: &[&str] = &["read_drop_file", "release_drop_file"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
