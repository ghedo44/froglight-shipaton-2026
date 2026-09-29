import { createElement } from 'react';
import { FROG_MARK_RECTS, FROG_MARK_VIEWBOX } from '../frog-mark.js';

export interface FrogMarkProps {
  readonly size?: number;
  readonly className?: string;
}

/**
 * The Froglight frog, drawn from the canonical square-module geometry.
 * Decorative by default: parents own the accessible name.
 */
export function FrogMark({
  size,
  className,
}: FrogMarkProps): React.ReactElement {
  return createElement(
    'svg',
    {
      className: ['froglight-frog-mark', className ?? '']
        .filter(Boolean)
        .join(' '),
      viewBox: FROG_MARK_VIEWBOX,
      width: size,
      height: size,
      shapeRendering: 'crispEdges',
      'aria-hidden': true,
      focusable: false,
    },
    FROG_MARK_RECTS.map(([x, y, width, height, fill], index) =>
      createElement('rect', { key: index, x, y, width, height, fill }),
    ),
  );
}
