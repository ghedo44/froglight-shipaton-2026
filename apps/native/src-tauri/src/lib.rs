use base64::Engine as _;
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;

type VaultIoJob = Box<dyn FnOnce() + Send>;
static VAULT_IO: std::sync::OnceLock<std::sync::mpsc::SyncSender<VaultIoJob>> =
    std::sync::OnceLock::new();

async fn vault_io<T: Send + 'static>(
    work: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    let queue = VAULT_IO.get_or_init(|| {
        let (send, receive) = std::sync::mpsc::sync_channel::<VaultIoJob>(64);
        std::thread::Builder::new()
            .name("froglight-vault-io".into())
            .spawn(move || {
                for job in receive {
                    job();
                }
            })
            .expect("could not start vault I/O executor");
        send
    });
    let (send, receive) = tokio::sync::oneshot::channel();
    let started = std::time::Instant::now();
    queue
        .try_send(Box::new(move || {
            let queued = started.elapsed();
            let operation = std::time::Instant::now();
            let result = work();
            log::trace!(
                "vault_io queue_us={} operation_us={}",
                queued.as_micros(),
                operation.elapsed().as_micros()
            );
            let _ = send.send(result);
        }))
        .map_err(|_| VaultCommandError::new("IO", "vault I/O queue is full or unavailable"))?;
    receive
        .await
        .map_err(|_| VaultCommandError::new("IO", "vault I/O executor stopped"))?
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct VaultRecord {
    root: PathBuf,
    name: String,
    location: String,
    last_opened_at: u64,
    recent: bool,
}

#[derive(Default)]
struct NativeVaultStateInner {
    records: HashMap<String, VaultRecord>,
}

type NativeVaultState = Mutex<NativeVaultStateInner>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultDescriptor {
    id: String,
    name: String,
    location: String,
    last_opened_at: u64,
}

#[derive(Debug, Serialize)]
struct VaultCommandError {
    code: &'static str,
    message: String,
}

type CommandResult<T> = Result<T, VaultCommandError>;

impl VaultCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
struct VaultEntry {
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStat {
    path: String,
    kind: &'static str,
    size: u64,
    modified_millis: Option<u64>,
}

#[tauri::command]
#[cfg(desktop)]
async fn native_vault_pick_directory(
    app: AppHandle,
    _state: State<'_, NativeVaultState>,
    register_recent: bool,
) -> CommandResult<Option<VaultDescriptor>> {
    let picker_app = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        picker_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|error| VaultCommandError::new("IO", error.to_string()))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| VaultCommandError::new("UNSUPPORTED", error.to_string()))?;
    vault_io(move || {
        register_root(&app.state::<NativeVaultState>(), path, register_recent).map(Some)
    })
    .await
}

#[tauri::command]
#[cfg(mobile)]
async fn native_vault_pick_directory(
    _app: AppHandle,
    _state: State<'_, NativeVaultState>,
    _register_recent: bool,
) -> CommandResult<Option<VaultDescriptor>> {
    Err(VaultCommandError::new(
        "UNSUPPORTED",
        "native folder selection is not available on this platform",
    ))
}

#[tauri::command]
async fn native_vault_create(
    app: AppHandle,
    parent_id: String,
    name: String,
) -> CommandResult<VaultDescriptor> {
    vault_io(move || {
        native_vault_create_blocking(&app.state::<NativeVaultState>(), parent_id, name)
    })
    .await
}

#[tauri::command]
async fn native_vault_demo(app: AppHandle) -> CommandResult<VaultDescriptor> {
    vault_io(move || native_vault_demo_blocking(app.clone(), &app.state::<NativeVaultState>()))
        .await
}

#[tauri::command]
async fn native_vault_list_recent(app: AppHandle) -> CommandResult<Vec<VaultDescriptor>> {
    vault_io(move || native_vault_list_recent_blocking(&app.state::<NativeVaultState>())).await
}

#[tauri::command]
async fn native_vault_mark_opened(app: AppHandle, id: String) -> CommandResult<()> {
    vault_io(move || native_vault_mark_opened_blocking(&app.state::<NativeVaultState>(), id)).await
}

#[tauri::command]
async fn native_vault_forget(app: AppHandle, id: String) -> CommandResult<()> {
    vault_io(move || native_vault_forget_blocking(&app.state::<NativeVaultState>(), id)).await
}

