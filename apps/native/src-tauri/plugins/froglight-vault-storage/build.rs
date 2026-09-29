const COMMANDS: &[&str] = &[
    "pick_folder",
    "forget_folder",
    "list_folders",
    "read_dir",
    "stat",
    "read_file",
    "write_file",
    "mkdir",
    "remove_file",
    "remove_dir",
    "rename",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
