package io.froglight.vaultstorage

import android.app.Activity
import android.net.Uri
import android.util.Base64
import android.webkit.MimeTypeMap
import app.tauri.plugin.Invoke

internal const val NATIVE_ERROR_PREFIX = "FROGLIGHT_VAULT_ERROR"

internal object ErrorCodes {
    const val INVALID_PATH = "INVALID_PATH"
    const val FOLDER_NOT_FOUND = "FOLDER_NOT_FOUND"
    const val NOT_FOUND = "NOT_FOUND"
    const val ALREADY_EXISTS = "ALREADY_EXISTS"
    const val PERMISSION_DENIED = "PERMISSION_DENIED"
    const val CONFLICT = "CONFLICT"
    const val CANCELLED = "CANCELLED"
    const val IO_ERROR = "IO_ERROR"
    const val NATIVE_ERROR = "NATIVE_ERROR"
    const val INVALID_ARGUMENT = "INVALID_ARGUMENT"
}

internal class VaultStorageException(val code: String, override val message: String, cause: Throwable? = null) : Exception(message, cause)
internal fun fail(code: String, message: String): Nothing = throw VaultStorageException(code, message)

internal fun Invoke.rejectVault(error: Throwable) {
    val mapped = when (error) {
        is VaultStorageException -> error
        is SecurityException -> VaultStorageException(ErrorCodes.PERMISSION_DENIED, error.message ?: "permission denied", error)
        is IllegalArgumentException -> VaultStorageException(ErrorCodes.INVALID_ARGUMENT, error.message ?: "invalid argument", error)
        else -> VaultStorageException(ErrorCodes.NATIVE_ERROR, error.message ?: "native command failed", error)
    }
    reject("$NATIVE_ERROR_PREFIX:${mapped.code}:${mapped.message}")
}

internal object VaultPaths {
    fun split(path: String): List<String> {
        val normalized = path.trim().replace('\\', '/')
        if (normalized.isEmpty()) return emptyList()
        if (normalized.startsWith('/') || normalized.startsWith('~') || normalized.contains('\u0000')) {
            fail(ErrorCodes.INVALID_PATH, "Path must be relative")
        }
        val out = mutableListOf<String>()
        normalized.split('/').forEachIndexed { index, segment ->
            when {
                segment.isEmpty() || segment == "." -> Unit
                segment == ".." -> fail(ErrorCodes.INVALID_PATH, "Parent segments are not allowed")
                index == 0 && segment.contains(':') -> fail(ErrorCodes.INVALID_PATH, "Absolute and URI-style paths are not allowed")
                else -> out += segment
            }
        }
        return out
    }
    fun join(left: String, right: String): String = listOf(left.trim('/'), right.trim('/')).filter { it.isNotEmpty() }.joinToString("/")
    fun parent(path: String): String = split(path).dropLast(1).joinToString("/")
    fun name(path: String): String = split(path).lastOrNull() ?: fail(ErrorCodes.INVALID_PATH, "Path must not be empty")
}

internal object VaultMimeTypes {
    fun forPath(path: String): String {
        val extension = path.substringAfterLast('.', "").lowercase()
        return if (extension.isNotEmpty()) MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream" else "application/octet-stream"
    }
}

internal fun decodeVaultWritePayload(encoded: String): ByteArray {
    val bytes = try {
        Base64.decode(encoded, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
        fail(ErrorCodes.INVALID_ARGUMENT, "data must be valid base64")
    }
    if (Base64.encodeToString(bytes, Base64.NO_WRAP) != encoded) {
        fail(ErrorCodes.INVALID_ARGUMENT, "data must be canonical base64")
    }
    return bytes
}

internal data class StoredFolder(val id: String, val name: String?, val uri: String?)

internal class FolderStore(private val activity: Activity) {
    private val prefs = activity.getSharedPreferences("froglight_vault_storage", Activity.MODE_PRIVATE)

    fun save(uri: Uri, name: String?): StoredFolder {
        val id = java.util.UUID.randomUUID().toString()
        prefs.edit().putString("folder:$id:uri", uri.toString()).putString("folder:$id:name", name).apply()
        return StoredFolder(id, name, uri.toString())
    }

    fun getUri(id: String): Uri = Uri.parse(prefs.getString("folder:$id:uri", null) ?: fail(ErrorCodes.FOLDER_NOT_FOUND, "Folder not found: $id"))

    fun list(): List<StoredFolder> = prefs.all.keys.asSequence()
        .filter { it.startsWith("folder:") && it.endsWith(":uri") }
        .map { it.removePrefix("folder:").removeSuffix(":uri") }
        .distinct().sorted()
        .map { id -> StoredFolder(id, prefs.getString("folder:$id:name", null), prefs.getString("folder:$id:uri", null)) }
        .toList()

    fun remove(id: String) {
        prefs.edit().remove("folder:$id:uri").remove("folder:$id:name").apply()
    }
}
