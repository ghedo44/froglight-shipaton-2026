/**
 * Packed transferable transport tests (scalability final pass).
 *
 * Parity contract: `sync compile ≡ pack → transfer → unpack` for every
 * Ink tool and every presence combination (pressure/tilt/twist/timing),
 * plus unknown-member preservation, corruption rejection, and byte
 * accounting. Positions/timing are Float64 bit-exact; pressure/tilt/twist
 * pack as Float32 (documented ~1e-8 relative quantization — parity uses
 * 1e-6 rounding, never exact equality, for width-derived geometry).
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  BRUSH_PEN_BRUSH,
  FOUNTAIN_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  PENCIL_BRUSH,
  type InkBrushSpec,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  PACKED_INK_TRANSPORT_VERSION,
  packCompiledInk,
  packInkSamples,
  packedRequestTransfer,
  packedResponseTransfer,
  unpackCompiledInk,
  unpackInkSamples,
  validatePackedCompiledInk,
  validatePackedSamples,
  type PackedCompiledInk,
  type PackedInkCompiledResponse,
  type PackedInkCompileRequest,
  type PackedInkSamples,
} from './packed-protocol.js';
import { longStroke, sharpCorner } from './fixtures.js';
import type { InkSample } from '../model.js';

/**
 * Parity comparison with absolute tolerance: packed transport carries
 * pressure/tilt/twist as Float32 (measured ≤3e-8 deviation end to end),
 * so every finite number must agree within 1e-6 while structure matches
 * exactly. Positions/timing are Float64 bit-exact underneath.
 */
const PARITY_TOLERANCE = 1e-6;

function expectParityClose(
  received: unknown,
  expected: unknown,
  path = '$',
): void {
  if (
    typeof received === 'number' &&
    typeof expected === 'number'
  ) {
    if (Number.isNaN(received) && Number.isNaN(expected)) return;
    expect(
      Math.abs(received - expected),
      `${path}: ${String(received)} vs ${String(expected)}`,
    ).toBeLessThanOrEqual(PARITY_TOLERANCE);
    return;
  }
  if (Array.isArray(received) || Array.isArray(expected)) {
    expect(Array.isArray(received) && Array.isArray(expected), path).toBe(
      true,
    );
    const a = received as unknown[];
    const b = expected as unknown[];
    expect(a.length, `${path}.length`).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expectParityClose(a[i], b[i], `${path}[${i}]`);
    }
    return;
  }
  if (
    typeof received === 'object' &&
    received !== null &&
    typeof expected === 'object' &&
    expected !== null
  ) {
    const a = received as Record<string, unknown>;
    const b = expected as Record<string, unknown>;
    // Functions (rehydrated curve closures) compare by behavior elsewhere;
    // skip them here so structural comparison stays total.
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
      (key) => typeof a[key] !== 'function' && typeof b[key] !== 'function',
    );
    for (const key of keys) {
      expectParityClose(a[key], b[key], `${path}.${key}`);
    }
    return;
  }
  expect(received, path).toEqual(expected);
}

function tilted(count: number): InkSample[] {
  return longStroke(count).map((s, i) => ({
    ...s,
    tilt: { x: 0.12 + (i % 5) * 0.01, y: -0.08 },
    // Strictly inside (−π, π): exact ±π inputs wrap in the compiler, and
    // Float32 quantization at the boundary would flip the wrap side.
    twist: ((i * 0.37) % 5.6) - 2.8,
  }));
}

function bare(count: number): InkSample[] {
  return longStroke(count).map((s) => ({ x: s.x, y: s.y }));
}

function withExtras(count: number): InkSample[] {
  return longStroke(count).map((s, i) => ({
    ...s,
    customTag: `tag-${i % 3}`,
    customFlag: i % 2 === 0,
  })) as InkSample[];
}