#[tauri::command]
async fn native_vault_stat(
    app: AppHandle,
    vault_id: String,
    path: String,
) -> CommandResult<VaultStat> {
    vault_io(move || native_vault_stat_blocking(&app.state::<NativeVaultState>(), vault_id, path))
        .await
}

#[tauri::command]
async fn native_vault_list(
    app: AppHandle,
    vault_id: String,
    path: String,
) -> CommandResult<Vec<VaultEntry>> {
    vault_io(move || native_vault_list_blocking(&app.state::<NativeVaultState>(), vault_id, path))
        .await
}

#[tauri::command]
async fn native_vault_create_directory(
    app: AppHandle,
    vault_id: String,
    path: String,
) -> CommandResult<()> {
    vault_io(move || {
        native_vault_create_directory_blocking(&app.state::<NativeVaultState>(), vault_id, path)
    })
    .await
}

#[tauri::command]
async fn native_vault_read(
    app: AppHandle,
    vault_id: String,
    path: String,
) -> CommandResult<tauri::ipc::Response> {
    vault_io(move || native_vault_read_blocking(&app.state::<NativeVaultState>(), vault_id, path))
        .await
        .map(tauri::ipc::Response::new)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeWriteMetadata {
    vault_id: String,
    path: String,
    expected_checksum: Option<String>,
}

#[tauri::command]
async fn native_vault_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> CommandResult<()> {
    let metadata = request
        .headers()
        .get("x-froglight-vault-write")
        .and_then(|header| header.to_str().ok())
        .ok_or_else(|| VaultCommandError::new("INVALID_PATH", "missing write metadata"))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(metadata)
        .map_err(|_| VaultCommandError::new("INVALID_PATH", "invalid write metadata"))?;
    let metadata: NativeWriteMetadata = serde_json::from_slice(&decoded)
        .map_err(|_| VaultCommandError::new("INVALID_PATH", "invalid write metadata"))?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err(VaultCommandError::new(
            "INVALID_PATH",
            "binary write body required",
        ));
    };
    let data = data.clone();
    vault_io(move || {
        if let Some(expected) = metadata.expected_checksum {
            let current = native_vault_read_blocking(
                &app.state::<NativeVaultState>(),
                metadata.vault_id.clone(),
                metadata.path.clone(),
            )?;
            if fnv_checksum(&current) != expected {
                return Err(VaultCommandError::new(
                    "CONFLICT",
                    "vault file changed since it was opened",
                ));
            }
        }
        native_vault_write_blocking(
            &app.state::<NativeVaultState>(),
            metadata.vault_id,
            metadata.path,
            data,
        )
    })
    .await
}

fn fnv_checksum(bytes: &[u8]) -> String {
    let mut hash = 0x811c9dc5u32;
    for byte in bytes {
        hash = (hash ^ u32::from(*byte)).wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

#[tauri::command]
async fn native_vault_remove(app: AppHandle, vault_id: String, path: String) -> CommandResult<()> {
    vault_io(move || native_vault_remove_blocking(&app.state::<NativeVaultState>(), vault_id, path))
        .await
}

#[tauri::command]
async fn native_vault_move(
    app: AppHandle,
    vault_id: String,
    from: String,
    to: String,
) -> CommandResult<()> {
    vault_io(move || {
        native_vault_move_blocking(&app.state::<NativeVaultState>(), vault_id, from, to)
    })
    .await
}

fn native_vault_create_blocking(
    state: &NativeVaultState,
    parent_id: String,
    name: String,
) -> CommandResult<VaultDescriptor> {
    validate_folder_name(&name)?;
    let parent = root_for(&state, &parent_id)?;
    let target = parent.join(&name);
    fs::create_dir(&target).map_err(|error| map_io(error, "could not create vault"))?;
    register_root(&state, target, true)
}

// The bundled demo lives in the application's private data directory on every
// native platform. No folder picker or access to external user files is needed.
fn native_vault_demo_blocking(
    app: AppHandle,
    state: &NativeVaultState,
) -> CommandResult<VaultDescriptor> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| VaultCommandError::new("IO", error.to_string()))?
        .join("Asteria — Aerospace Studio");
    fs::create_dir_all(&root).map_err(|error| map_io(error, "could not create demo directory"))?;
    register_root(&state, root, true)
}

