// Froglight overlay keyboard insets — iOS host.
//
// The WKWebView stays full-size and the software keyboard overlays it. UIKit
// notification end frames are converted once into WebView coordinates and
// normalized to bottom-edge occlusion; that canonical height feeds both the
// direct target/settled stream and the cached `get_state` recovery response.
//
// Froglight disables WKWebView's competing public keyboard-observer
// registrations and locks only the outer native scroll view. No private
// WKContentView/WebKit selectors are used. A separate web-side pan guard may
// compensate visual-viewport displacement, but it never derives keyboard
// height.
import Tauri
import UIKit
import WebKit

private struct KeyboardInsetStateResponse: Encodable {
    let height: Double
    let isOpen: Bool
    let isHiding: Bool
}

class FroglightKeyboardInsetPlugin: Plugin {
    private weak var webView: WKWebView?
    private var viewportLock: KeyboardViewportLock?
    // Current canonical target occlusion plus the last settled emission.
    // UIKit may send several notifications for one physical transition; this
    // small state normalizes them into target/settled/hide semantics.
    private var currentTargetHeight: CGFloat = 0
    private var lastSettledHeight: CGFloat?
    private var isHiding = false

    // Runs on the main thread (the keyboard notifications' thread).
    private func emit(_ name: String, _ json: String) {
        webView?.evaluateJavaScript(
            "window.__FROGLIGHT_KEYBOARD_INSET_EVENT__ && window.__FROGLIGHT_KEYBOARD_INSET_EVENT__('\(name)', \(json))",
            completionHandler: nil
        )
    }

    /// Bottom-edge occlusion of the WebView by a keyboard rect already in
    /// WebView coordinates. Floating keyboards ending mid-WebView produce 0.
    static func keyboardInset(webViewBounds: CGRect, keyboardInWebView: CGRect) -> CGFloat {
        let intersection = webViewBounds.intersection(keyboardInWebView)
        guard !intersection.isNull, !intersection.isEmpty else {
            return 0
        }
        // Only bottom-edge occlusion counts: a floating keyboard ending
        // mid-WebView intersects but must not shift global layout.
        guard intersection.maxY >= webViewBounds.maxY - 1 else {
            return 0
        }
        return max(0, webViewBounds.maxY - intersection.minY)
    }

    private func keyboardScreen(
        notification: Notification,
        webView: WKWebView
    ) -> UIScreen {
        // swiftlint:disable:next deprecated_usage
        let fallbackScreen = UIScreen.main
        return (notification.object as? UIScreen)
            ?? webView.window?.windowScene?.screen
            ?? webView.window?.screen
            ?? fallbackScreen
    }

    /// Convert UIKit's screen-space keyboard end frame into the actual
    /// WebView coordinate space. The notification UIScreen is preferred on
    /// iOS 16.1+; window-scene/window/main fallbacks cover older/nil objects.
    private func convertKeyboardFrame(
        _ screenFrame: CGRect,
        notification: Notification,
        webView: WKWebView
    ) -> CGRect {
        let screen = keyboardScreen(notification: notification, webView: webView)
        return screen.coordinateSpace.convert(screenFrame, to: webView)
    }

    /// Single canonical native geometry path.
    private func keyboardInset(
        webView: WKWebView,
        screenFrame: CGRect,
        notification: Notification
    ) -> CGFloat {
        let convertedFrame = convertKeyboardFrame(
            screenFrame,
            notification: notification,
            webView: webView
        )
        return Self.keyboardInset(
            webViewBounds: webView.bounds,
            keyboardInWebView: convertedFrame
        )
    }

    /// Cached state only: no independent geometry remeasurement lives here.
    private func stateResponse() -> KeyboardInsetStateResponse {
        guard webView != nil else {
            return KeyboardInsetStateResponse(
                height: 0,
                isOpen: false,
                isHiding: false
            )
        }
        let height = isHiding ? 0 : currentTargetHeight
        return KeyboardInsetStateResponse(
            height: Double(height),
            isOpen: height > 0,
            isHiding: isHiding
        )
    }

