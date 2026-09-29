import type { DocumentKindId } from './identity.js';
import type { JsonRecord, ResourceTarget } from './blocks/model.js';
import { FroglightError } from './errors.js';

export const MAX_COMPOSITION_DEPTH = 16;
export type CompositionRole = 'preview' | 'transclusion' | 'linked-view';
export type CompositionWriteAuthority = 'none' | 'source';
export type CompositionPlaceholderReason =
  | 'cycle'
  | 'depth'
  | 'missing-target'
  | 'missing-provider'
  | 'missing-view'
  | 'unsupported-address'
  | 'corrupt'
  | 'permission-denied'
  | 'provider-error';

export interface CompositionRequest {
  readonly role: CompositionRole;
  readonly target: ResourceTarget;
  readonly viewId?: string;
  readonly presentation?: JsonRecord;
  readonly overrides?: JsonRecord;
  readonly ancestry?: readonly string[];
}

export interface CompositionAction {
  readonly id: string;
  readonly label: string;
  readonly authority: CompositionWriteAuthority;
  readonly enabled?: boolean;
}

export interface CompositionItem {
  readonly id: string;
  readonly text: string;
  readonly actions?: readonly CompositionAction[];
}

/** Derived visual media carried as plain data; never canonical source content. */
export interface CompositionImage {
  readonly mimeType: 'image/png';
  readonly dataUrl: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export type CompositionSnapshot =
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready';
      readonly title?: string;
      readonly summary?: string;
      readonly image?: CompositionImage;
      readonly images?: readonly CompositionImage[];
      /** Keep source text available to consumers while displaying only its image. */
      readonly imageOnly?: boolean;
      readonly items?: readonly CompositionItem[];
      readonly actions?: readonly CompositionAction[];
      readonly presentation?: {
        readonly type: string;
        readonly data: JsonRecord;
      };
    }
  | {
      readonly state: 'placeholder';
      readonly reason: CompositionPlaceholderReason;
      readonly message: string;
      readonly recoverable: true;
      readonly actions?: readonly CompositionAction[];
      readonly presentation?: {
        readonly type: string;
        readonly data: JsonRecord;
      };
    };

export interface CompositionHandle {
  snapshot(): CompositionSnapshot;
  onDidChange(listener: () => void): { dispose(): void };
  invoke?(actionId: string, input?: JsonRecord): Promise<void> | void;
  dispose(): void;
}

/** Trusted host presentation seam. No product kinds or renderer-library types. */
export interface CompositionPresentationHandle {
  update(snapshot: CompositionSnapshot, readOnly: boolean): void;
  dispose(): void;
}
export interface CompositionPresenter {
  mount(input: {
    parent: unknown;
    snapshot: CompositionSnapshot;
    readOnly: boolean;
    invoke(action: string, input?: JsonRecord): Promise<void>;
    /** Deliberate host-document configuration, separate from source actions. */
    configure?(patch: {
      readonly viewId?: string;
      readonly overrides?: JsonRecord;
    }): void;
    onUnavailable?(): void;
  }): CompositionPresentationHandle | null;
}

export interface CompositionPresentationRegistry extends CompositionPresenter {
  register(id: string, presenter: CompositionPresenter): { dispose(): void };
}