fn native_vault_list_recent_blocking(
    state: &NativeVaultState,
) -> CommandResult<Vec<VaultDescriptor>> {
    let locked = lock_state(&state)?;
    let mut records = locked
        .records
        .iter()
        .filter(|(_, record)| record.recent)
        .map(|(id, record)| descriptor(id, record))
        .collect::<Vec<_>>();
    records.sort_by_key(|record| std::cmp::Reverse(record.last_opened_at));
    Ok(records)
}

fn native_vault_mark_opened_blocking(state: &NativeVaultState, id: String) -> CommandResult<()> {
    let mut locked = lock_state(&state)?;
    let record = locked
        .records
        .get_mut(&id)
        .ok_or_else(|| VaultCommandError::new("NOT_FOUND", "unknown native vault"))?;
    record.last_opened_at = now_millis();
    record.recent = true;
    Ok(())
}

fn native_vault_forget_blocking(state: &NativeVaultState, id: String) -> CommandResult<()> {
    let mut locked = lock_state(&state)?;
    if let Some(record) = locked.records.get_mut(&id) {
        record.recent = false;
    }
    Ok(())
}

fn native_vault_stat_blocking(
    state: &NativeVaultState,
    vault_id: String,
    path: String,
) -> CommandResult<VaultStat> {
    let root = root_for(&state, &vault_id)?;
    let target = resolve(&root, &path)?;
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| map_io(error, "could not stat vault resource"))?;
    reject_symlink(&metadata)?;
    let directory = metadata.is_dir();
    Ok(VaultStat {
        path,
        kind: if directory { "directory" } else { "file" },
        size: if directory { 0 } else { metadata.len() },
        modified_millis: if directory {
            None
        } else {
            metadata.modified().ok().and_then(system_time_millis)
        },
    })
}

fn native_vault_list_blocking(
    state: &NativeVaultState,
    vault_id: String,
    path: String,
) -> CommandResult<Vec<VaultEntry>> {
    let root = root_for(&state, &vault_id)?;
    let target = resolve(&root, &path)?;
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| map_io(error, "could not list vault directory"))?;
    reject_symlink(&metadata)?;
    if !metadata.is_dir() {
        return Err(VaultCommandError::new(
            "NOT_DIRECTORY",
            "vault resource is not a directory",
        ));
    }
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(target).map_err(|error| map_io(error, "could not list vault directory"))?
    {
        let entry = entry.map_err(|error| map_io(error, "could not read vault directory entry"))?;
        let metadata = entry
            .file_type()
            .map_err(|error| map_io(error, "could not inspect vault directory entry"))?;
        if metadata.is_symlink() {
            continue;
        }
        entries.push(VaultEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            },
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

fn native_vault_create_directory_blocking(
    state: &NativeVaultState,
    vault_id: String,
    path: String,
) -> CommandResult<()> {
    if path.is_empty() {
        return Err(VaultCommandError::new(
            "ALREADY_EXISTS",
            "the vault root already exists",
        ));
    }
    let root = root_for(&state, &vault_id)?;
    let target = resolve_for_create(&root, &path)?;
    fs::create_dir(target).map_err(|error| map_io(error, "could not create vault directory"))
}

fn native_vault_read_blocking(
    state: &NativeVaultState,
    vault_id: String,
    path: String,
) -> CommandResult<Vec<u8>> {
    if path.is_empty() {
        return Err(VaultCommandError::new(
            "IS_DIRECTORY",
            "cannot read the vault root",
        ));
    }
    let root = root_for(&state, &vault_id)?;
    let target = resolve(&root, &path)?;
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| map_io(error, "could not inspect vault resource"))?;
    reject_symlink(&metadata)?;
    if metadata.is_dir() {
        return Err(VaultCommandError::new(
            "IS_DIRECTORY",
            "vault resource is a directory",
        ));
    }
    fs::read(target).map_err(|error| map_io(error, "could not read vault resource"))
}

