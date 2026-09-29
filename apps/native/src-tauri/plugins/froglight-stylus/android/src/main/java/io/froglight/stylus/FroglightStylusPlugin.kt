// Froglight stylus accessory events — Android host.
//
// Semantic accessory actions only: eraser/tool detection plus stylus
// button and hover/proximity reports for S Pen, USI, and generic styli.
// Stroke samples stay in the WebView's PointerEvent pipeline (including
// historical samples, the native analogue of getCoalescedEvents) and
// never cross the native bridge.
//
// The listeners always return false so the WebView keeps every event.
// No vendor SDKs: generic MotionEvent tool types and button state cover
// ordinary drawing and accessory behavior.
//
// Capabilities are state, not fire-and-forget events: the current host
// capability map is retained and served via `getCapabilities` so JS
// bootstrap can query after installing its forwarder.
package io.froglight.stylus

import android.app.Activity
import android.view.MotionEvent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class FroglightStylusPlugin(private val activity: Activity): Plugin(activity) {
    private var webView: WebView? = null
    private var lastPrimary = false
    private var lastSecondary = false
    private var lastEraser = false
    private var lastProximity = false
    private var activeStylusDeviceId: Int? = null
    private var stylusInProximity = false
    private var capabilitiesSent = false

    // Runs on the UI thread (the motion callbacks' thread).
    private fun emit(name: String, json: String) {
        webView?.evaluateJavascript(
            "window.__FROGLIGHT_STYLUS_EVENT__ && window.__FROGLIGHT_STYLUS_EVENT__('$name', $json)",
            null)
    }

    private fun capabilitiesJson(): String {
        // MotionEvent exposes pressure, tilt/orientation, and hover for
        // styli, but no barrel-rotation (twist) axis — S Pen-class hardware
        // does not report it. Twist stays false until hardware proves
        // otherwise; the diagnostics view will show what arrives.
        return "{\"available\":true,\"pressure\":true,\"tilt\":true,\"twist\":false,\"hover\":true,\"eraser\":true,\"barrelButton\":true,\"doubleTap\":false,\"squeeze\":false}"
    }

    private fun emitCapabilities() {
        if (capabilitiesSent) return
        capabilitiesSent = true
        emit("capabilities", capabilitiesJson())
    }

    @Command
    fun getCapabilities(invoke: Invoke) {
        val result = JSObject()
        result.put("available", true)
        result.put("pressure", true)
        result.put("tilt", true)
        result.put("twist", false)
        result.put("hover", true)
        result.put("eraser", true)
        result.put("barrelButton", true)
        result.put("doubleTap", false)
        result.put("squeeze", false)
        invoke.resolve(result)
    }

    private var inputRegistration: FroglightWebViewInputCoordinator.ListenerRegistration? = null

    override fun load(webView: WebView) {
        super.load(webView)
        // Reload safety: drop the previous registration before attaching
        // again so a plugin reload can never stack duplicate observers.
        // (Tauri's Android Plugin API offers no unload callback — only
        // load/onNewIntent — so the coordinator additionally auto-cleans
        // when the WebView detaches.)
        inputRegistration?.dispose()
        inputRegistration = null
        this.webView = webView

        inputRegistration = FroglightWebViewInputCoordinator.attach(
            webView,
            onTouch = { event -> observeStylusEvent(event); false },
            onGenericMotion = { event -> observeStylusEvent(event); false },
            onHover = { event -> observeHoverEvent(event); false },
        )
    }

    internal fun observeStylusEvent(event: MotionEvent) {
        val classification = StylusEventClassifier.classifyContact(event)
        if (classification.sawStylus || classification.sawEraser) emitCapabilities()

        // Only stylus/eraser contacts may mutate button state: mouse,
        // finger, and trackpad events must never flip accessory state.
        if (!classification.sawStylus && !classification.sawEraser) return

        // ACTION_CANCEL tears down the gesture: force-release everything
        // this stylus owns so the editor eraser can never stick on.
        if (event.actionMasked == MotionEvent.ACTION_CANCEL) {
            if (lastPrimary) {
                lastPrimary = false
                emit("action", "{\"type\":\"primaryButton\",\"pressed\":false}")
            }
            if (lastSecondary) {
                lastSecondary = false
                emit("action", "{\"type\":\"secondaryButton\",\"pressed\":false}")
            }
            if (lastEraser) {
                lastEraser = false
                emit("action", "{\"type\":\"eraser\",\"active\":false}")
            }
            return
        }

        val primary = (event.buttonState and MotionEvent.BUTTON_STYLUS_PRIMARY) != 0
        if (primary != lastPrimary) {
            lastPrimary = primary
            emit("action", "{\"type\":\"primaryButton\",\"pressed\":$primary}")
        }
        val secondary = (event.buttonState and MotionEvent.BUTTON_STYLUS_SECONDARY) != 0
        if (secondary != lastSecondary) {
            lastSecondary = secondary
            emit("action", "{\"type\":\"secondaryButton\",\"pressed\":$secondary}")
        }
        // Tool type alone is not contact state: an ACTION_UP may still
        // report TOOL_TYPE_ERASER after the rubber lifts. Release/cancel
        // must always resolve to inactive.
        val eraserContact = StylusEventClassifier.eraserContactForState(
            classification.sawEraser,
            event.actionMasked,
            lastEraser,
        )
        if (eraserContact != lastEraser) {
            lastEraser = eraserContact
            emit("action", "{\"type\":\"eraser\",\"active\":$eraserContact}")
        }
    }

    internal fun observeHoverEvent(event: MotionEvent): Boolean {
        val decision = StylusEventClassifier.classifyHover(
            event,
            activeStylusDeviceId,
            stylusInProximity,
        )
        if (decision.ignore) return false
        if (decision.entering) {
            activeStylusDeviceId = decision.deviceId
            stylusInProximity = true
        }
        if (decision.leaving) {
            // Only the tracked stylus device clears proximity: a mouse
            // hover-exit must never end pen proximity.
            activeStylusDeviceId = null
            stylusInProximity = false
        }
        emitCapabilities()
        if (decision.proximityActive != lastProximity) {
            lastProximity = decision.proximityActive
            emit("action", "{\"type\":\"proximity\",\"active\":${decision.proximityActive}}")
        }
        return false
    }

    companion object {
        internal fun resetForTest(plugin: FroglightStylusPlugin) {
            plugin.lastPrimary = false
            plugin.lastSecondary = false
            plugin.lastEraser = false
            plugin.lastProximity = false
            plugin.activeStylusDeviceId = null
            plugin.stylusInProximity = false
            plugin.capabilitiesSent = false
        }
    }
}

