/**
 * Packed transferable Ink compilation transport (scalability final pass).
 *
 * Versioned binary/typed-array format shared by Worker requests, Worker
 * responses, AND the persistent compiled-geometry cache — one format, not
 * three. Replaces the `InkSample[]` / `Point[]` structured-clone object
 * graphs: thousands of `{x, y, ...}` objects never cross threads.
 *
 * ```text
 * main thread                        worker
 * packInkSamples() ──transfer──▶ unpackInkSamples()
 *                                     compileInkStroke() (same impl)
 * packCompiledInk() ◀─transfer── unpackCompiledInk()
 * ```
 *
 * Buffers transfer ownership (`postMessage(msg, transfer)`) instead of
 * deep-cloning. Nullable numerics use a sentinel/flag contract: presence
 * bits are authoritative; absent slots hold NaN (Float64) or 0 (Float32).
 * Unknown per-sample/per-node `extras` (rare, schema-less) ride alongside
 * as plain data — omitted entirely when no sample/node carries any.
 *
 * All geometry arrays are Float64 (bit-exact); pressure/tilt/twist pack as
 * Float32 (1e-8 relative quantization — parity tests pin the tolerance).
 * Every unpack path validates before accepting (shared with persistent
 * cache restoration): version, counts, array lengths, finiteness,
 * bounds, offsets, and indexes. Malformed data throws; callers treat that
 * as cache-miss / worker-fallback, never as corrupt state.
 */

import type { Point } from '../geometry.js';
import type { InkSample } from '../model.js';
import type { InkBrushSpec } from './brush.js';
import type {
  CompiledInkStroke,
  InkGeometryOptions,
  InkStrokeNode,
} from './compiler.js';
import type { InkInterpolatedAttributes } from './curve.js';
import {
  rehydrateCompiledInk,
  type SerializableCompiledInk,
  type SerializedInkNode,
} from './compile-protocol.js';

/** Packed transport format version (bump on any layout change). */
export const PACKED_INK_TRANSPORT_VERSION = 1;

/** Sample presence bits (`PackedInkSamples.presence`). */
export const PRES_HAS_PRESSURE = 1;
export const PRES_HAS_TILT = 2;
export const PRES_HAS_TWIST = 4;
export const PRES_HAS_DT = 8;

/** Node flag bits (`PackedCompiledInk.nodeFlags`). */
export const NODE_HAS_CORNER = 1;

