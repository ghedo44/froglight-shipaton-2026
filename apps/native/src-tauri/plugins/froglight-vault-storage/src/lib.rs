mod commands;
#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;
mod models;
mod path;

use tauri::{plugin::{Builder, TauriPlugin}, Manager, Runtime};

#[cfg(desktop)]
use desktop::VaultStorage;
#[cfg(mobile)]
use mobile::VaultStorage;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("froglight-vault-storage")
        .setup(|app, api| {
            #[cfg(mobile)]
            let storage = mobile::init(app, api)?;
            #[cfg(desktop)]
            let storage = desktop::init(app, api)?;
            app.manage(storage);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::forget_folder,
            commands::list_folders,
            commands::read_dir,
            commands::stat,
            commands::read_file,
            commands::write_file,
            commands::mkdir,
            commands::remove_file,
            commands::remove_dir,
            commands::rename,
        ])
        .build()
}