fn native_vault_write_blocking(
    state: &NativeVaultState,
    vault_id: String,
    path: String,
    data: Vec<u8>,
) -> CommandResult<()> {
    if path.is_empty() {
        return Err(VaultCommandError::new(
            "IS_DIRECTORY",
            "cannot write the vault root",
        ));
    }
    let root = root_for(&state, &vault_id)?;
    let target = resolve_for_create(&root, &path)?;
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        reject_symlink(&metadata)?;
        if metadata.is_dir() {
            return Err(VaultCommandError::new(
                "IS_DIRECTORY",
                "vault resource is a directory",
            ));
        }
    }
    let parent = target
        .parent()
        .ok_or_else(|| VaultCommandError::new("INVALID_PATH", "vault resource has no parent"))?;
    let temporary = parent.join(format!(
        ".froglight-tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> CommandResult<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| map_io(error, "could not create temporary vault resource"))?;
        file.write_all(&data)
            .map_err(|error| map_io(error, "could not write vault resource"))?;
        file.sync_all()
            .map_err(|error| map_io(error, "could not flush vault resource"))?;
        drop(file);
        fs::rename(&temporary, &target)
            .map_err(|error| map_io(error, "could not replace vault resource"))?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| map_io(error, "could not flush vault directory"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn native_vault_remove_blocking(
    state: &NativeVaultState,
    vault_id: String,
    path: String,
) -> CommandResult<()> {
    if path.is_empty() {
        return Err(VaultCommandError::new(
            "CONFLICT",
            "the vault root may not be removed",
        ));
    }
    let root = root_for(&state, &vault_id)?;
    let target = resolve(&root, &path)?;
    let metadata = fs::symlink_metadata(&target)
        .map_err(|error| map_io(error, "could not inspect vault resource"))?;
    reject_symlink(&metadata)?;
    if metadata.is_dir() {
        fs::remove_dir(target).map_err(|error| {
            if matches!(error.kind(), std::io::ErrorKind::DirectoryNotEmpty) {
                VaultCommandError::new("CONFLICT", "vault directory is not empty")
            } else {
                map_io(error, "could not remove vault directory")
            }
        })
    } else {
        fs::remove_file(target).map_err(|error| map_io(error, "could not remove vault resource"))
    }
}

fn native_vault_move_blocking(
    state: &NativeVaultState,
    vault_id: String,
    from: String,
    to: String,
) -> CommandResult<()> {
    if from.is_empty() {
        return Err(VaultCommandError::new(
            "CONFLICT",
            "the vault root may not be moved",
        ));
    }
    if to.is_empty() || to.starts_with(&format!("{from}/")) {
        return Err(VaultCommandError::new(
            "CONFLICT",
            "invalid vault move target",
        ));
    }
    let root = root_for(&state, &vault_id)?;
    let source = resolve(&root, &from)?;
    let source_metadata = fs::symlink_metadata(&source)
        .map_err(|error| map_io(error, "could not inspect move source"))?;
    reject_symlink(&source_metadata)?;
    let target = resolve_for_create(&root, &to)?;
    if target.exists() {
        return Err(VaultCommandError::new(
            "CONFLICT",
            "move target already exists",
        ));
    }
    fs::rename(source, target).map_err(|error| map_io(error, "could not move vault resource"))
}

fn register_root(
    state: &NativeVaultState,
    root: PathBuf,
    recent: bool,
) -> CommandResult<VaultDescriptor> {
    let canonical = fs::canonicalize(&root)
        .map_err(|error| map_io(error, "could not open selected vault directory"))?;
    if !canonical.is_dir() {
        return Err(VaultCommandError::new(
            "NOT_DIRECTORY",
            "selected vault is not a directory",
        ));
    }
    let mut locked = lock_state(state)?;
    if let Some((id, record)) = locked
        .records
        .iter_mut()
        .find(|(_, record)| record.root == canonical)
    {
        if recent {
            record.recent = true;
            record.last_opened_at = now_millis();
        }
        return Ok(descriptor(id, record));
    }
    let id = format!("native-vault-{}", uuid::Uuid::new_v4());
    let name = canonical
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Vault".to_string());
    let record = VaultRecord {
        root: canonical.clone(),
        name,
        location: canonical.to_string_lossy().into_owned(),
        last_opened_at: now_millis(),
        recent,
    };
    let result = descriptor(&id, &record);
    locked.records.insert(id, record);
    Ok(result)
}

fn descriptor(id: &str, record: &VaultRecord) -> VaultDescriptor {
    VaultDescriptor {
        id: id.to_string(),
        name: record.name.clone(),
        location: record.location.clone(),
        last_opened_at: record.last_opened_at,
    }
}

fn root_for(state: &NativeVaultState, id: &str) -> CommandResult<PathBuf> {
    lock_state(state)?
        .records
        .get(id)
        .map(|record| record.root.clone())
        .ok_or_else(|| VaultCommandError::new("NOT_FOUND", "unknown native vault"))
}

fn lock_state<'a>(
    state: &'a NativeVaultState,
) -> CommandResult<std::sync::MutexGuard<'a, NativeVaultStateInner>> {
    state
        .lock()
        .map_err(|_| VaultCommandError::new("IO", "native vault state is unavailable"))
}

fn resolve(root: &Path, logical: &str) -> CommandResult<PathBuf> {
    let segments = validate_workspace_path(logical)?;
    let mut current = root.to_path_buf();
    for (index, segment) in segments.iter().enumerate() {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                reject_symlink(&metadata)?;
                if index + 1 < segments.len() && !metadata.is_dir() {
                    return Err(VaultCommandError::new(
                        "NOT_DIRECTORY",
                        "vault path crosses a file",
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(map_io(error, "vault resource does not exist"));
            }
            Err(error) => return Err(map_io(error, "could not resolve vault path")),
        }
    }
    Ok(current)
}

fn resolve_for_create(root: &Path, logical: &str) -> CommandResult<PathBuf> {
    let segments = validate_workspace_path(logical)?;
    if segments.is_empty() {
        return Err(VaultCommandError::new(
            "INVALID_PATH",
            "vault root is not a resource path",
        ));
    }
    let parent_logical = segments[..segments.len() - 1].join("/");
    let parent = resolve(root, &parent_logical)?;
    let metadata = fs::symlink_metadata(&parent)
        .map_err(|error| map_io(error, "vault resource parent does not exist"))?;
    reject_symlink(&metadata)?;
    if !metadata.is_dir() {
        return Err(VaultCommandError::new(
            "NOT_DIRECTORY",
            "vault resource parent is not a directory",
        ));
    }
    Ok(parent.join(segments[segments.len() - 1]))
}

fn validate_workspace_path(path: &str) -> CommandResult<Vec<&str>> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    if path.starts_with('/') || path.ends_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(VaultCommandError::new(
            "INVALID_PATH",
            "invalid portable workspace path",
        ));
    }
    let segments = path.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(VaultCommandError::new(
            "INVALID_PATH",
            "invalid portable workspace path",
        ));
    }
    Ok(segments)
}