/** Registration withdrawal remounts live slots through the remaining providers. */
export class InMemoryCompositionPresentationRegistry
  implements CompositionPresentationRegistry
{
  readonly #providers = new Map<string, CompositionPresenter>();
  readonly #slots = new Set<() => void>();
  register(id: string, presenter: CompositionPresenter): { dispose(): void } {
    if (this.#providers.has(id))
      throw new Error(`Duplicate composition presenter: ${id}`);
    this.#providers.set(id, presenter);
    for (const refresh of this.#slots) refresh();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#providers.delete(id);
        for (const refresh of this.#slots) refresh();
      },
    };
  }
  mount(
    input: Parameters<CompositionPresenter['mount']>[0],
  ): CompositionPresentationHandle | null {
    if (!('presentation' in input.snapshot) || !input.snapshot.presentation)
      return null;
    let snapshot = input.snapshot as CompositionSnapshot;
    let readOnly = input.readOnly;
    let current: CompositionPresentationHandle | null = null;
    let disposed = false;
    const refresh = () => {
      current?.dispose();
      current = null;
      for (const presenter of [...this.#providers.values()].reverse()) {
        current = presenter.mount({ ...input, snapshot, readOnly });
        if (current) return;
      }
      input.onUnavailable?.();
    };
    this.#slots.add(refresh);
    refresh();
    return {
      update(next, nextReadOnly) {
        if (disposed) return;
        const previousType =
          'presentation' in snapshot ? snapshot.presentation?.type : undefined;
        const nextType =
          'presentation' in next ? next.presentation?.type : undefined;
        snapshot = next;
        readOnly = nextReadOnly;
        if (previousType !== nextType) refresh();
        else current?.update(snapshot, readOnly);
      },
      dispose: () => {
        if (!disposed) {
          disposed = true;
          current?.dispose();
          current = null;
          this.#slots.delete(refresh);
        }
      },
    };
  }
}

export interface CompositionProviderInput extends CompositionRequest {
  readonly ancestry: readonly string[];
}

export interface CompositionProviderRegistration {
  readonly kindId: DocumentKindId;
  readonly roles: readonly CompositionRole[];
  readonly writeAuthority: CompositionWriteAuthority;
  open(input: CompositionProviderInput): CompositionHandle;
}

export interface CompositionRegistry {
  register(provider: CompositionProviderRegistration): { dispose(): void };
  open(request: CompositionRequest): CompositionHandle;
}

export interface ResourceSuggestion {
  readonly target: ResourceTarget;
  readonly label: string;
  readonly detail?: string;
  readonly addresses?: readonly {
    readonly address: string;
    readonly label: string;
  }[];
  readonly views?: readonly {
    readonly viewId: string;
    readonly label: string;
  }[];
}

export interface ResourceResolver {
  search(
    query: string,
  ): Promise<readonly ResourceSuggestion[]> | readonly ResourceSuggestion[];
}

export function compositionKey(
  request: Pick<CompositionRequest, 'role' | 'target' | 'viewId'>,
): string {
  const target = request.target;
  return [
    request.role,
    target.documentId,
    target.kindId,
    target.resourceId,
    target.address ?? '',
    request.viewId ?? '',
  ].join('\u001f');
}

function placeholder(
  reason: CompositionPlaceholderReason,
  message: string,
): CompositionHandle {
  const value: CompositionSnapshot = {
    state: 'placeholder',
    reason,
    message,
    recoverable: true,
    actions: [{ id: 'open-source', label: 'Open source', authority: 'none' }],
  };
  return {
    snapshot: () => value,
    onDidChange: () => ({
      dispose() {
        /* static placeholder has no subscription state */
      },
    }),
    dispose() {
      /* static placeholder owns no resources */
    },
  };
}

function restrictSnapshot(
  snapshot: CompositionSnapshot,
  authority: CompositionWriteAuthority,
): CompositionSnapshot {
  if (
    authority === 'source' ||
    snapshot.state === 'loading' ||
    snapshot.actions === undefined
  )
    return snapshot;
  const actions = snapshot.actions.filter(
    (action) => action.authority === 'none',
  );
  return { ...snapshot, actions } as CompositionSnapshot;
}

interface OwnedRegistration {
  readonly provider: CompositionProviderRegistration;
}

/** Dispatch, lifecycle ownership, and common composition safety policy. */
export class InMemoryCompositionRegistry implements CompositionRegistry {
  readonly #providers = new Map<string, OwnedRegistration>();
  readonly #slots = new Map<() => void, string>();

  register(provider: CompositionProviderRegistration): { dispose(): void } {
    if (provider.roles.length === 0)
      throw new FroglightError(
        'INVALID_COMPOSITION_PROVIDER',
        'provider must declare a role',
      );
    const keys = provider.roles.map((role) => `${provider.kindId}:${role}`);
    if (keys.some((key) => this.#providers.has(key))) {
      throw new FroglightError(
        'DUPLICATE_COMPOSITION_PROVIDER',
        `composition provider already registered for ${provider.kindId}`,
      );
    }
    const owned: OwnedRegistration = { provider };
    for (const key of keys) this.#providers.set(key, owned);
    for (const [refresh, key] of this.#slots) if (keys.includes(key)) refresh();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const key of keys)
          if (this.#providers.get(key) === owned) this.#providers.delete(key);
        for (const [refresh, key] of this.#slots)
          if (keys.includes(key)) refresh();
      },
    };
  }

  open(request: CompositionRequest): CompositionHandle {
    const key = compositionKey(request);
    const ancestry = request.ancestry ?? [];
    if (ancestry.includes(key))
      return placeholder('cycle', 'Recursive composition stopped');
    if (ancestry.length >= MAX_COMPOSITION_DEPTH)
      return placeholder('depth', 'Composition depth limit reached');
    if (
      request.role === 'transclusion' &&
      request.target.address === undefined
    ) {
      return placeholder(
        'unsupported-address',
        'Transclusion requires a stable source address',
      );
    }
    if (
      request.role === 'linked-view' &&
      (request.viewId === undefined || request.viewId === '')
    ) {
      return placeholder(
        'missing-view',
        'Linked view requires a provider-owned view',
      );
    }
    const providerKey = `${request.target.kindId}:${request.role}`;
    let inner: CompositionHandle = placeholder(
      'missing-provider',
      'No provider is available for this content',
    );
    let authority: CompositionWriteAuthority = 'none';
    let subscription: { dispose(): void } | undefined;
    let disposed = false;
    const listeners = new Set<() => void>();
    const publish = () => {
      for (const listener of listeners) listener();
    };
    const refresh = () => {
      subscription?.dispose();
      inner.dispose();
      const owned = this.#providers.get(providerKey);
      authority = owned?.provider.writeAuthority ?? 'none';
      if (!owned)
        inner = placeholder(
          'missing-provider',
          'No provider is available for this content',
        );
      else if (request.role !== 'linked-view' && authority !== 'none')
        inner = placeholder(
          'permission-denied',
          'Read-only composition cannot use a writable provider',
        );
      else {
        try {
          inner = owned.provider.open({
            ...request,
            ancestry: [...ancestry, key],
          });
        } catch {
          inner = placeholder(
            'provider-error',
            'The content provider could not open this reference',
          );
        }
      }
      subscription = inner.onDidChange(publish);
      publish();
    };
    this.#slots.set(refresh, providerKey);
    refresh();
    const wrapped: CompositionHandle = {
      snapshot: () => restrictSnapshot(inner.snapshot(), authority),
      onDidChange: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
      invoke: (actionId: string, input?: JsonRecord) => {
        if (disposed) return;
        const snapshot = inner.snapshot();
        const action =
          snapshot.state === 'loading'
            ? undefined
            : snapshot.actions?.find((candidate) => candidate.id === actionId);
        if (action?.authority === 'source' && authority !== 'source') return;
        return inner.invoke?.(actionId, input);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#slots.delete(refresh);
        subscription?.dispose();
        inner.dispose();
        listeners.clear();
      },
    };
    return wrapped;
  }
}

/** Visibility-controlled mount lifecycle, testable without browser observers. */
export class LazyCompositionController {
  readonly #registry: CompositionRegistry;
  readonly #request: CompositionRequest;
  readonly #listener: (snapshot: CompositionSnapshot) => void;
  #handle: CompositionHandle | null = null;
  #subscription: { dispose(): void } | null = null;

  constructor(
    registry: CompositionRegistry,
    request: CompositionRequest,
    listener: (snapshot: CompositionSnapshot) => void,
  ) {
    this.#registry = registry;
    this.#request = request;
    this.#listener = listener;
  }

  setVisible(visible: boolean): void {
    if (visible && this.#handle === null) {
      this.#handle = this.#registry.open(this.#request);
      this.#subscription = this.#handle.onDidChange(() => this.#publish());
      this.#publish();
    } else if (!visible && this.#handle !== null) {
      this.#subscription?.dispose();
      this.#subscription = null;
      this.#handle.dispose();
      this.#handle = null;
    }
  }

  dispose(): void {
    this.setVisible(false);
  }
  invoke(actionId: string, input?: JsonRecord): Promise<void> | void {
    return this.#handle?.invoke?.(actionId, input);
  }
  #publish(): void {
    if (this.#handle !== null) this.#listener(this.#handle.snapshot());
  }
}
