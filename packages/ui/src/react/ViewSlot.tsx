import type { ViewDef } from '../view-registry.js';

/**
 * Host one registered `ViewDef` inside the React tree.
 *
 * Views declare a React `component` mounted directly inside the keyed host
 * element (— the imperative `render(container)` contract is
 * removed). Keyed by view id: a new view gets a fresh host element, so
 * entrance animations on the container replay.
 */
export function ViewSlot(props: {
  view: ViewDef | undefined;
  className?: string;
  readonly 'data-fl-keyboard-viewport'?: string;
}): React.ReactElement {
  const { view, className } = props;
  const Component = view?.component;
  return (
    <div
      key={view?.id}
      className={className}
      {...(props['data-fl-keyboard-viewport'] !== undefined
        ? { 'data-fl-keyboard-viewport': props['data-fl-keyboard-viewport'] }
        : {})}
    >
      {Component !== undefined ? <Component /> : null}
    </div>
  );
}