const TOOLS: readonly (readonly [string, InkBrushSpec])[] = [
  ['ball', BALL_PEN_BRUSH],
  ['fountain', FOUNTAIN_PEN_BRUSH],
  ['brush', BRUSH_PEN_BRUSH],
  ['pencil', PENCIL_BRUSH],
  ['highlighter', HIGHLIGHTER_BRUSH],
];

describe('packed samples round trip', () => {
  it('preserves positions/timing exactly and optionals within float32', () => {
    for (const samples of [longStroke(200), tilted(120), bare(80)]) {
      const { packed, transfer, bytes } = packInkSamples(samples);
      expect(packed.version).toBe(PACKED_INK_TRANSPORT_VERSION);
      expect(packed.count).toBe(samples.length);
      expect(transfer.length).toBeGreaterThan(0);
      expect(bytes).toBeGreaterThan(0);
      // Transfer covers every packed buffer exactly once.
      const seen = new Set(transfer);
      expect(seen.size).toBe(transfer.length);
      const back = unpackInkSamples(structuredClone(packed));
      expect(back.length).toBe(samples.length);
      for (let i = 0; i < samples.length; i++) {
        expect(back[i]!.x).toBe(samples[i]!.x);
        expect(back[i]!.y).toBe(samples[i]!.y);
        expect(back[i]!.dt).toBe(samples[i]!.dt);
      }
      expectParityClose(back, samples);
    }
  });

  it('omits extras when no sample carries unknown members', () => {
    const { packed } = packInkSamples(bare(10));
    expect(packed.extras).toBeUndefined();
  });

  it('preserves unknown per-sample members', () => {
    const samples = withExtras(30);
    const { packed } = packInkSamples(samples);
    expect(packed.extras).toBeDefined();
    const back = unpackInkSamples(structuredClone(packed));
    expectParityClose(back, samples);
    expect((back[7] as unknown as Record<string, unknown>).customTag).toBe(
      'tag-1',
    );
  });

  it('rejects malformed input', () => {
    const { packed } = packInkSamples(bare(4));
    expect(validatePackedSamples(packed)).toBeNull();
    expect(
      validatePackedSamples({ ...packed, version: 999 }),
    ).not.toBeNull();
    expect(
      validatePackedSamples({ ...packed, count: packed.count + 1 }),
    ).not.toBeNull();
    const truncated = { ...packed, positionXY: packed.positionXY.slice(0, 4) };
    expect(validatePackedSamples(truncated)).not.toBeNull();
    expect(() =>
      unpackInkSamples({ ...packed, count: packed.count + 1 }),
    ).toThrow();
    expect(() =>
      packInkSamples([{ x: Number.NaN, y: 0 } as InkSample]),
    ).toThrow();
  });
});