/** Known numeric sample members (everything else is `extras`). */
const KNOWN_SAMPLE_KEYS = new Set([
  'x',
  'y',
  'pressure',
  'tilt',
  'twist',
  'dt',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Packed samples (main → worker)
// ---------------------------------------------------------------------------

/**
 * Canonical stroke samples as packed transferable typed arrays.
 * `extras` is present only when at least one sample carries unknown
 * members (otherwise absent — no per-sample objects cross at all).
 */
export interface PackedInkSamples {
  readonly version: number;
  readonly count: number;
  /** Interleaved XY positions, length `2 * count` (Float64, bit-exact). */
  readonly positionXY: Float64Array;
  /** Length `count` (Float32; absent slots read 0, presence bit decides). */
  readonly pressure: Float32Array;
  /** Interleaved tilt XY, length `2 * count` (Float32, radians). */
  readonly tiltXY: Float32Array;
  /** Length `count` (Float32, radians). */
  readonly twist: Float32Array;
  /** Length `count` (Float64, milliseconds, bit-exact). */
  readonly dt: Float64Array;
  /** Presence bits per sample (`PRES_*`). */
  readonly presence: Uint8Array;
  /** Unknown per-sample members, length `count`, when any exist. */
  readonly extras?: readonly (Record<string, unknown> | undefined)[];
}

export interface PackedSamplesResult {
  readonly packed: PackedInkSamples;
  /** Buffers to transfer (`postMessage(msg, transfer)`). */
  readonly transfer: ArrayBuffer[];
  /** Total input bytes (diagnostics: `workerInputBytes`). */
  readonly bytes: number;
}

/** Collect the distinct backing buffers of packed samples. */
export function packedSamplesTransfer(packed: PackedInkSamples): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  out.add(packed.positionXY.buffer as ArrayBuffer);
  out.add(packed.pressure.buffer as ArrayBuffer);
  out.add(packed.tiltXY.buffer as ArrayBuffer);
  out.add(packed.twist.buffer as ArrayBuffer);
  out.add(packed.dt.buffer as ArrayBuffer);
  out.add(packed.presence.buffer as ArrayBuffer);
  return [...out];
}

function packedSamplesBytes(packed: PackedInkSamples): number {
  return (
    packed.positionXY.byteLength +
    packed.pressure.byteLength +
    packed.tiltXY.byteLength +
    packed.twist.byteLength +
    packed.dt.byteLength +
    packed.presence.byteLength
  );
}

/** Pack canonical samples into transferable typed arrays (no copies kept). */
export function packInkSamples(
  samples: readonly InkSample[],
): PackedSamplesResult {
  const count = samples.length;
  const positionXY = new Float64Array(count * 2);
  const pressure = new Float32Array(count);
  const tiltXY = new Float32Array(count * 2);
  const twist = new Float32Array(count);
  const dt = new Float64Array(count);
  const presence = new Uint8Array(count);
  let extras: (Record<string, unknown> | undefined)[] | undefined;
  for (let i = 0; i < count; i++) {
    const s = samples[i]!;
    const x = (s as { x?: unknown }).x;
    const y = (s as { y?: unknown }).y;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      throw new Error(`packed samples: non-finite position at index ${i}`);
    }
    positionXY[i * 2] = x;
    positionXY[i * 2 + 1] = y;
    let flags = 0;
    if (isFiniteNumber(s.pressure)) {
      pressure[i] = s.pressure;
      flags |= PRES_HAS_PRESSURE;
    } else {
      pressure[i] = 0;
    }
    const tilt = (s as { tilt?: unknown }).tilt as
      | { x?: unknown; y?: unknown }
      | null
      | undefined;
    if (
      tilt !== null &&
      tilt !== undefined &&
      isFiniteNumber(tilt.x) &&
      isFiniteNumber(tilt.y)
    ) {
      tiltXY[i * 2] = tilt.x;
      tiltXY[i * 2 + 1] = tilt.y;
      flags |= PRES_HAS_TILT;
    } else {
      tiltXY[i * 2] = 0;
      tiltXY[i * 2 + 1] = 0;
    }
    if (isFiniteNumber(s.twist)) {
      twist[i] = s.twist;
      flags |= PRES_HAS_TWIST;
    } else {
      twist[i] = 0;
    }
    if (isFiniteNumber(s.dt)) {
      dt[i] = s.dt;
      flags |= PRES_HAS_DT;
    } else {
      dt[i] = Number.NaN;
    }
    presence[i] = flags;
    // Unknown members ride alongside (preservation); usually absent.
    const raw = s as unknown as Record<string, unknown>;
    let extra: Record<string, unknown> | undefined;
    for (const key of Object.keys(raw)) {
      if (!KNOWN_SAMPLE_KEYS.has(key)) {
        if (extra === undefined) extra = {};
        extra[key] = raw[key];
      }
    }
    if (extra !== undefined) {
      if (extras === undefined) extras = new Array(count).fill(undefined);
      extras[i] = extra;
    }
  }
  const packed: PackedInkSamples = {
    version: PACKED_INK_TRANSPORT_VERSION,
    count,
    positionXY,
    pressure,
    tiltXY,
    twist,
    dt,
    presence,
    ...(extras !== undefined ? { extras } : {}),
  };
  return {
    packed,
    transfer: packedSamplesTransfer(packed),
    bytes: packedSamplesBytes(packed),
  };
}

/** Structural validation for packed samples (shared worker/cache gate). */
export function validatePackedSamples(packed: PackedInkSamples): string | null {
  if (typeof packed !== 'object' || packed === null) return 'not an object';
  if (packed.version !== PACKED_INK_TRANSPORT_VERSION) {
    return `unsupported version ${String(packed.version)}`;
  }
  if (!Number.isInteger(packed.count) || packed.count < 0) {
    return 'bad count';
  }
  const n = packed.count;
  if (
    !(packed.positionXY instanceof Float64Array) ||
    packed.positionXY.length !== n * 2
  ) {
    return 'bad positionXY';
  }
  if (
    !(packed.pressure instanceof Float32Array) ||
    packed.pressure.length !== n
  ) {
    return 'bad pressure';
  }
  if (
    !(packed.tiltXY instanceof Float32Array) ||
    packed.tiltXY.length !== n * 2
  ) {
    return 'bad tiltXY';
  }
  if (!(packed.twist instanceof Float32Array) || packed.twist.length !== n) {
    return 'bad twist';
  }
  if (!(packed.dt instanceof Float64Array) || packed.dt.length !== n) {
    return 'bad dt';
  }
  if (
    !(packed.presence instanceof Uint8Array) ||
    packed.presence.length !== n
  ) {
    return 'bad presence';
  }
  for (let i = 0; i < n; i++) {
    if (
      !Number.isFinite(packed.positionXY[i * 2]!) ||
      !Number.isFinite(packed.positionXY[i * 2 + 1]!)
    ) {
      return `non-finite position at ${i}`;
    }
  }
  if (packed.extras !== undefined) {
    if (!Array.isArray(packed.extras) || packed.extras.length !== n) {
      return 'bad extras';
    }
  }
  return null;
}

