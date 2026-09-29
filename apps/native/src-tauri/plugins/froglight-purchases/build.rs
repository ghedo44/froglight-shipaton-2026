const COMMANDS: &[&str] = &[
    "configure",
    "get_customer_info",
    "get_offerings",
    "purchase_package",
    "restore_purchases",
    "log_in",
    "log_out",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
