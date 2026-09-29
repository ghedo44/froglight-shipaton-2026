// Froglight external file ingress — Android host.
//
// Cross-application drops arrive as `DragEvent` + `ClipData` + `content://`
// URIs, not reliably as WebView `File` objects. This backend forwards
// position phases through a direct `evaluateJavascript` hook and mints
// opaque tokens (`token -> content:// URI`) so shared application code
// never sees native URIs or paths. Bytes resolve lazily through
// `readDropFile`; whole files are never sent as base64 through evaluation.
//
// The drag listener returns false for unrelated drags so the WebView keeps
// its own interaction, and true only while tracking an external file drag.
// Permissions from `requestDragAndDropPermissions` stay alive only while
// their batch holds unconsumed tokens.
package io.froglight.filedrop

import android.app.Activity
import android.content.ClipData
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.view.DragEvent
import android.view.View
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@InvokeArg class ReadDropFileArgs { lateinit var token: String }

@TauriPlugin
class FroglightFileDropPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private val tokens = ConcurrentHashMap<String, DropEntry>()
    private val batches = ConcurrentHashMap<String, DropBatch>()
    private var trackingExternal = false

    private data class DropEntry(
        val uri: Uri,
        val batchId: String,
    )

    private data class DropBatch(
        val permission: Any?,
        val release: () -> Unit,
        val remaining: MutableSet<String>,
    )

    // Runs on the UI thread (the drag callbacks' thread).
    private fun emit(name: String, json: String) {
        webView?.evaluateJavascript(
            "window.__FROGLIGHT_FILE_DROP_EVENT__ && window.__FROGLIGHT_FILE_DROP_EVENT__('$name', $json)",
            null,
        )
    }

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        // Setter-API ownership: `setOnDragListener` belongs to the
        // file-drop plugin. Future drag observers must fan out here rather
        // than replacing this listener (same rule as the stylus input
        // coordinator and the keyboard scroll coordinator).
        webView.setOnDragListener { _, event -> onDragEvent(event) }
    }

    internal fun onDragEvent(event: DragEvent): Boolean {
        when (event.action) {
            DragEvent.ACTION_DRAG_STARTED -> {
                // Accept only URI-backed external content. Internal WebView
                // drags (text/selection) may also carry ClipData, so a
                // missing URI must return false and leave the gesture to the
                // WebView.
                val clip = event.clipData
                val fileLike = clip != null && hasUriItems(clip) &&
                    FileDropEventBuilder.isFileLike(
                        FileDropEventBuilder.describeClipData(clip),
                    )
                trackingExternal = fileLike
                // False lets the WebView keep unrelated (internal) drags.
                return fileLike
            }
            DragEvent.ACTION_DRAG_ENTERED -> {
                if (!trackingExternal) return false
                emit("enter", "{\"x\":${event.x},\"y\":${event.y}}")
                return true
            }
            DragEvent.ACTION_DRAG_LOCATION -> {
                if (!trackingExternal) return false
                emit("over", "{\"x\":${event.x},\"y\":${event.y}}")
                return true
            }
            DragEvent.ACTION_DRAG_EXITED -> {
                if (!trackingExternal) return false
                emit("leave", "{}")
                return true
            }
            DragEvent.ACTION_DROP -> {
                if (!trackingExternal) return false
                return try {
                    handleDrop(event)
                } finally {
                    trackingExternal = false
                }
            }
            DragEvent.ACTION_DRAG_ENDED -> {
                if (!trackingExternal) return false
                trackingExternal = false
                emit("leave", "{}")
                return true
            }
            else -> return false
        }
    }

    private fun hasUriItems(clip: ClipData): Boolean {
        for (i in 0 until clip.itemCount) {
            try {
                if (clip.getItemAt(i)?.uri != null) return true
            } catch (_: Throwable) {
            }
        }
        return false
    }

    private fun handleDrop(event: DragEvent): Boolean {
        val clip: ClipData = event.clipData ?: run {
            emit("leave", "{}")
            return true
        }
        if (clip.itemCount == 0) {
            emit("leave", "{}")
            return true
        }
        val permission = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                activity.requestDragAndDropPermissions(event)
            } else {
                null
            }
        } catch (_: Throwable) {
            null
        }
        val batchId = UUID.randomUUID().toString()
        val batchTokens = mutableSetOf<String>()
        val filesJson = StringBuilder("[")
        var first = true
        for (i in 0 until clip.itemCount) {
            val uri: Uri = clip.getItemAt(i)?.uri ?: continue
            val meta = resolveMeta(uri) ?: continue
            val token = "drop-${UUID.randomUUID()}"
            tokens[token] = DropEntry(uri, batchId)
            batchTokens.add(token)
            if (!first) filesJson.append(",")
            first = false
            filesJson.append(FileDropEventBuilder.fileJson(token, meta.name, meta.mimeType, meta.size))
        }
        filesJson.append("]")
        if (batchTokens.isEmpty()) {
            try {
                (permission as? android.view.DragAndDropPermissions)?.release()
            } catch (_: Throwable) {
            }
            emit("leave", "{}")
            return true
        }
        val releaseFn = {
            try {
                (permission as? android.view.DragAndDropPermissions)?.release()
            } catch (_: Throwable) {
            }
        }
        batches[batchId] = DropBatch(permission, releaseFn, batchTokens)
        emit("drop", "{\"x\":${event.x},\"y\":${event.y},\"files\":$filesJson}")
        return true
    }

    private data class ResolvedMeta(val name: String, val mimeType: String?, val size: Long?)

    private fun resolveMeta(uri: Uri): ResolvedMeta? {
        var name: String? = null
        var size: Long? = null
        try {
            activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (cursor.moveToFirst()) {
                    if (nameIdx != -1) name = cursor.getString(nameIdx)
                    if (sizeIdx != -1) {
                        val raw = cursor.getLong(sizeIdx)
                        if (raw >= 0) size = raw
                    }
                }
            }
        } catch (_: Throwable) {
        }
        val fallback = uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')
        val resolved = FileDropEventBuilder.resolveName(name, fallback)
        val mime = try {
            activity.contentResolver.getType(uri)
        } catch (_: Throwable) {
            null
        }
        return ResolvedMeta(resolved, mime, size)
    }

    @Command
    fun readDropFile(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(ReadDropFileArgs::class.java)
        } catch (error: Throwable) {
            invoke.reject("unknown or expired drop token")
            return
        }
        val token = args.token.trim()
        val entry = tokens[token]
        if (entry == null || token.isEmpty()) {
            invoke.reject("unknown or expired drop token")
            return
        }
        try {
            val bytes = activity.contentResolver.openInputStream(entry.uri)?.use { it.readBytes() }
                ?: run {
                    invoke.reject("could not read dropped file")
                    return
                }
            consume(token)
            invoke.resolve(JSObject().apply { put("data", JSArray(bytes.map { it.toInt() and 0xff })) })
        } catch (error: Throwable) {
            consume(token)
            invoke.reject("could not read dropped file")
        }
    }

    @Command
    fun releaseDropFile(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ReadDropFileArgs::class.java)
            consume(args.token.trim())
        } catch (_: Throwable) {
        }
        invoke.resolve()
    }

    private fun consume(token: String) {
        val entry = tokens.remove(token) ?: return
        val batch = batches[entry.batchId] ?: return
        synchronized(batch) {
            batch.remaining.remove(token)
            if (batch.remaining.isEmpty()) {
                batches.remove(entry.batchId)
                try {
                    batch.release()
                } catch (_: Throwable) {
                }
            }
        }
    }

    companion object {
        internal fun resetForTest(plugin: FroglightFileDropPlugin) {
            plugin.tokens.clear()
            plugin.batches.clear()
            plugin.trackingExternal = false
        }
    }
}