/** Unpack transferable samples back to `InkSample[]` (validated; throws). */
export function unpackInkSamples(packed: PackedInkSamples): InkSample[] {
  const problem = validatePackedSamples(packed);
  if (problem !== null) throw new Error(`packed samples: ${problem}`);
  const out: InkSample[] = new Array(packed.count);
  for (let i = 0; i < packed.count; i++) {
    const flags = packed.presence[i]!;
    const sample: Record<string, unknown> = {
      x: packed.positionXY[i * 2]!,
      y: packed.positionXY[i * 2 + 1]!,
    };
    if ((flags & PRES_HAS_PRESSURE) !== 0) {
      sample.pressure = packed.pressure[i]!;
    }
    if ((flags & PRES_HAS_TILT) !== 0) {
      sample.tilt = {
        x: packed.tiltXY[i * 2]!,
        y: packed.tiltXY[i * 2 + 1]!,
      };
    }
    if ((flags & PRES_HAS_TWIST) !== 0) sample.twist = packed.twist[i]!;
    if ((flags & PRES_HAS_DT) !== 0) {
      const dt = packed.dt[i]!;
      if (Number.isFinite(dt)) sample.dt = dt;
    }
    const extra = packed.extras?.[i];
    if (extra !== undefined) {
      for (const [key, value] of Object.entries(extra)) sample[key] = value;
    }
    out[i] = sample as unknown as InkSample;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packed compiled geometry (worker → main, also persistent cache payload)
// ---------------------------------------------------------------------------

/**
 * Compiled stroke geometry as packed transferable typed arrays.
 * Nodes/polygon/mesh transfer VERBATIM (Float64, bit-exact); curve
 * closures rehydrate on the main thread by interpolating the transferred
 * tessellation (same contract as the serial protocol).
 */
export interface PackedCompiledInk {
  readonly version: number;
  readonly nodeCount: number;
  /** Interleaved spine XY, `2 * nodeCount` (verbatim). */
  readonly nodeXY: Float64Array;
  /** Resolved widths, `nodeCount` (verbatim). */
  readonly nodeWidth: Float64Array;
  /** Filtered pressures, `nodeCount` (verbatim). */
  readonly nodePressure: Float64Array;
  /** Interleaved tilt XY, `2 * nodeCount` (NaN when absent). */
  readonly nodeTiltXY: Float64Array;
  /** `nodeCount` (NaN when absent). */
  readonly nodeTwist: Float64Array;
  /** `nodeCount` (NaN when absent). */
  readonly nodeDt: Float64Array;
  /** Flag bits per node (`NODE_*`). */
  readonly nodeFlags: Uint8Array;
  /** Owning segment per node (`nodeCount`, -1 for dots). */
  readonly nodeSegment: Int32Array;
  /** Segment-local parameter per node. */
  readonly nodeU: Float64Array;
  /** Control-arc per node. */
  readonly nodeArc: Float64Array;
  /** Corner tangents per node, `4 * nodeCount` (valid when flagged). */
  readonly nodeCorner: Float64Array;
  /** Unknown per-node members, when any exist. */
  readonly nodeExtras?: readonly (Record<string, unknown> | undefined)[];
  /** Closed outline ring XY (verbatim). */
  readonly polygonXY: Float64Array;
  /** Left/right offset runs + closed ring (verbatim). */
  readonly meshLeftXY: Float64Array;
  readonly meshRightXY: Float64Array;
  readonly meshRingXY: Float64Array;
  /** Fan prefix offsets, `nodeCount + 1` (monotonic). */
  readonly leftFanOffsets: Uint32Array;
  readonly leftFanXY: Float64Array;
  readonly rightFanOffsets: Uint32Array;
  readonly rightFanXY: Float64Array;
  /** Axis-aligned bounds `[x, y, width, height]`. */
  readonly boundsXYWH: Float64Array;
  /** Curve summary (segment closures rehydrate from nodes). */
  readonly controlCount: number;
  /** Absent corner count encodes as -1. */
  readonly cornerCount: number;
  readonly segmentCount: number;
  /** Per-segment `startsRun` flags (0/1). */
  readonly startsRun: Uint8Array;
  /** Dot present flag (0/1). */
  readonly dotPresent: number;
  /** Dot position XY. */
  readonly dotXY: Float64Array;
  /** Dot attributes `[pressure, tiltX, tiltY, twist, dt]` (NaN absent). */
  readonly dotAttrs: Float64Array;
}

export interface PackedCompiledResult {
  readonly packed: PackedCompiledInk;
  readonly transfer: ArrayBuffer[];
  readonly bytes: number;
}

const PACKED_GEOMETRY_FIELDS = [
  'nodeXY',
  'nodeWidth',
  'nodePressure',
  'nodeTiltXY',
  'nodeTwist',
  'nodeDt',
  'nodeFlags',
  'nodeSegment',
  'nodeU',
  'nodeArc',
  'nodeCorner',
  'polygonXY',
  'meshLeftXY',
  'meshRightXY',
  'meshRingXY',
  'leftFanOffsets',
  'leftFanXY',
  'rightFanOffsets',
  'rightFanXY',
  'boundsXYWH',
  'startsRun',
  'dotXY',
  'dotAttrs',
] as const;

/**
 * Packed-geometry size in bytes (sum of every typed-array field). Used by
 * the byte-bounded derived cache; never allocates, never scans elements.
 */
export function packedCompiledByteLength(packed: PackedCompiledInk): number {
  let bytes = 0;
  const record = packed as unknown as Record<string, unknown>;
  for (const field of PACKED_GEOMETRY_FIELDS) {
    const view = record[field];
    if (ArrayBuffer.isView(view)) bytes += view.byteLength;
  }
  return bytes;
}

/** Interleaved XY fields rebased by a derived translation. */
const PACKED_XY_FIELDS = [
  'nodeXY',
  'polygonXY',
  'meshLeftXY',
  'meshRightXY',
  'meshRingXY',
  'leftFanXY',
  'rightFanXY',
  'dotXY',
] as const;

/**
 * World-coordinate rebase of an already-packed compiled geometry.
 *
 * The packed copy is LOCAL geometry; persistence stores world coordinates
 * by adding the record's accumulated derived translation to every
 * interleaved XY array (bounds shift the same way). Non-XY arrays are
 * shared by reference — this never recompiles, never touches the source
 * packed value, and copies only the XY fields that actually move.
 * `tx === 0 && ty === 0` returns the source unchanged (zero work).
 */
export function rebasePackedCompiledInk(
  packed: PackedCompiledInk,
  tx: number,
  ty: number,
): PackedCompiledInk {
  if (tx === 0 && ty === 0) return packed;
  const record = packed as unknown as Record<string, unknown>;
  const shifted: Record<string, unknown> = { ...record };
  for (const field of PACKED_XY_FIELDS) {
    const source = record[field] as Float64Array;
    const next = new Float64Array(source.length);
    for (let i = 0; i + 1 < source.length; i += 2) {
      next[i] = source[i]! + tx;
      next[i + 1] = source[i + 1]! + ty;
    }
    shifted[field] = next;
  }
  const bounds = record['boundsXYWH'] as Float64Array;
  const nextBounds = new Float64Array(4);
  nextBounds[0] = bounds[0]! + tx;
  nextBounds[1] = bounds[1]! + ty;
  nextBounds[2] = bounds[2]!;
  nextBounds[3] = bounds[3]!;
  shifted['boundsXYWH'] = nextBounds;
  return shifted as unknown as PackedCompiledInk;
}

function copyXY(
  points: readonly Point[],
  tx: number,
  ty: number,
): Float64Array {
  const out = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[i * 2] = points[i]!.x + tx;
    out[i * 2 + 1] = points[i]!.y + ty;
  }
  return out;
}

function packFans(
  fans: ReadonlyMap<number, readonly Point[]>,
  nodeCount: number,
  tx: number,
  ty: number,
): { offsets: Uint32Array; vertices: Float64Array } {
  const offsets = new Uint32Array(nodeCount + 1);
  let total = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = total;
    total += fans.get(i)?.length ?? 0;
  }
  offsets[nodeCount] = total;
  const vertices = new Float64Array(total * 2);
  let at = 0;
  for (let i = 0; i < nodeCount; i++) {
    const fan = fans.get(i);
    if (fan === undefined) continue;
    for (const p of fan) {
      vertices[at * 2] = p.x + tx;
      vertices[at * 2 + 1] = p.y + ty;
      at += 1;
    }
  }
  return { offsets, vertices };
}

