// Froglight stylus accessories and input policy — iOS host.
//
// Low-frequency input policy, Apple Pencil double-tap, squeeze, and
// capability reports. Stroke samples stay in the WKWebView's PointerEvent
// pipeline and never cross the native bridge.
//
// Events travel through a direct JavaScript evaluation because the Tauri
// plugin event channel adds latency an accessory action (undo, tool
// switch) must not pay. Capabilities are also queryable as state via
// `getCapabilities` so bootstrap ordering cannot lose the load-time report
// when the JS forwarder installs later.
//
// Coordinate contract:
//   x/y = WKWebView viewport coordinates in logical points / CSS-pixel
//   space, origin = top-left of the WKWebView.
// The interaction is attached to the WKWebView, so `hoverPose.location`
// arrives in the WebView's coordinate space; it is rounded once here before
// emitting the canonical event. React must never understand UIKit screen
// coordinates. Physical-device validation should confirm
// `hoverPose.location ≈ PointerEvent clientX/clientY` within a small
// tolerance.
import Tauri
import UIKit
import WebKit

/// Canonical Froglight string for one Apple Pencil preferred action.
///
/// Single mapping point for tap and squeeze handlers: every currently known
/// `UIPencilPreferredAction` maps to its device-neutral contract value and
/// future cases degrade to `unknown` without breaking event delivery.
@available(iOS 12.1, *)
func froglightPreferredActionName(_ action: UIPencilPreferredAction) -> String {
    switch action {
    case .ignore: return "ignore"
    case .switchEraser: return "switchEraser"
    case .switchPrevious: return "switchPrevious"
    case .showColorPalette: return "showColorPalette"
    case .showInkAttributes: return "showInkAttributes"
    case .showContextualPalette: return "showContextualPalette"
    case .runSystemShortcut: return "runSystemShortcut"
    @unknown default: return "unknown"
    }
}

private enum StylusInputContext: String, Decodable {
    case `default`
    case drawing
    case textEntry = "text-entry"
}

private struct InputContextArgs: Decodable {
    let context: StylusInputContext
}

private protocol IndirectScribbleInteractionMarker: UIInteraction {}
extension UIIndirectScribbleInteraction: IndirectScribbleInteractionMarker {}

private struct SuspendedScribbleInteraction {
    weak var view: UIView?
    let interaction: any IndirectScribbleInteractionMarker
}

class FroglightStylusPlugin: Plugin, UIScribbleInteractionDelegate {
    private weak var webView: WKWebView?
    private var pencilInteraction: UIPencilInteraction?
    private var scribbleInteraction: UIScribbleInteraction?
    private var suspendedScribble: [SuspendedScribbleInteraction] = []
    // Read and written only on main; no bridge/DOM work during arbitration.
    private var inputContext: StylusInputContext = .default

    /// Current native-host capability state. Host capabilities describe API
    /// support, never observed hardware: only pressure/tilt are universally
    /// true for the Pencil path; hover/twist/doubleTap/squeeze depend on the
    /// specific Pencil model and are promoted through observed actions.
    private var capabilities: [String: Bool] = [
        "available": true,
        "pressure": true,
        "tilt": true,
        "twist": false,
        "hover": false,
        "eraser": false,
        "barrelButton": false,
        "doubleTap": false,
        "squeeze": false,
    ]

    // Runs on the main thread (gesture/interaction threads).
    private func emitAction(_ json: String) {
        webView?.evaluateJavaScript(
            "window.__FROGLIGHT_STYLUS_EVENT__ && window.__FROGLIGHT_STYLUS_EVENT__('action', \(json))",
            completionHandler: nil)
    }

    private func emitCapabilities() {
        let pairs = capabilities.map { "\"\($0.key)\":\($0.value)" }.sorted().joined(separator: ",")
        webView?.evaluateJavaScript(
            "window.__FROGLIGHT_STYLUS_EVENT__ && window.__FROGLIGHT_STYLUS_EVENT__('capabilities', {\(pairs)})",
            completionHandler: nil)
    }

    /// Canonical anchor fragment for one hover-pose location, or nil when no
    /// pose is available. Never manufactures `{0,0}`: absence means absence.
    private func anchorFragment(for location: CGPoint?) -> String? {
        guard let location = location, location.x.isFinite, location.y.isFinite else {
            return nil
        }
        // WKWebView points == CSS px under `width=device-width`; round once
        // here so the contract carries integers.
        let x = Int(location.x.rounded())
        let y = Int(location.y.rounded())
        return "\"anchor\":{\"x\":\(x),\"y\":\(y)}"
    }