/**
 * Pure MotionEvent tool/device classification (unit-testable, no WebView).
 *
 * Device identity comes from `MotionEvent.deviceId` plus per-pointer
 * `getToolType`; proximity and button transitions stay scoped to the
 * tracked stylus device so mouse hover-exits and finger contacts cannot
 * mutate stylus state.
 */
object StylusEventClassifier {
    data class ContactClassification(
        val sawStylus: Boolean,
        val sawEraser: Boolean,
    )

    data class HoverDecision(
        val ignore: Boolean,
        val entering: Boolean,
        val leaving: Boolean,
        val deviceId: Int?,
        val proximityActive: Boolean,
    )

    @JvmStatic
    fun isStylusTool(toolType: Int): Boolean {
        return toolType == MotionEvent.TOOL_TYPE_STYLUS ||
            toolType == MotionEvent.TOOL_TYPE_ERASER
    }

    @JvmStatic
    fun classifyContactTools(toolTypes: List<Int>): ContactClassification {
        var sawStylus = false
        var sawEraser = false
        for (tool in toolTypes) {
            when (tool) {
                MotionEvent.TOOL_TYPE_STYLUS -> sawStylus = true
                MotionEvent.TOOL_TYPE_ERASER -> sawEraser = true
            }
        }
        return ContactClassification(sawStylus, sawEraser)
    }