/**
 * Pack compiled geometry into transferable typed arrays.
 *
 * `translation` rebases the packed copy into world coordinates: persisted
 * geometry must carry the record's accumulated derived translation so a
 * restored record renders at its canonical world position (compiled
 * geometry itself stays immutable and local — this is an explicit
 * persistence-time rebase, never a recompile or a translation-path copy).
 */
export function packCompiledInk(
  compiled: CompiledInkStroke,
  translation?: { readonly tx: number; readonly ty: number },
): PackedCompiledResult {
  const tx = translation === undefined ? 0 : translation.tx;
  const ty = translation === undefined ? 0 : translation.ty;
  const n = compiled.nodes.length;
  const nodeXY = new Float64Array(n * 2);
  const nodeWidth = new Float64Array(n);
  const nodePressure = new Float64Array(n);
  const nodeTiltXY = new Float64Array(n * 2);
  const nodeTwist = new Float64Array(n);
  const nodeDt = new Float64Array(n);
  const nodeFlags = new Uint8Array(n);
  const nodeSegment = new Int32Array(n);
  const nodeU = new Float64Array(n);
  const nodeArc = new Float64Array(n);
  const nodeCorner = new Float64Array(n * 4);
  let nodeExtras: (Record<string, unknown> | undefined)[] | undefined;
  for (let i = 0; i < n; i++) {
    const node = compiled.nodes[i]!;
    nodeXY[i * 2] = node.x + tx;
    nodeXY[i * 2 + 1] = node.y + ty;
    nodeWidth[i] = node.width;
    nodePressure[i] = node.pressure;
    nodeTiltXY[i * 2] = node.tiltX ?? Number.NaN;
    nodeTiltXY[i * 2 + 1] = node.tiltY ?? Number.NaN;
    nodeTwist[i] = node.twist ?? Number.NaN;
    nodeDt[i] = node.dt ?? Number.NaN;
    nodeFlags[i] = node.corner !== undefined ? NODE_HAS_CORNER : 0;
    nodeSegment[i] = node.segmentIndex;
    nodeU[i] = node.u;
    nodeArc[i] = node.controlArc;
    if (node.corner !== undefined) {
      nodeCorner[i * 4] = node.corner.inTx;
      nodeCorner[i * 4 + 1] = node.corner.inTy;
      nodeCorner[i * 4 + 2] = node.corner.outTx;
      nodeCorner[i * 4 + 3] = node.corner.outTy;
    } else {
      nodeCorner[i * 4] = 0;
      nodeCorner[i * 4 + 1] = 0;
      nodeCorner[i * 4 + 2] = 0;
      nodeCorner[i * 4 + 3] = 0;
    }
    if (Object.keys(node.extras).length > 0) {
      if (nodeExtras === undefined) {
        nodeExtras = new Array(n).fill(undefined);
      }
      nodeExtras[i] = { ...node.extras };
    }
  }
  const left = packFans(compiled.mesh.leftFans, n, tx, ty);
  const right = packFans(compiled.mesh.rightFans, n, tx, ty);
  const segments = compiled.curve.segments;
  const startsRun = new Uint8Array(segments.length);
  for (let s = 0; s < segments.length; s++) {
    startsRun[s] = segments[s]!.startsRun === true ? 1 : 0;
  }
  const dot = compiled.curve.dot;
  const dotAttrs = new Float64Array(5);
  const attrs: InkInterpolatedAttributes = dot?.attributes ?? {
    pressure: 0.5,
    tiltX: null,
    tiltY: null,
    twist: null,
    dt: null,
  };
  dotAttrs[0] = attrs.pressure;
  dotAttrs[1] = attrs.tiltX ?? Number.NaN;
  dotAttrs[2] = attrs.tiltY ?? Number.NaN;
  dotAttrs[3] = attrs.twist ?? Number.NaN;
  dotAttrs[4] = attrs.dt ?? Number.NaN;
  const packed: PackedCompiledInk = {
    version: PACKED_INK_TRANSPORT_VERSION,
    nodeCount: n,
    nodeXY,
    nodeWidth,
    nodePressure,
    nodeTiltXY,
    nodeTwist,
    nodeDt,
    nodeFlags,
    nodeSegment,
    nodeU,
    nodeArc,
    nodeCorner,
    ...(nodeExtras !== undefined ? { nodeExtras } : {}),
    polygonXY: copyXY(compiled.polygon, tx, ty),
    meshLeftXY: copyXY(compiled.mesh.left, tx, ty),
    meshRightXY: copyXY(compiled.mesh.right, tx, ty),
    meshRingXY: copyXY(compiled.mesh.ring, tx, ty),
    leftFanOffsets: left.offsets,
    leftFanXY: left.vertices,
    rightFanOffsets: right.offsets,
    rightFanXY: right.vertices,
    boundsXYWH: new Float64Array([
      compiled.bounds.x + tx,
      compiled.bounds.y + ty,
      compiled.bounds.width,
      compiled.bounds.height,
    ]),
    controlCount: compiled.curve.controlCount,
    cornerCount: compiled.curve.cornerCount ?? -1,
    segmentCount: segments.length,
    startsRun,
    dotPresent: dot === null ? 0 : 1,
    dotXY: new Float64Array([(dot?.x ?? 0) + tx, (dot?.y ?? 0) + ty]),
    dotAttrs,
  };
  const transfer = new Set<ArrayBuffer>();
  for (const value of Object.values(packed)) {
    if (ArrayBuffer.isView(value)) {
      transfer.add(value.buffer as ArrayBuffer);
    }
  }
  let bytes = 0;
  for (const buffer of transfer) bytes += buffer.byteLength;
  return { packed, transfer: [...transfer], bytes };
}

