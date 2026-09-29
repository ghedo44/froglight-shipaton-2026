// Froglight overlay keyboard insets — Android host.
//
// The WebView keeps its full size and the IME overlays it; inset
// transitions are reported to the page, which lays itself out against the
// `--fl-keyboard-inset-height` CSS variable. Events travel through a direct
// `evaluateJavascript` hook because the Tauri plugin event channel delivers
// with hundreds of milliseconds of latency — a `willShow` sent through it
// arrives after the IME animation it announces has already finished.
//
// Behavior derived from `dash-chat/tauri-plugin-virtual-keyboard`
// (MIT OR Apache-2.0); reimplemented as Froglight-owned code with no
// dependency on that repository.
package io.froglight.keyboardinset

import android.view.View
import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import androidx.core.graphics.Insets
import androidx.core.view.OnApplyWindowInsetsListener
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

@TauriPlugin
class FroglightKeyboardInsetPlugin(private val activity: Activity): Plugin(activity) {
    private var webView: WebView? = null
    private var animating = false
    private var imeVisible = false
    private var scrollRegistration: FroglightKeyboardScrollCoordinator.ListenerRegistration? = null

    // Runs on the UI thread (the insets callbacks' thread).
    private fun emit(name: String, json: String) {
        webView?.evaluateJavascript(
            "window.__FROGLIGHT_KEYBOARD_INSET_EVENT__ && window.__FROGLIGHT_KEYBOARD_INSET_EVENT__('$name', $json)",
            null)
    }

    override fun load(webView: WebView) {
        super.load(webView)
        // Reload safety: Tauri offers no plugin-unload callback, so a
        // re-load disposes the previous scroll registration first (the
        // coordinator additionally auto-cleans on WebView detach).
        scrollRegistration?.dispose()
        scrollRegistration = null
        this.webView = webView
        val rootView = activity.window.decorView
        val density = activity.resources.displayMetrics.density

        // While the IME is up, Chromium lets touch drags pan the visual
        // viewport (the WebView is full-size underneath the keyboard). The
        // page lays itself out against the inset instead, so pin the native
        // scroll and never draw the WebView's own scrollbars — all real
        // scrolling is DOM-level.
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        // Single-owner setter fan-out: route through the shared coordinator
        // so a future native observer cannot silently replace this clamp.
        scrollRegistration = FroglightKeyboardScrollCoordinator.attachScroll(
            webView,
        ) { v, _, scrollY, _, _ ->
            if (imeVisible && (scrollY != 0 || v.scrollX != 0)) {
                v.scrollTo(0, 0)
            }
        }

        // Chromium derives env(safe-area-inset-*) from the insets dispatched
        // to the WebView and zeroes the bottom safe area while the IME is up.
        // The page lays itself out against the keyboard-inset variable
        // instead, so give the WebView an IME-less view of the world: strip
        // the IME from the insets it receives and block IME animation
        // callbacks from propagating into it. The decor listeners below still
        // see the real insets and feed the keyboard events.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
            val stripped = WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build()
            ViewCompat.onApplyWindowInsets(v, stripped)
        }
        ViewCompat.setWindowInsetsAnimationCallback(webView, object :
            WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP
            ) {
            override fun onProgress(
                insets: WindowInsetsCompat,
                runningAnimations: List<WindowInsetsAnimationCompat>
            ): WindowInsetsCompat = insets
        })

        ViewCompat.setOnApplyWindowInsetsListener(rootView,
            OnApplyWindowInsetsListener { _: View?, windowInsets: WindowInsetsCompat? ->
                val ime = windowInsets!!.getInsets(WindowInsetsCompat.Type.ime())
                val wasVisible = imeVisible
                imeVisible = ime.bottom > 0

                if (ime.bottom > 0) {
                    webView.scrollTo(0, 0)
                }

                // Animated changes are reported by the target/settled pair
                // below; this covers IMEs/settings where no animation runs.
                // A zero height is not an open target: it is a close, so it
                // takes hide semantics. The prior-visibility check suppresses
                // redundant hides when no keyboard was ever open (e.g. the
                // initial insets dispatch).
                if (!animating) {
                    val steady = ime.bottom / density
                    if (steady > 0) {
                        emit("target", "{\"height\":$steady,\"durationMs\":0,\"measurement\":\"hint\"}")
                        emit("settled", "{\"height\":$steady}")
                    } else if (wasVisible) {
                        emit("willHide", "{\"durationMs\":0}")
                        emit("didHide", "{}")
                    }
                }

                windowInsets
            })

        ViewCompat.setWindowInsetsAnimationCallback(rootView, object :
            WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE
            ) {
            override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) {
                    animating = true
                }
            }

            override fun onStart(
                animation: WindowInsetsAnimationCompat,
                bounds: WindowInsetsAnimationCompat.BoundsCompat
            ): WindowInsetsAnimationCompat.BoundsCompat {
                if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) {
                    // The end-state insets are already dispatched by onStart,
                    // so the root insets carry the animation's target height.
                    // Animation-start geometry is approximate: a hint.
                    val target = imeHeight(rootView) / density
                    if (target > 0) {
                        emit("target", "{\"height\":$target,\"durationMs\":${animation.durationMillis},\"measurement\":\"hint\"}")
                    } else {
                        emit("willHide", "{\"durationMs\":${animation.durationMillis}}")
                    }
                }
                return bounds
            }

            // Required override. Per-frame insets are deliberately ignored:
            // the inset variable is set once from the target height reported
            // by onStart and the page glides on the compositor.
            override fun onProgress(
                insets: WindowInsetsCompat,
                runningAnimations: List<WindowInsetsAnimationCompat>
            ): WindowInsetsCompat = insets

            override fun onEnd(animation: WindowInsetsAnimationCompat) {
                if ((animation.typeMask and WindowInsetsCompat.Type.ime()) != 0) {
                    animating = false
                    val height = imeHeight(rootView) / density
                    if (height > 0) {
                        emit("settled", "{\"height\":$height}")
                    } else {
                        // Clear visibility so a trailing non-animated insets
                        // dispatch does not re-emit the hide.
                        imeVisible = false
                        emit("didHide", "{}")
                    }
                }
            }
        })
    }

    private fun imeHeight(rootView: View): Int =
        ViewCompat.getRootWindowInsets(rootView)
            ?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0

    @Command
    fun hide(invoke: Invoke) {
        activity.runOnUiThread {
            webView?.let {
                WindowInsetsControllerCompat(activity.window, it)
                    .hide(WindowInsetsCompat.Type.ime())
            }
            invoke.resolve()
        }
    }

    @Command
    fun show(invoke: Invoke) {
        activity.runOnUiThread {
            webView?.let {
                WindowInsetsControllerCompat(activity.window, it)
                    .show(WindowInsetsCompat.Type.ime())
            }
            invoke.resolve()
        }
    }
}