    @JvmStatic
    fun classifyContact(event: MotionEvent): ContactClassification {
        var sawStylus = false
        var sawEraser = false
        for (i in 0 until event.pointerCount) {
            when (event.getToolType(i)) {
                MotionEvent.TOOL_TYPE_STYLUS -> sawStylus = true
                MotionEvent.TOOL_TYPE_ERASER -> sawEraser = true
            }
        }
        return ContactClassification(sawStylus, sawEraser)
    }

    @JvmStatic
    fun stylusDeviceId(event: MotionEvent): Int? {
        for (i in 0 until event.pointerCount) {
            if (isStylusTool(event.getToolType(i))) return event.deviceId
        }
        return null
    }

    /**
     * Pure hover state machine over primitive inputs (JVM-testable without
     * a `MotionEvent` runtime). The `MotionEvent` overload below adapts
     * live events to this function.
     */
    @JvmStatic
    fun classifyHoverState(
        action: Int,
        toolTypes: List<Int>,
        deviceId: Int?,
        activeDeviceId: Int?,
        inProximity: Boolean,
    ): HoverDecision {
        val entering = action == MotionEvent.ACTION_HOVER_ENTER ||
            action == MotionEvent.ACTION_HOVER_MOVE
        val leaving = action == MotionEvent.ACTION_HOVER_EXIT
        if (!entering && !leaving) {
            return HoverDecision(true, false, false, null, inProximity)
        }
        val stylusId = if (classifyContactTools(toolTypes).let { it.sawStylus || it.sawEraser }) deviceId else null
        if (entering) {
            if (stylusId == null) {
                return HoverDecision(true, false, false, null, inProximity)
            }
            if (inProximity && stylusId == activeDeviceId) {
                return HoverDecision(true, false, false, null, true)
            }
            return HoverDecision(false, true, false, stylusId, true)
        }
        if (stylusId == null) {
            return HoverDecision(true, false, false, null, inProximity)
        }
        if (activeDeviceId != null && stylusId != activeDeviceId) {
            return HoverDecision(true, false, false, null, inProximity)
        }
        if (!inProximity) {
            return HoverDecision(true, false, false, null, false)
        }
        return HoverDecision(false, false, true, stylusId, false)
    }

    /**
     * Eraser-active state from tool type AND contact action. An ACTION_UP
     * may still report the eraser tool after the rubber lifts, so tool
     * presence alone must never read as active. Release/cancel always
     * resolve to inactive; unknown actions hold the last state.
     */
    @JvmStatic
    fun eraserContactForState(
        sawEraser: Boolean,
        actionMasked: Int,
        lastEraser: Boolean,
    ): Boolean {
        if (!sawEraser) return false
        return when (actionMasked) {
            MotionEvent.ACTION_DOWN,
            MotionEvent.ACTION_POINTER_DOWN,
            MotionEvent.ACTION_MOVE,
            MotionEvent.ACTION_HOVER_ENTER,
            MotionEvent.ACTION_HOVER_MOVE -> true
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_POINTER_UP,
            MotionEvent.ACTION_CANCEL,
            MotionEvent.ACTION_HOVER_EXIT,
            MotionEvent.ACTION_OUTSIDE -> false
            else -> lastEraser
        }
    }

    @JvmStatic
    fun classifyHover(
        event: MotionEvent,
        activeDeviceId: Int?,
        inProximity: Boolean,
    ): HoverDecision {
        val tools = (0 until event.pointerCount).map { event.getToolType(it) }
        return classifyHoverState(
            event.action,
            tools,
            event.deviceId,
            activeDeviceId,
            inProximity,
        )
    }
}

/**
 * Single-owner WebView input coordinator.
 *
 * `setOnTouchListener` / `setOnGenericMotionListener` / `setOnHoverListener`
 * are setter-based: the last caller wins and silently replaces earlier
 * observers. Routing every native observer through this coordinator keeps
 * the logical Tauri plugins separate while guaranteeing one native
 * listener layer that fans out to all registered observers.
 *
 * Setter-API ownership map (one owner per setter; a future observer for an
 * already-owned setter must register with that setter's coordinator):
 *
 * - `setOnTouchListener` → this coordinator
 * - `setOnGenericMotionListener` → this coordinator
 * - `setOnHoverListener` → this coordinator
 * - `setOnScrollChangeListener` → keyboard
 *   `FroglightKeyboardScrollCoordinator`
 */
