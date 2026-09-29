// Froglight overlay keyboard viewport lock — iOS host.
//
// Keeps the WKWebView's outer/root scrolling coordinate space stable while
// Froglight owns keyboard avoidance: the outer `WKWebView.scrollView`
// is not a user scroll owner, its contentOffset is clamped to zero, and root
// bouncing stays disabled while mounted.
//
// - Disables the outer UIScrollView while mounted; internal DOM/editor
//   scrollers remain the application scroll owners.
// - KVO on `contentOffset` remains as a defensive programmatic-displacement
//   guard; the scroll-view delegate is never seized.
// - Restores every owned property on teardown.
//
// The clamp target is unconditionally `.zero`, matching the reference
// virtual-keyboard plugin's delegate clamp. Froglight's outer document
// never scrolls (`body { overflow: hidden }`, `#app` fixed `inset: 0`),
// so zero is the only legitimate resting offset. additionally
// disables WKWebView's own keyboard observer registrations in the plugin,
// preventing WebKit and Froglight from competing over keyboard avoidance.

import UIKit
import WebKit

final class KeyboardViewportLock: NSObject {
    private weak var scrollView: UIScrollView?

    private var originalInsetBehavior: UIScrollView.ContentInsetAdjustmentBehavior?
    private var originalAdjustsScrollIndicatorInsets: Bool?
    private var originalIsScrollEnabled: Bool?
    private var originalBounces: Bool?
    private var originalAlwaysBounceVertical: Bool?
    private var originalAlwaysBounceHorizontal: Bool?
    private var originalShowsVerticalScrollIndicator: Bool?
    private var originalShowsHorizontalScrollIndicator: Bool?
    private var originalContentOffset: CGPoint = .zero
    private var hasStoredOriginals = false

    private var isSessionActive = false
    private var offsetObservation: NSKeyValueObservation?
    private var isNormalizing = false

    init(scrollView: UIScrollView) {
        self.scrollView = scrollView
        super.init()
        storeOriginals()
        applyLockConfiguration()
        startObserving()
    }

    // MARK: - Originals

    private func storeOriginals() {
        guard !hasStoredOriginals, let scrollView = scrollView else { return }
        originalInsetBehavior = scrollView.contentInsetAdjustmentBehavior
        originalAdjustsScrollIndicatorInsets = scrollView.automaticallyAdjustsScrollIndicatorInsets
        originalIsScrollEnabled = scrollView.isScrollEnabled
        originalBounces = scrollView.bounces
        originalAlwaysBounceVertical = scrollView.alwaysBounceVertical
        originalAlwaysBounceHorizontal = scrollView.alwaysBounceHorizontal
        originalShowsVerticalScrollIndicator =
            scrollView.showsVerticalScrollIndicator
        originalShowsHorizontalScrollIndicator =
            scrollView.showsHorizontalScrollIndicator
        originalContentOffset = scrollView.contentOffset
        hasStoredOriginals = true
    }

    private func applyLockConfiguration() {
        guard let scrollView = scrollView else { return }
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        // The native WKWebView scroller is not an application scroll owner.
        // Suppressing it prevents UIKit/WebKit gesture-driven root movement;
        // document/editor scrolling remains inside WebKit-owned DOM scrollers.
        scrollView.isScrollEnabled = false
        // Root bouncing would pan the whole application shell; internal
        // DOM scrollers are unaffected by these outer properties.
        scrollView.bounces = false
        scrollView.alwaysBounceVertical = false
        scrollView.alwaysBounceHorizontal = false
        // The outer WebView is never the application's scroll owner, even
        // while the keyboard is closed: hide its native indicators for the
        // lifetime of the lock so tracking the locked scroller cannot flash
        // a root scrollbar. Inner DOM/editor scrollers are unaffected.
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
    }

    // MARK: - Observation (no delegate seizure)

    private func startObserving() {
        offsetObservation = scrollView?.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
            self?.normalizeIfNeeded()
        }
    }

    private var expectedContentOffset: CGPoint {
        // Unconditional zero: the outer document never scrolls, so any
        // nonzero offset observed mid-session is WebKit keyboard handling
        // or programmatic displacement to undo, never a resting position.
        return .zero
    }

    private func normalizeIfNeeded() {
        guard let scrollView = scrollView else { return }
        guard isSessionActive else { return }
        guard !isNormalizing else { return }
        let expected = expectedContentOffset
        guard scrollView.contentOffset != expected else { return }
        // Synchronous guarded correction: displaced state is never visible
        // for a frame; the guard absorbs KVO re-entrancy.
        isNormalizing = true
        scrollView.setContentOffset(expected, animated: false)
        isNormalizing = false
    }

    private func normalizeNow() {
        guard let scrollView = scrollView else { return }
        guard isSessionActive else { return }
        if scrollView.contentOffset != expectedContentOffset {
            scrollView.setContentOffset(expectedContentOffset, animated: false)
        }
    }

    // MARK: - Session

    /// Activate the zero clamp. Idempotent.
    func beginSession() {
        isSessionActive = true
        normalizeNow()
    }

    /// Final normalization to the resting offset, then deactivate.
    /// Idempotent.
    func endSession() {
        normalizeNow()
        isSessionActive = false
    }

    // MARK: - Teardown

    func restore() {
        offsetObservation?.invalidate()
        offsetObservation = nil
        guard let scrollView = scrollView, hasStoredOriginals else { return }
        if let behavior = originalInsetBehavior {
            scrollView.contentInsetAdjustmentBehavior = behavior
        }
        if let adjusts = originalAdjustsScrollIndicatorInsets {
            scrollView.automaticallyAdjustsScrollIndicatorInsets = adjusts
        }
        if let enabled = originalIsScrollEnabled {
            scrollView.isScrollEnabled = enabled
        }
        if let bounces = originalBounces {
            scrollView.bounces = bounces
        }
        if let vertical = originalAlwaysBounceVertical {
            scrollView.alwaysBounceVertical = vertical
        }
        if let horizontal = originalAlwaysBounceHorizontal {
            scrollView.alwaysBounceHorizontal = horizontal
        }
        if let showsVertical = originalShowsVerticalScrollIndicator {
            scrollView.showsVerticalScrollIndicator = showsVertical
        }
        if let showsHorizontal = originalShowsHorizontalScrollIndicator {
            scrollView.showsHorizontalScrollIndicator = showsHorizontal
        }
        // Return the outer scroller to its pre-mount origin.
        scrollView.setContentOffset(originalContentOffset, animated: false)
        hasStoredOriginals = false
        isSessionActive = false
    }

    deinit {
        restore()
    }
}