/** Structural validation for packed compiled geometry (worker/cache gate). */
export function validatePackedCompiledInk(
  packed: PackedCompiledInk,
): string | null {
  if (typeof packed !== 'object' || packed === null) return 'not an object';
  if (packed.version !== PACKED_INK_TRANSPORT_VERSION) {
    return `unsupported version ${String(packed.version)}`;
  }
  if (!Number.isInteger(packed.nodeCount) || packed.nodeCount < 0) {
    return 'bad nodeCount';
  }
  const n = packed.nodeCount;
  const f64 = (value: unknown, length: number): value is Float64Array =>
    value instanceof Float64Array && value.length === length;
  if (!f64(packed.nodeXY, n * 2)) return 'bad nodeXY';
  if (!f64(packed.nodeWidth, n)) return 'bad nodeWidth';
  if (!f64(packed.nodePressure, n)) return 'bad nodePressure';
  if (!f64(packed.nodeTiltXY, n * 2)) return 'bad nodeTiltXY';
  if (!f64(packed.nodeTwist, n)) return 'bad nodeTwist';
  if (!f64(packed.nodeDt, n)) return 'bad nodeDt';
  if (
    !(packed.nodeFlags instanceof Uint8Array) ||
    packed.nodeFlags.length !== n
  ) {
    return 'bad nodeFlags';
  }
  if (
    !(packed.nodeSegment instanceof Int32Array) ||
    packed.nodeSegment.length !== n
  ) {
    return 'bad nodeSegment';
  }
  if (!f64(packed.nodeU, n)) return 'bad nodeU';
  if (!f64(packed.nodeArc, n)) return 'bad nodeArc';
  if (!f64(packed.nodeCorner, n * 4)) return 'bad nodeCorner';
  if (
    !(packed.polygonXY instanceof Float64Array) ||
    packed.polygonXY.length % 2 !== 0
  ) {
    return 'bad polygonXY';
  }
  if (
    !(packed.meshLeftXY instanceof Float64Array) ||
    packed.meshLeftXY.length % 2 !== 0
  ) {
    return 'bad meshLeftXY';
  }
  if (
    !(packed.meshRightXY instanceof Float64Array) ||
    packed.meshRightXY.length % 2 !== 0
  ) {
    return 'bad meshRightXY';
  }
  if (
    !(packed.meshRingXY instanceof Float64Array) ||
    packed.meshRingXY.length % 2 !== 0
  ) {
    return 'bad meshRingXY';
  }
  const offsetsOk = (offsets: unknown): offsets is Uint32Array => {
    if (!(offsets instanceof Uint32Array) || offsets.length !== n + 1)
      return false;
    if (offsets[0] !== 0) return false;
    for (let i = 0; i <= n; i++) {
      if (offsets[i]! > offsets[n]!) return false;
      if (i > 0 && offsets[i]! < offsets[i - 1]!) return false;
    }
    return true;
  };
  if (!offsetsOk(packed.leftFanOffsets)) return 'bad leftFanOffsets';
  if (!(packed.leftFanXY instanceof Float64Array)) return 'bad leftFanXY';
  if (packed.leftFanXY.length !== packed.leftFanOffsets[n]! * 2) {
    return 'left fan length mismatch';
  }
  if (!offsetsOk(packed.rightFanOffsets)) return 'bad rightFanOffsets';
  if (!(packed.rightFanXY instanceof Float64Array)) return 'bad rightFanXY';
  if (packed.rightFanXY.length !== packed.rightFanOffsets[n]! * 2) {
    return 'right fan length mismatch';
  }
  if (!f64(packed.boundsXYWH, 4)) return 'bad boundsXYWH';
  const [bx, by, bw, bh] = [
    packed.boundsXYWH[0]!,
    packed.boundsXYWH[1]!,
    packed.boundsXYWH[2]!,
    packed.boundsXYWH[3]!,
  ];
  if (!Number.isFinite(bx) || !Number.isFinite(by)) return 'bad bounds origin';
  if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw < 0 || bh < 0) {
    return 'bad bounds size';
  }
  if (!Number.isInteger(packed.controlCount) || packed.controlCount < 0) {
    return 'bad controlCount';
  }
  if (!Number.isInteger(packed.cornerCount) || packed.cornerCount < -1) {
    return 'bad cornerCount';
  }
  if (!Number.isInteger(packed.segmentCount) || packed.segmentCount < 0) {
    return 'bad segmentCount';
  }
  if (
    !(packed.startsRun instanceof Uint8Array) ||
    packed.startsRun.length !== packed.segmentCount
  ) {
    return 'bad startsRun';
  }
  for (let i = 0; i < packed.startsRun.length; i++) {
    if (packed.startsRun[i]! > 1) return `bad startsRun value at ${i}`;
  }
  const finiteOrAbsent = (value: number): boolean =>
    Number.isFinite(value) || Number.isNaN(value);
  for (let i = 0; i < n; i++) {
    if (
      !Number.isFinite(packed.nodeXY[i * 2]!) ||
      !Number.isFinite(packed.nodeXY[i * 2 + 1]!)
    ) {
      return `non-finite node ${i}`;
    }
    const width = packed.nodeWidth[i]!;
    if (!Number.isFinite(width) || width < 0) return `bad width ${i}`;
    if (!Number.isFinite(packed.nodePressure[i]!)) {
      return `non-finite pressure ${i}`;
    }
    if (
      !finiteOrAbsent(packed.nodeTiltXY[i * 2]!) ||
      !finiteOrAbsent(packed.nodeTiltXY[i * 2 + 1]!) ||
      !finiteOrAbsent(packed.nodeTwist[i]!) ||
      !finiteOrAbsent(packed.nodeDt[i]!)
    ) {
      return `non-finite node attribute ${i}`;
    }
    if (!Number.isFinite(packed.nodeU[i]!)) return `non-finite node U ${i}`;
    if (!Number.isFinite(packed.nodeArc[i]!) || packed.nodeArc[i]! < 0) {
      return `bad node arc ${i}`;
    }
    const flags = packed.nodeFlags[i]!;
    if ((flags & ~NODE_HAS_CORNER) !== 0) return `unknown node flags at ${i}`;
    for (let k = 0; k < 4; k++) {
      if (!Number.isFinite(packed.nodeCorner[i * 4 + k]!)) {
        return `non-finite corner tangent ${i}`;
      }
    }
    const seg = packed.nodeSegment[i]!;
    if (!Number.isInteger(seg) || seg < -1 || seg >= packed.segmentCount) {
      return `node ${i} segment out of range`;
    }
  }
  const finiteXY = (values: Float64Array, label: string): string | null => {
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i]!)) return `non-finite ${label} at ${i}`;
    }
    return null;
  };
  const polygonProblem = finiteXY(packed.polygonXY, 'polygon XY');
  if (polygonProblem !== null) return polygonProblem;
  const meshLeftProblem = finiteXY(packed.meshLeftXY, 'mesh left XY');
  if (meshLeftProblem !== null) return meshLeftProblem;
  const meshRightProblem = finiteXY(packed.meshRightXY, 'mesh right XY');
  if (meshRightProblem !== null) return meshRightProblem;
  const meshRingProblem = finiteXY(packed.meshRingXY, 'mesh ring XY');
  if (meshRingProblem !== null) return meshRingProblem;
  const leftFanProblem = finiteXY(packed.leftFanXY, 'left fan XY');
  if (leftFanProblem !== null) return leftFanProblem;
  const rightFanProblem = finiteXY(packed.rightFanXY, 'right fan XY');
  if (rightFanProblem !== null) return rightFanProblem;
  if (packed.dotPresent !== 0 && packed.dotPresent !== 1)
    return 'bad dotPresent';
  if (!f64(packed.dotXY, 2)) return 'bad dotXY';
  if (
    !Number.isFinite(packed.dotXY[0]!) ||
    !Number.isFinite(packed.dotXY[1]!)
  ) {
    return 'non-finite dot position';
  }
  if (!f64(packed.dotAttrs, 5)) return 'bad dotAttrs';
  if (!Number.isFinite(packed.dotAttrs[0]!)) return 'non-finite dot pressure';
  for (let i = 1; i < 5; i++) {
    if (!finiteOrAbsent(packed.dotAttrs[i]!)) {
      return 'non-finite dot attribute';
    }
  }
  if (packed.nodeExtras !== undefined) {
    if (!Array.isArray(packed.nodeExtras) || packed.nodeExtras.length !== n) {
      return 'bad nodeExtras';
    }
  }
  return null;
}