object FroglightWebViewInputCoordinator {
    private data class Observers(
        val onTouch: ((MotionEvent) -> Boolean)?,
        val onGenericMotion: ((MotionEvent) -> Boolean)?,
        val onHover: ((MotionEvent) -> Boolean)?,
    )

    /** Explicit unregistration handle (reload/test teardown). */
    fun interface ListenerRegistration {
        fun dispose()
    }

    private val observersByView = WeakHashMap<WebView, MutableList<Observers>>()
    private val attached = java.util.Collections.newSetFromMap(WeakHashMap<WebView, Boolean>())
    private val detachListeners = WeakHashMap<WebView, android.view.View.OnAttachStateChangeListener>()

    @Synchronized
    fun attach(
        webView: WebView,
        onTouch: ((MotionEvent) -> Boolean)? = null,
        onGenericMotion: ((MotionEvent) -> Boolean)? = null,
        onHover: ((MotionEvent) -> Boolean)? = null,
    ): ListenerRegistration {
        val entry = Observers(onTouch, onGenericMotion, onHover)
        val list = observersByView.getOrPut(webView) { mutableListOf() }
        list.add(entry)
        ensureAttached(webView)
        return ListenerRegistration { remove(webView, entry) }
    }

    @Synchronized
    private fun ensureAttached(webView: WebView) {
        if (!attached.add(webView)) return
        webView.setOnTouchListener { _, event ->
            var consumed = false
            for (entry in snapshot(webView)) {
                val handler = entry.onTouch ?: continue
                try {
                    if (handler(event)) consumed = true
                } catch (_: Throwable) {
                }
            }
            consumed
        }
        webView.setOnGenericMotionListener { _, event ->
            var consumed = false
            for (entry in snapshot(webView)) {
                val handler = entry.onGenericMotion ?: continue
                try {
                    if (handler(event)) consumed = true
                } catch (_: Throwable) {
                }
            }
            consumed
        }
        webView.setOnHoverListener { _, event ->
            var consumed = false
            for (entry in snapshot(webView)) {
                val handler = entry.onHover ?: continue
                try {
                    if (handler(event)) consumed = true
                } catch (_: Throwable) {
                }
            }
            consumed
        }
        // Tauri offers no plugin-unload callback (only load/onNewIntent),
        // so teardown rides the WebView detach: dropping every observer for
        // a detached view clears the native setters and releases stale
        // plugin captures.
        val detach = object : android.view.View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: android.view.View) = Unit
            override fun onViewDetachedFromWindow(v: android.view.View) {
                clearWebView(webView)
            }
        }
        detachListeners[webView] = detach
        webView.addOnAttachStateChangeListener(detach)
    }

    @Synchronized
    private fun remove(webView: WebView, entry: Observers) {
        observersByView[webView]?.remove(entry)
        if (observersByView[webView].isNullOrEmpty()) {
            clearWebView(webView)
        }
    }

    @Synchronized
    private fun clearWebView(webView: WebView) {
        observersByView.remove(webView)
        attached.remove(webView)
        detachListeners.remove(webView)?.let(webView::removeOnAttachStateChangeListener)
        webView.setOnTouchListener(null)
        webView.setOnGenericMotionListener(null)
        webView.setOnHoverListener(null)
    }

    @Synchronized
    private fun snapshot(webView: WebView): List<Observers> {
        return observersByView[webView]?.toList() ?: emptyList()
    }

    @Synchronized
    internal fun observerCountForTest(webView: WebView): Int {
        return observersByView[webView]?.size ?: 0
    }

    @Synchronized
    internal fun clearForTest(webView: WebView) {
        clearWebView(webView)
    }
}

private typealias WeakHashMap<K, V> = java.util.WeakHashMap<K, V>