    public override func load(webview: WKWebView) {
        // One interaction per loaded WebView: detach any previous interaction
        // before attaching so reloads never duplicate squeeze/double-tap.
        if let previous = pencilInteraction, let oldView = webView {
            oldView.removeInteraction(previous)
        }
        if let previous = scribbleInteraction {
            previous.view?.removeInteraction(previous)
        }
        restoreWebKitScribble()
        self.webView = webview

        let scribble = UIScribbleInteraction(delegate: self)
        webview.addInteraction(scribble)
        scribbleInteraction = scribble
        syncWebKitScribble()

        // UIPencilInteraction is passive by design: the system delivers
        // double-tap/squeeze to the delegate without touching the
        // WebView's touch pipeline, so drawing events are unaffected.
        if #available(iOS 12.1, *) {
            let interaction = UIPencilInteraction()
            interaction.delegate = self
            webview.addInteraction(interaction)
            self.pencilInteraction = interaction
        }

        emitCapabilities()
    }

    @objc public func getCapabilities(_ invoke: Invoke) throws {
        invoke.resolve(capabilities)
    }

    @objc public func setInputContext(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(InputContextArgs.self)
        DispatchQueue.main.async { [weak self] in
            guard let self = self else {
                invoke.reject("Stylus plugin is unavailable")
                return
            }
            self.inputContext = args.context
            self.syncWebKitScribble()
            invoke.resolve()
        }
    }

    func scribbleInteraction(
        _ interaction: UIScribbleInteraction,
        shouldBeginAt location: CGPoint
    ) -> Bool {
        return inputContext != .drawing
    }

    // WebKit installs UIIndirectScribbleInteraction on its content subview.
    // A UIScribbleInteraction on the outer WKWebView cannot veto that path.
    // Use public interaction types and preserve WebKit's original instance and
    // delegate; no private selectors, class names or gesture recognizers.
    private func syncWebKitScribble() {
        guard inputContext == .drawing, let view = webView else {
            restoreWebKitScribble()
            return
        }
        func suspend(in view: UIView) {
            for interaction in view.interactions {
                if let scribble = interaction as? any IndirectScribbleInteractionMarker {
                    suspendedScribble.append(SuspendedScribbleInteraction(view: view, interaction: scribble))
                    view.removeInteraction(scribble)
                }
            }
            for child in view.subviews { suspend(in: child) }
        }
        suspend(in: view)
    }

    private func restoreWebKitScribble() {
        for suspended in suspendedScribble {
            if let view = suspended.view, suspended.interaction.view == nil {
                view.addInteraction(suspended.interaction)
            }
        }
        suspendedScribble.removeAll()
    }

    deinit {
        restoreWebKitScribble()
        if let interaction = pencilInteraction, let view = webView {
            view.removeInteraction(interaction)
        }
        pencilInteraction = nil
        if let interaction = scribbleInteraction {
            interaction.view?.removeInteraction(interaction)
        }
        scribbleInteraction = nil
    }
}

@available(iOS 12.1, *)
extension FroglightStylusPlugin: UIPencilInteractionDelegate {
    // Legacy double-tap path (iPadOS <17.5): the only tap callback on older
    // systems. Deprecated in iOS 17.5 in favor of didReceiveTap, which the
    // OS calls instead on newer systems — never both for one tap. No hover
    // pose is available through the legacy callback, so no anchor is
    // invented; the user's preferred action is still forwarded.
    func pencilInteractionDidTap(
        _ interaction: UIPencilInteraction
    ) {
        let preferred = froglightPreferredActionName(UIPencilInteraction.preferredTapAction)
        emitAction("{\"type\":\"doubleTap\",\"preferredAction\":\"\(preferred)\"}")
    }

    @available(iOS 17.5, *)
    func pencilInteraction(
        _ interaction: UIPencilInteraction,
        didReceiveTap tap: UIPencilInteraction.Tap
    ) {
        // One physical tap emits one logical action.
        let preferred = froglightPreferredActionName(UIPencilInteraction.preferredTapAction)
        var json = "{\"type\":\"doubleTap\",\"preferredAction\":\"\(preferred)\""
        if let fragment = anchorFragment(for: tap.hoverPose?.location) {
            json += ",\(fragment)"
        }
        json += "}"
        emitAction(json)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(
        _ interaction: UIPencilInteraction,
        didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze
    ) {
        // Squeeze exists on iOS 17.5+ (Pencil Pro). The delegate method is
        // optional, so older runtimes simply never call it. Only squeeze
        // interaction updates cross native IPC — no arbitrary Pencil
        // movement is streamed.
        let phase: String
        switch squeeze.phase {
        case .began: phase = "began"
        case .changed: phase = "changed"
        case .ended: phase = "ended"
        case .cancelled: phase = "cancelled"
        @unknown default: return
        }
        let preferred = froglightPreferredActionName(UIPencilInteraction.preferredSqueezeAction)
        var json = "{\"type\":\"squeeze\",\"phase\":\"\(phase)\",\"preferredAction\":\"\(preferred)\""
        // Repeat the latest anchor on `changed` when available so the palette
        // can follow the Pencil without a coordinate stream.
        if let fragment = anchorFragment(for: squeeze.hoverPose?.location) {
            json += ",\(fragment)"
        }
        json += "}"
        emitAction(json)
    }
}

@_cdecl("init_plugin_froglight_stylus")
@available(iOS 14.0, *)
func initPluginFroglightStylus() -> Plugin {
    return FroglightStylusPlugin()
}
