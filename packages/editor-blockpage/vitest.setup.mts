/**
 * Minimal DOM geometry shims so ProseMirror's view layer can run under
 * jsdom (which implements no layout). All rects are zero-sized.
 */
const zeroRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
});

for (const proto of [Element.prototype, Range.prototype, Text.prototype]) {
  if (typeof (proto as unknown as { getClientRects?: unknown }).getClientRects !== 'function') {
    (proto as unknown as { getClientRects: () => unknown[] }).getClientRects = function () {
      return [zeroRect()];
    };
  }
  if (typeof (proto as unknown as { getBoundingClientRect?: unknown }).getBoundingClientRect !== 'function') {
    (proto as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = zeroRect;
  }
}
if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null;
}