function unpackXY(values: Float64Array): Point[] {
  const out: Point[] = new Array(values.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = { x: values[i * 2]!, y: values[i * 2 + 1]! };
  }
  return out;
}

function unpackFans(
  offsets: Uint32Array,
  vertices: Float64Array,
): [number, Point[]][] {
  const out: [number, Point[]][] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    const start = offsets[i]!;
    const end = offsets[i + 1]!;
    if (end <= start) continue;
    const fan: Point[] = new Array(end - start);
    for (let k = start; k < end; k++) {
      fan[k - start] = { x: vertices[k * 2]!, y: vertices[k * 2 + 1]! };
    }
    out.push([i, fan]);
  }
  return out;
}

function numOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Structural tripwires (closure pass): main-thread rich unpacks vs packed
 * draws. Cached committed rendering must stay in typed-array form (0
 * unpacks, N packed draws). Live editing may still unpack (hit-test,
 * selection, eraser lazily materialize single items).
 */
export const packedRenderCounters = {
  /** Synchronous `unpackCompiledInk` calls on the main thread. */
  synchronousRichUnpacks: 0,
  /** Packed-stroke draw items created (committed, no object graph). */
  packedDrawItemsCreated: 0,
  /** Packed-stroke draw items rendered by the backend. */
  packedDrawItemsRendered: 0,
};

