/**
 * Minimal ambient declarations for platform globals used by the foundation
 * package.
 *
 * `TextEncoder`/`TextDecoder` (WHATWG Encoding) and `AbortSignal`/
 * `AbortController` are globals in Node.js >= 15 and every evergreen
 * browser. The foundation package is platform-shared: it must not depend on
 * Node or DOM type libraries, so minimal interfaces are declared here
 * instead. They deliberately expose only the members this package uses.
 *
 * `declare var` is required for ambient global constructors; the no-var rule
 * is disabled here because `declare const` would forbid the constructor
 * pattern used below.
 */

/* eslint-disable no-var */

interface URL {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
}

declare var URL: {
  new (url: string | URL, base?: string | URL): URL;
  readonly prototype: URL;
};

interface TextEncoder {
  encode(input?: string): Uint8Array;
}

declare var TextEncoder: {
  new (): TextEncoder;
  readonly prototype: TextEncoder;
};

interface TextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

declare var TextDecoder: {
  new (): TextDecoder;
  readonly prototype: TextDecoder;
};

interface AbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

declare var AbortSignal: {
  new (): AbortSignal;
  readonly prototype: AbortSignal;
};

interface AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

declare var AbortController: {
  new (): AbortController;
  readonly prototype: AbortController;
};