describe('packed compiled geometry round trip', () => {
  it('is bit-exact for verbatim geometry across tools', () => {
    for (const [name, brush] of TOOLS) {
      const compiled = compileInkStroke(tilted(150), brush);
      const { packed, transfer, bytes } = packCompiledInk(compiled);
      expect(packed.version).toBe(PACKED_INK_TRANSPORT_VERSION);
      expect(transfer.length).toBeGreaterThan(0);
      expect(bytes).toBeGreaterThan(0);
      const back = unpackCompiledInk(structuredClone(packed));
      expect(back.nodes).toEqual(compiled.nodes);
      expect(back.polygon).toEqual(compiled.polygon);
      expect(back.bounds).toEqual(compiled.bounds);
      expect(back.mesh.left).toEqual(compiled.mesh.left);
      expect(back.mesh.right).toEqual(compiled.mesh.right);
      expect(back.mesh.ring).toEqual(compiled.mesh.ring);
      expect([...back.mesh.leftFans.entries()]).toEqual([
        ...compiled.mesh.leftFans.entries(),
      ]);
      expect([...back.mesh.rightFans.entries()]).toEqual([
        ...compiled.mesh.rightFans.entries(),
      ]);
      expect(back.curve.controlCount).toBe(compiled.curve.controlCount);
      expect(back.curve.cornerCount).toBe(compiled.curve.cornerCount);
      expect(back.curve.dot).toEqual(compiled.curve.dot);
      expect(
        back.curve.segments.map((s) => s.startsRun === true),
      ).toEqual(
        compiled.curve.segments.map((s) => s.startsRun === true),
      );
      // Rehydrated closures reproduce vertices exactly.
      for (const node of back.nodes) {
        const seg = back.curve.segments[node.segmentIndex];
        if (seg === undefined) continue;
        const p = seg.position(node.u);
        expect(p.x).toBeCloseTo(node.x, 9);
        expect(p.y).toBeCloseTo(node.y, 9);
      }
      void name;
    }
  });

  it('round-trips corners, dots, and empty strokes', () => {
    const cornered = compileInkStroke(sharpCorner(), BALL_PEN_BRUSH);
    expect(
      cornered.curve.segments.some((s) => s.startsRun === true),
    ).toBe(true);
    const backCornered = unpackCompiledInk(
      structuredClone(packCompiledInk(cornered).packed),
    );
    expect(backCornered.nodes).toEqual(cornered.nodes);
    expect(
      backCornered.curve.segments.map((s) => s.startsRun === true),
    ).toEqual(cornered.curve.segments.map((s) => s.startsRun === true));

    const dotted = compileInkStroke(
      [{ x: 5, y: 5, pressure: 0.6, dt: 0 }],
      BALL_PEN_BRUSH,
    );
    const backDot = unpackCompiledInk(
      structuredClone(packCompiledInk(dotted).packed),
    );
    expect(backDot.curve.dot).toEqual(dotted.curve.dot);
    expect(backDot.polygon).toEqual(dotted.polygon);
  });

  it('rejects corrupt payloads (shared cache-restoration gate)', () => {
    const compiled = compileInkStroke(longStroke(60), BALL_PEN_BRUSH);
    const { packed } = packCompiledInk(compiled);
    expect(validatePackedCompiledInk(packed)).toBeNull();
    expect(
      validatePackedCompiledInk({ ...packed, version: 999 }),
    ).not.toBeNull();
    expect(
      validatePackedCompiledInk({ ...packed, nodeCount: packed.nodeCount + 1 }),
    ).not.toBeNull();
    // Truncated fan vertices (forced mismatch even when this stroke
    // carries no fans: append a stray vertex pair).
    const strayFans =
      packed.leftFanXY.length === 0
        ? new Float64Array([1, 2])
        : packed.leftFanXY.slice(
            0,
            Math.max(0, packed.leftFanXY.length - 2),
          );
    expect(
      validatePackedCompiledInk({ ...packed, leftFanXY: strayFans }),
    ).not.toBeNull();
    // Non-monotonic fan offsets.
    const badOffsets = new Uint32Array(packed.leftFanOffsets);
    if (badOffsets.length > 2) {
      badOffsets[1] = badOffsets[badOffsets.length - 1]! + 10;
      expect(
        validatePackedCompiledInk({ ...packed, leftFanOffsets: badOffsets }),
      ).not.toBeNull();
    }
    // Node segment index out of range.
    const badSegments = new Int32Array(packed.nodeSegment);
    if (badSegments.length > 0) badSegments[0] = packed.segmentCount + 5;
    expect(
      validatePackedCompiledInk({ ...packed, nodeSegment: badSegments }),
    ).not.toBeNull();
    // Negative bounds size.
    const badBounds = new Float64Array(packed.boundsXYWH);
    badBounds[2] = -3;
    expect(
      validatePackedCompiledInk({ ...packed, boundsXYWH: badBounds }),
    ).not.toBeNull();
    // Non-finite node position.
    const badNodes = new Float64Array(packed.nodeXY);
    if (badNodes.length > 0) badNodes[0] = Number.NaN;
    expect(() =>
      unpackCompiledInk({ ...packed, nodeXY: badNodes }),
    ).toThrow();
    expect(() =>
      unpackCompiledInk({ ...packed, version: 999 }),
    ).toThrow();
  });
});