export function resetPackedRenderCounters(): void {
  packedRenderCounters.synchronousRichUnpacks = 0;
  packedRenderCounters.packedDrawItemsCreated = 0;
  packedRenderCounters.packedDrawItemsRendered = 0;
}

/**
 * Unpack transferable geometry back to `CompiledInkStroke` (validated;
 * throws on malformed data). Nodes/polygon/bounds/mesh are verbatim;
 * curve closures rehydrate from the transferred tessellation through the
 * shared serial-protocol lane interpolation (exact at vertices).
 */
export function unpackCompiledInk(
  packed: PackedCompiledInk,
): CompiledInkStroke {
  packedRenderCounters.synchronousRichUnpacks += 1;
  const problem = validatePackedCompiledInk(packed);
  if (problem !== null) throw new Error(`packed compiled ink: ${problem}`);
  const nodes: SerializedInkNode[] = new Array(packed.nodeCount);
  for (let i = 0; i < packed.nodeCount; i++) {
    const flagged = (packed.nodeFlags[i]! & NODE_HAS_CORNER) !== 0;
    nodes[i] = {
      x: packed.nodeXY[i * 2]!,
      y: packed.nodeXY[i * 2 + 1]!,
      width: packed.nodeWidth[i]!,
      pressure: packed.nodePressure[i]!,
      tiltX: numOrNull(packed.nodeTiltXY[i * 2]!),
      tiltY: numOrNull(packed.nodeTiltXY[i * 2 + 1]!),
      twist: numOrNull(packed.nodeTwist[i]!),
      dt: numOrNull(packed.nodeDt[i]!),
      extras: { ...(packed.nodeExtras?.[i] ?? {}) },
      segmentIndex: packed.nodeSegment[i]!,
      u: packed.nodeU[i]!,
      controlArc: packed.nodeArc[i]!,
      ...(flagged
        ? {
            corner: {
              inTx: packed.nodeCorner[i * 4]!,
              inTy: packed.nodeCorner[i * 4 + 1]!,
              outTx: packed.nodeCorner[i * 4 + 2]!,
              outTy: packed.nodeCorner[i * 4 + 3]!,
            },
          }
        : {}),
    };
  }
  const dotAttrs: InkInterpolatedAttributes = {
    pressure: packed.dotAttrs[0]!,
    tiltX: numOrNull(packed.dotAttrs[1]!),
    tiltY: numOrNull(packed.dotAttrs[2]!),
    twist: numOrNull(packed.dotAttrs[3]!),
    dt: numOrNull(packed.dotAttrs[4]!),
  };
  const serial: SerializableCompiledInk = {
    nodes,
    polygon: unpackXY(packed.polygonXY),
    bounds: {
      x: packed.boundsXYWH[0]!,
      y: packed.boundsXYWH[1]!,
      width: packed.boundsXYWH[2]!,
      height: packed.boundsXYWH[3]!,
    },
    mesh: {
      left: unpackXY(packed.meshLeftXY),
      right: unpackXY(packed.meshRightXY),
      ring: unpackXY(packed.meshRingXY),
      leftFans: unpackFans(packed.leftFanOffsets, packed.leftFanXY),
      rightFans: unpackFans(packed.rightFanOffsets, packed.rightFanXY),
    },
    curve: {
      controlCount: packed.controlCount,
      ...(packed.cornerCount >= 0 ? { cornerCount: packed.cornerCount } : {}),
      dot:
        packed.dotPresent === 1
          ? {
              x: packed.dotXY[0]!,
              y: packed.dotXY[1]!,
              attributes: { ...dotAttrs },
            }
          : null,
      segmentCount: packed.segmentCount,
      startsRun: Array.from(packed.startsRun, (flag) => flag === 1),
    },
  };
  return rehydrateCompiledInk(serial);
}

