/**
 * Recording Canvas2D stub for provider tests running under jsdom
 * (spec #52). Lets Surface engine mounts run without real pixels: every
 * backend call records into a log or no-ops, while `getContext('2d')`
 * returns a working object so capability probes succeed.
 *
 * Framework-neutral on purpose: this module names no DOM library types
 * (foundation compiles without a DOM lib) and touches `globalThis` only
 * when installed.
 */

/** Minimal shape of the canvas element prototype for stubbing. */
interface CanvasPrototype {
  getContext(id: string, options?: unknown): unknown;
}

function canvasPrototype(): CanvasPrototype | null {
  const holder = globalThis as unknown as {
    HTMLCanvasElement?: { prototype?: CanvasPrototype };
  };
  return holder.HTMLCanvasElement?.prototype ?? null;
}

function recordingContext(log?: Array<[string, ...unknown[]]>): Record<string, unknown> {
  const record =
    (name: string) =>
    (...args: never[]): void => {
      log?.push([name, ...args]);
    };
  return {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    rect: record('rect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    ellipse: record('ellipse'),
    translate: record('translate'),
    rotate: record('rotate'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    arc: record('arc'),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
}

/**
 * Installs the stub and returns a restore function. Pass a log to record
 * every backend call; omit it for a pure no-op context.
 */
export function installCanvasStub(
  log?: Array<[string, ...unknown[]]>,
): () => void {
  const proto = canvasPrototype();
  if (proto === null) return () => undefined;
  const context = recordingContext(log);
  const original = proto.getContext;
  proto.getContext = () => context;
  return () => {
    proto.getContext = original;
  };
}