describe('packed worker envelopes', () => {
  it('request/response carry instrumentation and transfer lists', () => {
    const samples = tilted(100);
    const { packed: samplePacked, bytes: inputBytes } =
      packInkSamples(samples);
    const request: PackedInkCompileRequest = {
      type: 'compile-ink',
      requestId: 'r1',
      objectId: 's1',
      generation: 3,
      samples: samplePacked,
      brush: BALL_PEN_BRUSH,
      packMs: 1.5,
      inputBytes,
    };
    // No InkSample[]/Point[] object graphs on the wire: positions are one
    // Float64Array, and buffers transfer rather than clone.
    expect(request.samples.positionXY).toBeInstanceOf(Float64Array);
    expect(request.samples.positionXY.length).toBe(200);
    expect(packedRequestTransfer(request).length).toBeGreaterThan(0);
    expect(request.inputBytes).toBeGreaterThan(0);

    const live = unpackInkSamples(structuredClone(request.samples));
    const compiled = compileInkStroke(live, request.brush);
    const { packed, bytes } = packCompiledInk(compiled);
    const response: PackedInkCompiledResponse = {
      type: 'compiled-ink',
      requestId: 'r1',
      objectId: 's1',
      generation: 3,
      compiled: packed,
      workerUnpackMs: 0.5,
      compileMs: 7,
      packMs: 1,
      outputBytes: bytes,
    };
    expect(packedResponseTransfer(response).length).toBeGreaterThan(0);
    expect(response.outputBytes).toBeGreaterThan(0);
    const back = unpackCompiledInk(structuredClone(response.compiled));
    expectParityClose(back.nodes, compiled.nodes);
    expectParityClose(back.polygon, compiled.polygon);
  });

  it(
    'sync vs packed round trip parity across tools and inputs',
    () => {
      const inputs: readonly (readonly [string, InkSample[]])[] = [
      ['pressure+timing', longStroke(160)],
      ['tilt+twist+timing', tilted(140)],
      ['bare', bare(90)],
      ['extras', withExtras(70)],
      ['corner', sharpCorner()],
    ];
    for (const [toolName, brush] of TOOLS) {
      for (const [inputName, samples] of inputs) {
        const sync = compileInkStroke(samples, brush);
        // Simulate the thread hop: pack → clone (transfer) → unpack →
        // same compile → pack → clone → unpack.
        const live = unpackInkSamples(
          structuredClone(packInkSamples(samples).packed),
        );
        const workerBuilt = compileInkStroke(live, brush);
        const back = unpackCompiledInk(
          structuredClone(packCompiledInk(workerBuilt).packed),
        );
        expectParityClose(
          back.nodes,
          sync.nodes,
          `${toolName}/${inputName} nodes`,
        );
        expectParityClose(
          back.polygon,
          sync.polygon,
          `${toolName}/${inputName} polygon`,
        );
        expectParityClose(
          back.bounds,
          sync.bounds,
          `${toolName}/${inputName} bounds`,
        );
        expectParityClose(
          back.mesh.ring,
          sync.mesh.ring,
          `${toolName}/${inputName} ring`,
        );
        expect(
          back.curve.segments.map((s) => s.startsRun === true),
          `${toolName}/${inputName} runs`,
        ).toEqual(sync.curve.segments.map((s) => s.startsRun === true));
      }
    }
    },
    120_000,
  );

  it('packed types satisfy the scheduler/worker envelope contract', () => {
    // Compile-time shape check: these assignments fail loudly if the
    // envelopes drift from what the scheduler posts and the worker reads.
    const samples: PackedInkSamples = packInkSamples(bare(2)).packed;
    const compiled: PackedCompiledInk = packCompiledInk(
      compileInkStroke(bare(8), BALL_PEN_BRUSH),
    ).packed;
    const request: PackedInkCompileRequest = {
      type: 'compile-ink',
      requestId: 'r',
      objectId: 'o',
      generation: 1,
      samples,
      brush: BALL_PEN_BRUSH,
    };
    void request;
    void compiled;
  });
});