fn validate_folder_name(name: &str) -> CommandResult<()> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(VaultCommandError::new(
            "INVALID_PATH",
            "invalid vault folder name",
        ));
    }
    Ok(())
}

fn reject_symlink(metadata: &fs::Metadata) -> CommandResult<()> {
    if metadata.file_type().is_symlink() {
        Err(VaultCommandError::new(
            "UNSUPPORTED",
            "symlinks are not supported inside a vault",
        ))
    } else {
        Ok(())
    }
}

/// Stable file name for one document's disposable derived cache record.
///
/// FNV-1a 64-bit hex keeps arbitrary document ids (paths, notebook page
/// composites) free of path separators while staying stable across runs.
fn derived_cache_file_name(document_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in document_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}.fdc")
}

/// Path under the application cache directory (non-user-content): the
/// derived cache is disposable and must never live beside vault bytes.
fn derived_cache_path(app: &AppHandle, document_id: &str) -> CommandResult<PathBuf> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| {
            VaultCommandError::new("IO", format!("no application cache directory: {error}"))
        })?
        .join("derived-cache");
    fs::create_dir_all(&directory)
        .map_err(|error| map_io(error, "could not create derived cache directory"))?;
    Ok(directory.join(derived_cache_file_name(document_id)))
}

/// Header carrying the document id on the raw-binary save path (desktop /
/// iOS custom protocol IPC). Android cannot read raw request bodies, so it
/// sends `{ documentId, data }` with a base64 `data` string instead — the
/// Tauri-documented cross-platform shape that avoids per-byte JSON arrays.
const DERIVED_CACHE_DOCUMENT_HEADER: &str = "x-froglight-derived-document";

fn derived_cache_document_from_request(request: &tauri::ipc::Request<'_>) -> CommandResult<String> {
    request
        .headers()
        .get(DERIVED_CACHE_DOCUMENT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            VaultCommandError::new(
                "INVALID_ARGUMENT",
                "derived cache request is missing a document id",
            )
        })
}

fn derived_cache_document_from_json(value: &serde_json::Value) -> CommandResult<String> {
    value
        .get("documentId")
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            VaultCommandError::new(
                "INVALID_ARGUMENT",
                "derived cache request is missing a document id",
            )
        })
}