    /// Remove only the keyboard notifications this plugin owns. Tauri may
    /// reload/rebind a plugin to a WebView without destroying the plugin
    /// instance, so rebinding must not multiply callbacks.
    private func removeOwnKeyboardObservers() {
        let nc = NotificationCenter.default
        nc.removeObserver(
            self,
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        nc.removeObserver(
            self,
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        nc.removeObserver(
            self,
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        nc.removeObserver(
            self,
            name: UIResponder.keyboardDidChangeFrameNotification,
            object: nil
        )
        nc.removeObserver(
            self,
            name: UIResponder.keyboardDidShowNotification,
            object: nil
        )
        nc.removeObserver(
            self,
            name: UIResponder.keyboardDidHideNotification,
            object: nil
        )
    }

    /// WKWebView installs public UIKit keyboard observers that can mutate its
    /// outer scroll/inset geometry before Froglight receives the transition.
    /// Froglight owns keyboard avoidance, so remove only those competing
    /// registrations. No private WebKit selector is called.
    private func disableWebViewAutomaticKeyboardObservers(_ webView: WKWebView) {
        let nc = NotificationCenter.default
        nc.removeObserver(
            webView,
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        nc.removeObserver(
            webView,
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        nc.removeObserver(
            webView,
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        nc.removeObserver(
            webView,
            name: UIResponder.keyboardDidChangeFrameNotification,
            object: nil
        )
    }

    public override func load(webview: WKWebView) {
        // `load` is not guaranteed to be one-shot across WebView reloads.
        removeOwnKeyboardObservers()
        self.webView = webview
        currentTargetHeight = 0
        lastSettledHeight = nil
        isHiding = false

        // Take native ownership before installing Froglight observers. The
        // outer WebView remains full-size; only keyboard-aware web regions
        // consume the exact inset emitted below.
        disableWebViewAutomaticKeyboardObservers(webview)

        viewportLock?.restore()
        viewportLock = KeyboardViewportLock(scrollView: webview.scrollView)

        let nc = NotificationCenter.default
        nc.addObserver(
            self,
            selector: #selector(keyboardWillShow(_:)),
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(keyboardDidChangeFrame(_:)),
            name: UIResponder.keyboardDidChangeFrameNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(keyboardDidShow(_:)),
            name: UIResponder.keyboardDidShowNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(keyboardDidHide(_:)),
            name: UIResponder.keyboardDidHideNotification,
            object: nil
        )
    }

    // MARK: - Commands

    @objc public func hide(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.endEditing(true)
            invoke.resolve()
        }
    }

    /// iOS only presents the software keyboard after user-initiated focus.
    @objc public func show(_ invoke: Invoke) throws {
        invoke.resolve()
    }

    /// Recover cached canonical state if the direct JavaScript event was lost.
    /// This command never measures alternate geometry or changes the WebView.
    @objc public func getState(_ invoke: Invoke) throws {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                invoke.resolve(
                    KeyboardInsetStateResponse(
                        height: 0,
                        isOpen: false,
                        isHiding: false
                    )
                )
                return
            }
            invoke.resolve(self.stateResponse())
        }
    }

    // MARK: - Keyboard handling

    private func animationDuration(from userInfo: [AnyHashable: Any]?) -> Double {
        (userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
    }

    /// Initial appearance and mid-session resizes share one target event.
    private func emitTarget(height: CGFloat, durationMs: Double) {
        emit("target", "{\"height\":\(Double(height)),\"durationMs\":\(durationMs),\"measurement\":\"exact\"}")
    }

    private func emitSettled(height: CGFloat) {
        emit("settled", "{\"height\":\(Double(height))}")
    }

    private func handleWillFrame(_ notification: Notification) {
        guard let webView = webView,
              let userInfo = notification.userInfo,
              let screenFrame = userInfo[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
        else { return }

        let inset = keyboardInset(
            webView: webView,
            screenFrame: screenFrame,
            notification: notification
        )
        let duration = animationDuration(from: userInfo)
        if inset > 0 {
            isHiding = false
            if currentTargetHeight == 0 {
                viewportLock?.beginSession()
            }
            guard inset != currentTargetHeight else { return }
            currentTargetHeight = inset
            emitTarget(height: inset, durationMs: duration * 1000)
        } else if currentTargetHeight > 0 {
            // Keep the outer viewport clamped until didHide finalizes.
            isHiding = true
            currentTargetHeight = 0
            emit("willHide", "{\"durationMs\":\(duration * 1000)}")
        }
    }

    private func handleDidFrame(_ notification: Notification) {
        guard let webView = webView,
              let userInfo = notification.userInfo,
              let screenFrame = userInfo[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
        else { return }
        let inset = keyboardInset(
            webView: webView,
            screenFrame: screenFrame,
            notification: notification
        )
        if inset > 0 {
            isHiding = false
            // Recover clamping/target when a will notification was missed.
            viewportLock?.beginSession()
            let missedWill = currentTargetHeight == 0
            currentTargetHeight = inset
            if missedWill {
                emitTarget(height: inset, durationMs: 0)
            }
            guard inset != lastSettledHeight else { return }
            lastSettledHeight = inset
            emitSettled(height: inset)
        } else if currentTargetHeight == 0 {
            // Did frames are confirm-only: transient zero frames must not
            // cancel an active positive target. Hide authority travels through
            // willHide/didHide (or a zero will-change target) instead.
            noteKeyboardHidden()
        }
    }

    private func noteKeyboardHidden() {
        let wasActive = currentTargetHeight > 0 || lastSettledHeight != nil
        currentTargetHeight = 0
        lastSettledHeight = nil
        isHiding = false
        viewportLock?.endSession()
        if wasActive {
            emit("didHide", "{}")
        }
    }

    @objc private func keyboardWillShow(_ notification: Notification) {
        handleWillFrame(notification)
    }

    @objc private func keyboardWillChangeFrame(_ notification: Notification) {
        handleWillFrame(notification)
    }

    @objc private func keyboardWillHide(_ notification: Notification) {
        guard currentTargetHeight > 0 else { return }
        isHiding = true
        currentTargetHeight = 0
        let duration = animationDuration(from: notification.userInfo)
        emit("willHide", "{\"durationMs\":\(duration * 1000)}")
    }

    @objc private func keyboardDidShow(_ notification: Notification) {
        handleDidFrame(notification)
    }

    @objc private func keyboardDidChangeFrame(_ notification: Notification) {
        handleDidFrame(notification)
    }

    @objc private func keyboardDidHide(_ notification: Notification) {
        noteKeyboardHidden()
    }

    private func restoreScrollConfiguration() {
        viewportLock?.restore()
        viewportLock = nil
    }

    deinit {
        restoreScrollConfiguration()
        removeOwnKeyboardObservers()
    }
}

@_cdecl("init_plugin_froglight_keyboard_inset")
@available(iOS 14.0, *)
func initPluginFroglightKeyboardInset() -> Plugin {
    return FroglightKeyboardInsetPlugin()
}
