package io.froglight.vaultstorage

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.util.Base64
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

@InvokeArg class FolderIdArgs { lateinit var folderId: String }
@InvokeArg class ReadDirArgs { lateinit var folderId: String; var path: String? = null }
@InvokeArg class StatArgs { lateinit var folderId: String; lateinit var path: String }
@InvokeArg class ReadFileArgs { lateinit var folderId: String; lateinit var path: String }
@InvokeArg class WriteFileArgs {
    lateinit var folderId: String
    lateinit var path: String
    lateinit var data: String
    var expectedChecksum: String? = null
    var mimeType: String? = null
    var recursive: Boolean? = null
}
@InvokeArg class MkdirArgs { lateinit var folderId: String; lateinit var path: String; var recursive: Boolean? = null }
@InvokeArg class RemoveFileArgs { lateinit var folderId: String; lateinit var path: String }
@InvokeArg class RemoveDirArgs { lateinit var folderId: String; lateinit var path: String; var recursive: Boolean? = null }
@InvokeArg class RenameArgs { lateinit var folderId: String; lateinit var fromPath: String; lateinit var toPath: String }

@TauriPlugin
class VaultStoragePlugin(private val activity: Activity) : Plugin(activity) {
    private val folderStore = FolderStore(activity)
    // Keep blocking SAF I/O off the WebView dispatch thread, in call order.
    private val storageExecutor = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(64))

    override fun onDestroy(activity: AppCompatActivity) {
        // Drain already-admitted writes; interrupting them could truncate files.
        storageExecutor.shutdown()
        super.onDestroy(activity)
    }

    @Command
    fun pickFolder(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
            )
        }
        startActivityForResult(invoke, intent, "onFolderPicked")
    }

    @SuppressLint("WrongConstant")
    @ActivityCallback
    fun onFolderPicked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            invoke.reject("$NATIVE_ERROR_PREFIX:${ErrorCodes.CANCELLED}:User cancelled")
            return
        }
        val uri = result.data?.data ?: run {
            invoke.reject("$NATIVE_ERROR_PREFIX:${ErrorCodes.NATIVE_ERROR}:No folder URI returned")
            return
        }
        guarded(invoke) {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            val doc = DocumentFile.fromTreeUri(activity, uri)
                ?: fail(ErrorCodes.PERMISSION_DENIED, "Unable to access selected folder")
            val probe = doc.createFile("text/plain", ".froglight-write-probe-${java.util.UUID.randomUUID()}")
                ?: fail(ErrorCodes.PERMISSION_DENIED, "Selected folder is not writable")
            try {
                activity.contentResolver.openOutputStream(probe.uri, "w")?.use { it.write("froglight".toByteArray()) }
                    ?: fail(ErrorCodes.PERMISSION_DENIED, "Selected folder cannot open a write stream")
            } finally {
                probe.delete()
            }
            val stored = folderStore.save(uri, doc.name ?: uri.lastPathSegment ?: "Folder")
            invoke.resolve(JSObject().apply { put("folder", folderObject(stored)) })
        }
    }

    @Command fun forgetFolder(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(FolderIdArgs::class.java)
        folderStore.remove(args.folderId)
        invoke.resolve()
    }

    @Command fun listFolders(invoke: Invoke) = guarded(invoke) {
        val folders = JSArray()
        folderStore.list().forEach { folders.put(folderObject(it)) }
        invoke.resolve(JSObject().apply { put("folders", folders) })
    }

    @Command fun readDir(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(ReadDirArgs::class.java)
        val basePath = args.path.orEmpty()
        val dir = if (basePath.isBlank()) requireBase(args.folderId) else requireEntry(args.folderId, basePath)
        if (!dir.isDirectory) fail(ErrorCodes.INVALID_ARGUMENT, "Path is not a directory")
        val entries = JSArray()
        dir.listFiles().forEach { entries.put(statObject(basePath, it)) }
        invoke.resolve(JSObject().apply { put("entries", entries) })
    }

    @Command fun stat(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(StatArgs::class.java)
        invoke.resolve(statObject(VaultPaths.parent(args.path), requireEntry(args.folderId, args.path)))
    }

    @Command fun readFile(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(ReadFileArgs::class.java)
        val file = requireFile(args.folderId, args.path)
        val bytes = activity.contentResolver.openInputStream(file.uri)?.use { it.readAllBytesCompat() }
            ?: fail(ErrorCodes.IO_ERROR, "Failed to open input stream")
        invoke.resolve(JSObject().apply { put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)) })
    }

    @Command fun writeFile(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(WriteFileArgs::class.java)
        val bytes = decodeVaultWritePayload(args.data)
        if (args.expectedChecksum != null) {
            val current = requireFile(args.folderId, args.path)
            val content = activity.contentResolver.openInputStream(current.uri)?.use { it.readBytes() }
                ?: fail(ErrorCodes.IO_ERROR, "Failed to read current file")
            var hash = 0x811c9dc5u
            for (byte in content) hash = (hash xor byte.toUByte().toUInt()) * 0x01000193u
            if (hash.toString(16).padStart(8, '0') != args.expectedChecksum) fail(ErrorCodes.CONFLICT, "Vault file changed; local edits are retained")
        }
        val file = ensureFile(args.folderId, args.path, args.mimeType ?: VaultMimeTypes.forPath(args.path))
        activity.contentResolver.openOutputStream(file.uri, "w")?.use { it.write(bytes) }
            ?: fail(ErrorCodes.IO_ERROR, "Failed to open output stream")
        invoke.resolve()
    }

    @Command fun mkdir(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(MkdirArgs::class.java)
        ensureDirectory(args.folderId, args.path, args.recursive ?: false)
        invoke.resolve()
    }

    @Command fun removeFile(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(RemoveFileArgs::class.java)
        val file = requireFile(args.folderId, args.path)
        if (!file.delete()) fail(ErrorCodes.IO_ERROR, "Delete failed")
        invoke.resolve()
    }

    @Command fun removeDir(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(RemoveDirArgs::class.java)
        val dir = requireDirectory(args.folderId, args.path)
        if (!(args.recursive ?: false) && dir.listFiles().isNotEmpty()) {
            fail(ErrorCodes.INVALID_ARGUMENT, "Directory not empty")
        }
        deleteRecursively(dir)
        invoke.resolve()
    }

    @Command fun rename(invoke: Invoke) = guarded(invoke) {
        val args = invoke.parseArgs(RenameArgs::class.java)
        moveEntry(args.folderId, args.fromPath, args.toPath)
        invoke.resolve()
    }

    private fun guarded(invoke: Invoke, block: () -> Unit) {
        val queued = System.nanoTime()
        try {
            storageExecutor.execute {
                val started = System.nanoTime()
                try { block() } catch (error: Throwable) { invoke.rejectVault(error) }
                finally {
                    if (Log.isLoggable("FroglightVault", Log.DEBUG)) Log.d("FroglightVault", "queue_us=${(started - queued) / 1000} operation_us=${(System.nanoTime() - started) / 1000}")
                }
            }
        } catch (error: Throwable) {
            // A call arriving after teardown must reject, never remain pending.
            invoke.rejectVault(error)
        }
    }

    private fun folderObject(folder: StoredFolder): JSObject = JSObject().apply {
        put("id", folder.id); put("name", folder.name); put("uri", folder.uri)
    }

    private fun requireBase(folderId: String): DocumentFile =
        DocumentFile.fromTreeUri(activity, folderStore.getUri(folderId))
            ?: fail(ErrorCodes.PERMISSION_DENIED, "Unable to access persisted folder")

    private fun resolveEntry(folderId: String, relPath: String): DocumentFile? {
        var current = requireBase(folderId)
        for (part in VaultPaths.split(relPath)) current = current.findFile(part) ?: return null
        return current
    }

    private fun requireEntry(folderId: String, relPath: String): DocumentFile =
        resolveEntry(folderId, relPath) ?: fail(ErrorCodes.NOT_FOUND, "Path not found: $relPath")

    private fun requireFile(folderId: String, relPath: String): DocumentFile {
        val file = requireEntry(folderId, relPath)
        if (!file.isFile) fail(ErrorCodes.INVALID_ARGUMENT, "Path is not a file")
        return file
    }

    private fun requireDirectory(folderId: String, relPath: String): DocumentFile {
        val dir = requireEntry(folderId, relPath)
        if (!dir.isDirectory) fail(ErrorCodes.INVALID_ARGUMENT, "Path is not a directory")
        return dir
    }

    private fun ensureDirectory(folderId: String, relPath: String, recursive: Boolean): DocumentFile =
        walkDirectories(folderId, relPath, createMissing = recursive, requireNewLeaf = true)

    /**
     * Walk to the parent of `relPath` without creating anything: ancestors
     * must already exist (parity with the desktop provider) but an existing
     * ancestor directory is expected, never an error.
     */
    private fun ensureParent(folderId: String, relPath: String): DocumentFile {
        val parent = VaultPaths.parent(relPath)
        if (parent.isEmpty()) return requireBase(folderId)
        return walkDirectories(folderId, parent, createMissing = false, requireNewLeaf = false)
    }

    private fun walkDirectories(
        folderId: String,
        relPath: String,
        createMissing: Boolean,
        requireNewLeaf: Boolean,
    ): DocumentFile {
        var current = requireBase(folderId)
        val parts = VaultPaths.split(relPath)
        if (parts.isEmpty()) fail(ErrorCodes.INVALID_PATH, "Path must not be empty")
        parts.forEachIndexed { index, part ->
            val existing = current.findFile(part)
            if (existing != null) {
                if (!existing.isDirectory) fail(ErrorCodes.INVALID_ARGUMENT, "Path segment is not a directory: $part")
                if (requireNewLeaf && !createMissing && index == parts.lastIndex) {
                    fail(ErrorCodes.ALREADY_EXISTS, "Directory already exists: $relPath")
                }
                current = existing
            } else {
                if (!createMissing && index != parts.lastIndex) {
                    fail(ErrorCodes.NOT_FOUND, "Parent directory missing for: $relPath")
                }
                current = current.createDirectory(part) ?: fail(ErrorCodes.IO_ERROR, "Failed to create directory: $part")
            }
        }
        return current
    }

    private fun ensureFile(folderId: String, relPath: String, mimeType: String): DocumentFile {
        val parent = ensureParent(folderId, relPath)
        val name = VaultPaths.name(relPath)
        val existing = parent.findFile(name)
        if (existing != null) {
            if (!existing.isFile) fail(ErrorCodes.INVALID_ARGUMENT, "Target exists and is not a file")
            return existing
        }
        return parent.createFile(mimeType, name) ?: fail(ErrorCodes.IO_ERROR, "Failed to create file: $name")
    }

    private fun moveEntry(folderId: String, fromPath: String, toPath: String) {
        val source = requireEntry(folderId, fromPath)
        if (resolveEntry(folderId, toPath) != null) fail(ErrorCodes.ALREADY_EXISTS, "Destination already exists: $toPath")
        if (VaultPaths.parent(fromPath) == VaultPaths.parent(toPath)) {
            if (!source.renameTo(VaultPaths.name(toPath))) fail(ErrorCodes.IO_ERROR, "Rename failed")
            return
        }
        copyEntry(source, folderId, toPath)
        deleteRecursively(source)
    }

    private fun copyEntry(source: DocumentFile, folderId: String, toPath: String) {
        if (source.isDirectory) {
            ensureDirectory(folderId, toPath, true)
            source.listFiles().forEach { child ->
                val childName = child.name ?: return@forEach
                copyEntry(child, folderId, VaultPaths.join(toPath, childName))
            }
        } else {
            val destination = ensureFile(folderId, toPath, source.type ?: VaultMimeTypes.forPath(toPath))
            activity.contentResolver.openInputStream(source.uri).use { input ->
                activity.contentResolver.openOutputStream(destination.uri, "w").use { output ->
                    if (input == null || output == null) fail(ErrorCodes.IO_ERROR, "Failed to open file streams")
                    input.copyTo(output)
                }
            }
        }
    }

    private fun deleteRecursively(file: DocumentFile) {
        if (file.isDirectory) file.listFiles().forEach { deleteRecursively(it) }
        if (!file.delete()) fail(ErrorCodes.IO_ERROR, "Delete failed: ${file.name ?: "entry"}")
    }

    private fun statObject(parentPath: String, file: DocumentFile): JSObject = JSObject().apply {
        val name = file.name ?: ""
        put("name", name)
        put("path", VaultPaths.join(parentPath, name))
        put("isFile", file.isFile)
        put("isDir", file.isDirectory)
        put("size", if (file.isFile) file.length() else null)
        put("mimeType", file.type)
        put("lastModified", file.lastModified().takeIf { it > 0 }?.div(1000))
    }

    private fun InputStream.readAllBytesCompat(): ByteArray {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        var read: Int
        while (read(chunk).also { read = it } != -1) buffer.write(chunk, 0, read)
        return buffer.toByteArray()
    }
}