/**
 * Pure drop-payload helpers (JVM-testable, no WebView/ContentResolver).
 *
 * Token minting stays in the plugin (UUID); this object owns name
 * resolution, file-likeness classification, and JSON escaping so unit
 * tests pin the wire contract without Android instrumentation.
 */
object FileDropEventBuilder {
    data class ClipDescription(val hasClipData: Boolean, val itemCount: Int)

    @JvmStatic
    fun describeClipData(clipData: ClipData?): ClipDescription {
        if (clipData == null) return ClipDescription(false, 0)
        return ClipDescription(true, clipData.itemCount)
    }

    /** Accept only drags that look file-like; never swallow internal drags. */
    @JvmStatic
    fun isFileLike(description: ClipDescription): Boolean {
        if (!description.hasClipData) return false
        return description.itemCount > 0
    }

    /** Resolve a display name with deterministic fallbacks. */
    @JvmStatic
    fun resolveName(displayName: String?, fallback: String?): String {
        val candidate = (displayName ?: fallback ?: "").trim()
        if (candidate.isEmpty()) return "dropped-file"
        return candidate.replace('/', '-').replace('\\', '-')
    }

    @JvmStatic
    fun escapeJson(value: String): String {
        val out = StringBuilder(value.length + 8)
        for (char in value) {
            when (char) {
                '\\' -> out.append("\\\\")
                '"' -> out.append("\\\"")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> {
                    if (char < ' ') out.append(String.format("\\u%04x", char.code))
                    else out.append(char)
                }
            }
        }
        return out.toString()
    }

    @JvmStatic
    fun fileJson(token: String, name: String, mimeType: String?, size: Long?): String {
        val safeName = resolveName(name, null)
        val parts = mutableListOf(
            "\"token\":\"${escapeJson(token)}\"",
            "\"name\":\"${escapeJson(safeName)}\"",
        )
        if (!mimeType.isNullOrEmpty()) parts.add("\"mimeType\":\"${escapeJson(mimeType)}\"")
        if (size != null && size >= 0) parts.add("\"size\":$size")
        return "{${parts.joinToString(",")}}"
    }
}