fn derived_cache_base64_engine() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Load one document's derived cache record.
///
/// Desktop/iOS return a raw `ArrayBuffer` response (no JSON number array).
/// Android cannot receive raw response bodies through its postMessage IPC,
/// so it returns a base64 string and the JS transport decodes it — still
/// one linear decode instead of per-byte JSON numbers. Missing/empty
/// records are a clean cache miss (`null`).
#[tauri::command]
fn native_derived_cache_load(
    app: AppHandle,
    document_id: String,
) -> CommandResult<tauri::ipc::Response> {
    let path = derived_cache_path(&app, &document_id)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        // Missing records are a clean cache miss, never an error.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(map_io(error, "could not read derived cache")),
    };
    if cfg!(target_os = "android") {
        let encoded = derived_cache_base64_engine().encode(&bytes);
        Ok(tauri::ipc::Response::new(encoded))
    } else {
        Ok(tauri::ipc::Response::new(bytes))
    }
}

/// Save one document's derived cache record atomically (temp file +
/// rename). The heavy payload never expands into a JSON number array:
/// desktop/iOS send a raw request body, Android sends a base64 string.
#[tauri::command]
fn native_derived_cache_save(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> CommandResult<()> {
    let (document_id, owned);
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            document_id = derived_cache_document_from_request(&request)?;
            owned = bytes.clone();
            &owned
        }
        tauri::ipc::InvokeBody::Json(value) => {
            document_id = derived_cache_document_from_json(value)?;
            let encoded = value
                .get("data")
                .and_then(|entry| entry.as_str())
                .ok_or_else(|| {
                    VaultCommandError::new("INVALID_ARGUMENT", "derived cache payload is missing")
                })?;
            owned = derived_cache_base64_engine()
                .decode(encoded)
                .map_err(|error| {
                    VaultCommandError::new(
                        "INVALID_ARGUMENT",
                        format!("derived cache payload is not base64: {error}"),
                    )
                })?;
            &owned
        }
    };
    let path = derived_cache_path(&app, &document_id)?;
    let temporary = path.with_extension("fdc.tmp");
    fs::write(&temporary, bytes).map_err(|error| map_io(error, "could not write derived cache"))?;
    fs::rename(&temporary, &path)
        .map_err(|error| map_io(error, "could not commit derived cache"))?;
    Ok(())
}

#[tauri::command]
fn native_derived_cache_remove(app: AppHandle, document_id: String) -> CommandResult<()> {
    let path = derived_cache_path(&app, &document_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_io(error, "could not remove derived cache")),
    }
}

fn map_io(error: std::io::Error, context: &str) -> VaultCommandError {
    // ENOSPC (28) / EDQUOT (122) have no stable ErrorKind on rust 1.77, so
    // match raw OS codes as well as kinds. Quota failures must surface as
    // Quota failures must surface as QUOTA_EXCEEDED, not generic IO.
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "NOT_FOUND",
        std::io::ErrorKind::AlreadyExists => "ALREADY_EXISTS",
        std::io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        std::io::ErrorKind::DirectoryNotEmpty => "CONFLICT",
        _ => match error.raw_os_error() {
            Some(28) | Some(122) => "QUOTA_EXCEEDED",
            _ => "IO",
        },
    };
    VaultCommandError::new(code, format!("{context}: {error}"))
}

fn now_millis() -> u64 {
    system_time_millis(SystemTime::now()).unwrap_or(0)
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(froglight_vault_storage::init())
        .plugin(froglight_keyboard_inset::init())
        .plugin(froglight_stylus::init())
        .plugin(froglight_purchases::init())
        .plugin(froglight_file_drop::init())
        // Native-feel WebView hardening suppresses browser
        // defaults (reload, view-source, context menu, ...) via an init
        // script. No IPC commands, so no new capability grants.
        .plugin(froglight_webview_hardening::debug())
        .manage(NativeVaultState::default())
        .invoke_handler(tauri::generate_handler![
            native_vault_pick_directory,
            native_vault_create,
            native_vault_demo,
            native_vault_list_recent,
            native_vault_mark_opened,
            native_vault_forget,
            native_vault_stat,
            native_vault_list,
            native_vault_create_directory,
            native_vault_read,
            native_vault_write,
            native_vault_remove,
            native_vault_move,
            native_derived_cache_load,
            native_derived_cache_save,
            native_derived_cache_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
