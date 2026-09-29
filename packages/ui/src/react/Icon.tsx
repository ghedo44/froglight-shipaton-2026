import { createElement } from 'react';
import { resolveIconPath } from '../icons.js';

export interface IconProps {
  readonly name: string;
  readonly size?: number;
  readonly className?: string;
}

/** React twin of createIcon(): same 24px grid, stroke system, and registry. */
export function Icon({ name, size = 16, className }: IconProps): React.ReactElement {
  const path = resolveIconPath(name);
  return createElement(
    'svg',
    {
      className: ['froglight-icon', `icon-${name}`, className ?? ''].filter(Boolean).join(' '),
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    createElement('path', { d: path ?? '' }),
  );
}