/**
 * Single-owner scroll-change coordinator (keyboard side).
 *
 * Setter-API ownership map (one owner per setter; the two plugins share the
 * WebView but never the same setter, so neither can silently replace the
 * other — a future observer for an already-owned setter must register with
 * that setter's coordinator instead of calling the setter directly):
 *
 * - `setOnTouchListener` → stylus `FroglightWebViewInputCoordinator`
 * - `setOnGenericMotionListener` → stylus `FroglightWebViewInputCoordinator`
 * - `setOnHoverListener` → stylus `FroglightWebViewInputCoordinator`
 * - `setOnScrollChangeListener` → this `FroglightKeyboardScrollCoordinator`
 *
 * The two coordinators are separate objects only because the Tauri Android
 * plugin modules cannot depend on each other; logically they are one rule
 * (one fan-out owner per setter API). Logical Tauri plugins stay separate;
 * the coordinators are an internal implementation detail.
 */
internal object FroglightKeyboardScrollCoordinator {
    /** Explicit unregistration handle (reload/test teardown). */
    fun interface ListenerRegistration {
        fun dispose()
    }

    private val scrollObservers = java.util.WeakHashMap<
        WebView,
        MutableList<View.OnScrollChangeListener>,
    >()
    private val attached =
        java.util.Collections.newSetFromMap(
            java.util.WeakHashMap<WebView, Boolean>(),
        )
    private val detachListeners =
        java.util.WeakHashMap<WebView, View.OnAttachStateChangeListener>()

    @Synchronized
    fun attachScroll(
        webView: WebView,
        listener: View.OnScrollChangeListener,
    ): ListenerRegistration {
        val list = scrollObservers.getOrPut(webView) { mutableListOf() }
        list.add(listener)
        ensureAttached(webView)
        return ListenerRegistration { remove(webView, listener) }
    }

    @Synchronized
    private fun ensureAttached(webView: WebView) {
        if (!attached.add(webView)) return
        webView.setOnScrollChangeListener { v, scrollX, scrollY, oldX, oldY ->
            for (entry in (scrollObservers[webView]?.toList() ?: emptyList())) {
                try {
                    entry.onScrollChange(v, scrollX, scrollY, oldX, oldY)
                } catch (_: Throwable) {
                }
            }
        }
        // No plugin-unload callback exists in Tauri's Android API, so
        // teardown rides the WebView detach: a detached view drops its
        // observers, clears the native setter, and releases plugin captures.
        val detach = object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) = Unit
            override fun onViewDetachedFromWindow(v: View) {
                clearWebView(webView)
            }
        }
        detachListeners[webView] = detach
        webView.addOnAttachStateChangeListener(detach)
    }

    @Synchronized
    private fun remove(webView: WebView, listener: View.OnScrollChangeListener) {
        scrollObservers[webView]?.remove(listener)
        if (scrollObservers[webView].isNullOrEmpty()) {
            clearWebView(webView)
        }
    }

    @Synchronized
    private fun clearWebView(webView: WebView) {
        scrollObservers.remove(webView)
        attached.remove(webView)
        detachListeners.remove(webView)?.let(webView::removeOnAttachStateChangeListener)
        webView.setOnScrollChangeListener(null)
    }
}