// ---------------------------------------------------------------------------
// Worker envelopes (packed payloads + plain-data brush/options)
// ---------------------------------------------------------------------------

/** Cold compile request (main thread → worker). Samples transfer; brush clones. */
export interface PackedInkCompileRequest {
  readonly type: 'compile-ink';
  readonly requestId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly samples: PackedInkSamples;
  readonly brush: InkBrushSpec;
  readonly options?: InkGeometryOptions;
  /** Main-side pack time in ms (observability: `workerPackMs`). */
  readonly packMs?: number;
  /** Packed input bytes (observability: `workerInputBytes`). */
  readonly inputBytes?: number;
}

/** Successful cold compile response (worker → main thread). */
export interface PackedInkCompiledResponse {
  readonly type: 'compiled-ink';
  readonly requestId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly compiled: PackedCompiledInk;
  /** Worker-side sample-unpack time in ms. */
  readonly workerUnpackMs: number;
  /** Worker-side `compileInkStroke` time in ms (`workerCompileMs`). */
  readonly compileMs: number;
  /** Worker-side output-pack time in ms. */
  readonly packMs: number;
  /** Packed output bytes (`workerOutputBytes`). */
  readonly outputBytes: number;
}

/** Cold compile failure (worker stays alive for later jobs). */
export interface PackedInkCompileErrorResponse {
  readonly type: 'compile-error';
  readonly requestId: string;
  readonly objectId: string;
  readonly generation: number;
  readonly error: string;
}

export type PackedInkCompileResponse =
  | PackedInkCompiledResponse
  | PackedInkCompileErrorResponse;

/** Buffers to transfer with a packed request envelope. */
export function packedRequestTransfer(
  request: PackedInkCompileRequest,
): ArrayBuffer[] {
  return packedSamplesTransfer(request.samples);
}

/** Buffers to transfer with a packed success response envelope. */
export function packedResponseTransfer(
  response: PackedInkCompiledResponse,
): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const value of Object.values(response.compiled)) {
    if (ArrayBuffer.isView(value)) out.add(value.buffer as ArrayBuffer);
  }
  return [...out];
}

/** Round-trip a node through pack/unpack field mapping (parity helper). */
export function packedNodeEquals(
  node: InkStrokeNode,
  unpacked: InkStrokeNode,
): boolean {
  const sameNullable = (a: number | null, b: number | null): boolean =>
    a === b || (a !== null && b !== null && Object.is(a, b));
  return (
    node.x === unpacked.x &&
    node.y === unpacked.y &&
    node.width === unpacked.width &&
    node.pressure === unpacked.pressure &&
    sameNullable(node.tiltX, unpacked.tiltX) &&
    sameNullable(node.tiltY, unpacked.tiltY) &&
    sameNullable(node.twist, unpacked.twist) &&
    sameNullable(node.dt, unpacked.dt) &&
    node.segmentIndex === unpacked.segmentIndex &&
    node.u === unpacked.u &&
    node.controlArc === unpacked.controlArc
  );
}
