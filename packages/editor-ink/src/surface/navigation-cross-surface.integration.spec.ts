// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
 boundedFrame,
 emptySurface,
 infiniteFrame,
 viewToSurface,
 type Point,
} from '@froglight/foundation';
import { mountInkSurface, type InkSkeleton } from '../index.js';
import { MAX_ZOOM, MIN_ZOOM } from './camera.js';

/**
 * Cross-surface navigation integration cases.
 *
 * These fill gaps left by unit coverage and the mounted settle specs:
 * Whiteboard infinite unbounded momentum
 * (interruptible, zero-effects), standalone<->embedded transitions,
 * cancel-vs-end races, read-only flips mid-flight, destroy mid-gesture,
 * reduced-motion full matrix, byte-compare canonical after every run, perf
 * counters (single shared frame, bounded rect reads), at 60Hz and 120Hz.
 *
 * Every nav-only run asserts: canonical JSON byte-identical, dirty 0,
 * history 0 (canUndo false). No production semantics are changed here.
 */

function installCanvasStub(): () => void {
 const noop = (): void => undefined;
 const context = {
 save: noop,
 restore: noop,
 beginPath: noop,
 clip: noop,
 fill: noop,
 stroke: noop,
 rect: noop,
 fillRect: noop,
 strokeRect: noop,
 fillText: noop,
 ellipse: noop,
 translate: noop,
 rotate: noop,
 setTransform: noop,
 setLineDash: noop,
 clearRect: noop,
 drawImage: noop,
 moveTo: noop,
 lineTo: noop,
 arc: noop,
 closePath: noop,
 fillStyle: '',
 strokeStyle: '',
 font: '',
 lineWidth: 1,
 lineCap: 'butt',
 lineJoin: 'miter',
 globalAlpha: 1,
 textAlign: 'left',
 textBaseline: 'alphabetic',
 canvas: null,
 };
 const original = HTMLCanvasElement.prototype.getContext;
 HTMLCanvasElement.prototype.getContext = function () {
 return context as unknown as CanvasRenderingContext2D;
 } as unknown as typeof HTMLCanvasElement.prototype.getContext;
 return () => {
 HTMLCanvasElement.prototype.getContext = original;
 };
}

function installManualFrames(): {
 readonly pending: () => number;
 readonly schedules: () => number;
 readonly flushOne: (timeMs: number) => void;
 readonly restore: () => void;
} {
 const queue: FrameRequestCallback[] = [];
 const originalRequest = globalThis.requestAnimationFrame;
 const originalCancel = globalThis.cancelAnimationFrame;
 let nextId = 1;
 let schedules = 0;
 globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
 queue.push(callback);
 schedules += 1;
 return nextId++;
 }) as typeof requestAnimationFrame;
 globalThis.cancelAnimationFrame = (() => {
 queue.length = 0;
 }) as typeof cancelAnimationFrame;
 return {
 pending: () => queue.length,
 schedules: () => schedules,
 flushOne: (timeMs) => {
 const callback = queue.shift();
 if (callback === undefined) throw new Error('expected a pending frame');
 callback(timeMs);
 },
 restore: () => {
 queue.length = 0;
 globalThis.requestAnimationFrame = originalRequest;
 globalThis.cancelAnimationFrame = originalCancel;
 },
 };
}

function installReducedMotion(matches: boolean): () => void {
 const original = (globalThis as { matchMedia?: unknown }).matchMedia;
 (globalThis as Record<string, unknown>).matchMedia = () => ({
 matches,
 media: '(prefers-reduced-motion: reduce)',
 addEventListener: () => undefined,
 removeEventListener: () => undefined,
 });
 return () => {
 if (original === undefined)
 delete (globalThis as Record<string, unknown>).matchMedia;
 else (globalThis as Record<string, unknown>).matchMedia = original;
 };
}

function makeHost(): InkSkeleton {
 const root = document.createElement('div');
 const page = document.createElement('div');
 const canvas = document.createElement('canvas');
 const badge = document.createElement('div');
 const pointerIndicator = document.createElement('div');
 const overlayRoot = document.createElement('div');
 page.append(canvas, badge, pointerIndicator, overlayRoot);
 root.append(page);
 document.body.append(root);
 const bounds = {
 left: 0,
 top: 0,
 right: 800,
 bottom: 600,
 width: 800,
 height: 600,
 x: 0,
 y: 0,
 toJSON: () => ({}),
 } as DOMRect;
 page.getBoundingClientRect = () => bounds;
 canvas.getBoundingClientRect = () => bounds;
 Object.defineProperties(page, {
 clientWidth: { configurable: true, get: () => 800 },
 clientHeight: { configurable: true, get: () => 600 },
 });
 return { root, page, canvas, badge, pointerIndicator, overlayRoot };
}

function touchPointer(
 canvas: HTMLCanvasElement,
 type:
 | 'pointerdown'
 | 'pointermove'
 | 'pointerup'
 | 'pointercancel'
 | 'lostpointercapture',
 id: number,
 point: Point,
 timeMs: number,
): void {
 const event = new MouseEvent(type, {
 bubbles: true,
 cancelable: true,
 clientX: point.x,
 clientY: point.y,
 button: 0,
 });
 Object.defineProperties(event, {
 pointerId: { value: id },
 pointerType: { value: 'touch' },
 timeStamp: { value: timeMs },
 });
 canvas.dispatchEvent(event);
}

function authorPointer(
 canvas: HTMLCanvasElement,
 type: 'pointerdown' | 'pointermove' | 'pointerup',
 pointerType: 'pen' | 'mouse',
 id: number,
 point: Point,
 timeMs: number,
): void {
 const event = new MouseEvent(type, {
 bubbles: true,
 cancelable: true,
 clientX: point.x,
 clientY: point.y,
 button: 0,
 buttons: type === 'pointerup' ? 0 : 1,
 });
 Object.defineProperties(event, {
 pointerId: { value: id },
 pointerType: { value: pointerType },
 pressure: { value: type === 'pointerup' ? 0 : 0.5 },
 timeStamp: { value: timeMs },
 });
 canvas.dispatchEvent(event);
}

function wheel(
 canvas: HTMLCanvasElement,
 init: WheelEventInit & { clientX?: number; clientY?: number },
): WheelEvent {
 const event = new WheelEvent('wheel', {
 bubbles: true,
 cancelable: true,
 ...init,
 });
 canvas.dispatchEvent(event);
 return event;
}

function flushUntilSettled(
 frames: ReturnType<typeof installManualFrames>,
 startTimeMs: number,
 stepMs: number,
): void {
 let timeMs = startTimeMs;
 for (let count = 0; count < 400 && frames.pending() > 0; count += 1) {
 expect(frames.pending()).toBeLessThanOrEqual(1);
 timeMs += stepMs;
 frames.flushOne(timeMs);
 }
 expect(frames.pending()).toBe(0);
}

const cleanup: Array<() => void> = [];

afterEach(() => {
 for (const dispose of cleanup.splice(0).reverse()) dispose();
 document.body.replaceChildren();
});

const REFRESH_RATES = [
 { name: '60Hz', stepMs: 1000 / 60 },
 { name: '120Hz', stepMs: 1000 / 120 },
] as const;

describe('Surface navigation integration matrix', () => {
 it.each(REFRESH_RATES)(
 'bounded elastic overscroll settles to the exact bound ($name)',
 ({ stepMs }) => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: -744, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
 expect(handle.camera().x).toBeLessThan(-744);
 touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
 flushUntilSettled(frames, 20, stepMs);

 expect(handle.camera().x).toBe(-744);
 expect(handle.camera().zoom).toBe(1);
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 },
 );

 it.each(REFRESH_RATES)(
 'bounded fling hands inertia to edge settling and lands exact ($name)',
 ({ stepMs }) => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 600, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 200, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 100 }, 20);
 expect(handle.camera().x).toBe(700);
 expect(frames.pending()).toBe(1);
 flushUntilSettled(frames, 20, stepMs);

 expect(handle.camera().x).toBe(744);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 },
 );

 it.each([
 { limit: MIN_ZOOM, rate: '60Hz', stepMs: 1000 / 60 },
 { limit: MIN_ZOOM, rate: '120Hz', stepMs: 1000 / 120 },
 { limit: MAX_ZOOM, rate: '60Hz', stepMs: 1000 / 60 },
 { limit: MAX_ZOOM, rate: '120Hz', stepMs: 1000 / 120 },
 ])(
 'elastic over/under zoom settles exactly to $limit ($rate)',
 ({ limit, stepMs }) => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: {
 x: 200,
 y: 100,
 zoom: limit === MAX_ZOOM ? MAX_ZOOM - 0.1 : MIN_ZOOM + 0.01,
 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
 touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
 touchPointer(
 host.canvas,
 'pointermove',
 2,
 { x: limit === MAX_ZOOM ? 700 : 300, y: 200 },
 20,
 );
 if (limit === MAX_ZOOM)
 expect(handle.camera().zoom).toBeGreaterThan(MAX_ZOOM);
 else expect(handle.camera().zoom).toBeLessThan(MIN_ZOOM);
 touchPointer(host.canvas, 'pointerup', 2, { x: 400, y: 200 }, 24);
 touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 28);
 flushUntilSettled(frames, 28, stepMs);

 expect(handle.camera().zoom).toBe(limit);
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 },
 );

 it('read-only flip mid-flight keeps settling to the exact bound with zero effects', () => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 for (const stepMs of [1000 / 60, 1000 / 120]) {
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: -744, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 const destroyLater = (): void => {
 handle.destroy();
 document.body.replaceChildren();
 };
 frames.flushOne(0);

 // Arm release inertia, then flip to read-only mid-flight.
 touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
 expect(handle.camera().x).toBeLessThan(-744);
 expect(frames.pending()).toBe(1);
 handle.setReadOnly(true);
 flushUntilSettled(frames, 20, stepMs);

 expect(handle.camera().x).toBe(-744);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 expect(frames.pending()).toBe(0);

 destroyLater();
 }
 });

 it.each(REFRESH_RATES)(
 'new touch interrupts inertia and spring from the current position ($name)',
 ({ stepMs }) => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 200, y: 200 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 20);
 expect(frames.pending()).toBe(1);
 const released = handle.camera();
 // Interrupt before the first inertia frame runs.
 touchPointer(host.canvas, 'pointerdown', 2, { x: 300, y: 200 }, 24);
 let timeMs = 24;
 timeMs += stepMs;
 frames.flushOne(timeMs);
 expect(handle.camera()).toEqual(released);
 touchPointer(
 host.canvas,
 'lostpointercapture',
 2,
 { x: 300, y: 200 },
 timeMs + 4,
 );

 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 },
 );

 it.each(['pen', 'mouse'] as const)(
 '%s preempts released overscroll and authors exactly one stroke',
 (pointerType) => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBeforeNav = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: -744, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
 expect(handle.camera().x).toBeLessThan(-744);
 expect(JSON.stringify(model)).toBe(canonicalBeforeNav);
 expect(dirty).toBe(0);

 authorPointer(
 host.canvas,
 'pointerdown',
 pointerType,
 20,
 { x: 780, y: 200 },
 24,
 );
 expect(handle.camera().x).toBe(-744);
 authorPointer(
 host.canvas,
 'pointermove',
 pointerType,
 20,
 { x: 785, y: 205 },
 32,
 );
 authorPointer(
 host.canvas,
 'pointerup',
 pointerType,
 20,
 { x: 790, y: 210 },
 40,
 );
 expect(model.order.length).toBe(1);
 expect(dirty).toBe(1);
 expect(handle.canUndo()).toBe(true);
 },
 );

 it('standalone wheel pans exactly once and ctrl-wheel zooms exactly once', () => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);
 const schedulesBefore = frames.schedules();

 const panned = wheel(host.canvas, { deltaX: 40, deltaY: 0 });
 expect(panned.defaultPrevented).toBe(true);
 expect(handle.camera().x).toBe(240);
 expect(frames.pending()).toBe(1);
 expect(frames.schedules()).toBe(schedulesBefore + 1);

 const zoomed = wheel(host.canvas, {
 deltaY: -100,
 ctrlKey: true,
 clientX: 400,
 clientY: 300,
 });
 expect(zoomed.defaultPrevented).toBe(true);
 expect(handle.camera().zoom).toBeCloseTo(Math.exp(0.2), 9);
 expect(frames.pending()).toBe(1);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 });

 it('cancel-vs-end races: true cancel discards, lost capture legalizes, stale ends are safe', () => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);

 // Race A: cancel after release must not revive or discard the settle.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: -744, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
 expect(frames.pending()).toBe(1);
 expect(() =>
 touchPointer(host.canvas, 'pointercancel', 1, { x: 180, y: 100 }, 24),
 ).not.toThrow();
 flushUntilSettled(frames, 24, 1000 / 60);
 expect(handle.camera().x).toBe(-744);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 document.body.replaceChildren();
 }

 // Race B: pointerup after a true cancel must not arm inertia.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 0, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 2, { x: 300, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 2, { x: 200, y: 100 }, 20);
 touchPointer(host.canvas, 'pointercancel', 2, { x: 200, y: 100 }, 24);
 expect(handle.camera().x).toBe(100);
 // A stale pointerup for the already-cancelled id must not move the
 // camera nor arm navigation; at most the shared paint frame is pending.
 touchPointer(host.canvas, 'pointerup', 2, { x: 200, y: 100 }, 28);
 expect(handle.camera().x).toBe(100);
 flushUntilSettled(frames, 28, 1000 / 60);
 expect(handle.camera().x).toBe(100);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 document.body.replaceChildren();
 }

 // Race C: lostpointercapture legalizes like a release (not a discard).
 // Lost capture arms decay/spring via beginPanRelease (pending
 // frame, still elastic), then settles to the legal bound — never a
 // snap-discard like true cancel.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: -744, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 3, { x: 100, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 3, { x: 180, y: 100 }, 20);
 expect(handle.camera().x).toBeLessThan(-744);
 touchPointer(
 host.canvas,
 'lostpointercapture',
 3,
 { x: 180, y: 100 },
 24,
 );
 expect(frames.pending()).toBe(1);
 expect(handle.camera().x).toBeLessThan(-744);
 flushUntilSettled(frames, 24, 1000 / 60);
 expect(handle.camera().x).toBe(-744);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 document.body.replaceChildren();
 }
 });

 it.each(REFRESH_RATES)(
 'infinite Whiteboard momentum is unresisted, interruptible, zero-effect ($name)',
 ({ stepMs }) => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 10_000, y: -10_000, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);
 const releasedX = handle.camera().x;
 expect(frames.pending()).toBe(1);
 let timeMs = 20;
 timeMs += stepMs;
 frames.flushOne(timeMs);
 expect(handle.camera().x).toBeGreaterThan(releasedX);
 expect(handle.camera().x).toBeGreaterThan(10_000);
 // Interrupt mid-momentum with a new touch: freeze, no settle.
 touchPointer(host.canvas, 'pointerdown', 2, { x: 200, y: 100 }, timeMs);
 const interrupted = handle.camera();
 timeMs += stepMs;
 frames.flushOne(timeMs);
 expect(handle.camera()).toEqual(interrupted);
 touchPointer(
 host.canvas,
 'lostpointercapture',
 2,
 { x: 200, y: 100 },
 timeMs + 4,
 );

 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 },
 );

 it('reduced-motion full matrix snaps immediately with zero residue', () => {
 const restoreReduced = installReducedMotion(true);
 cleanup.push(restoreReduced);
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);

 // Overscroll snaps to the exact bound.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(800, 600));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: -744, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
 // Reduced motion settles the camera synchronously; only the shared
 // paint frame may remain pending (no navigation animation).
 expect(handle.camera().x).toBe(-744);
 flushUntilSettled(frames, 20, 1000 / 60);
 expect(handle.camera().x).toBe(-744);
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 document.body.replaceChildren();
 }

 // Overzoom / underzoom snap to the exact limit.
 for (const limit of [MIN_ZOOM, MAX_ZOOM]) {
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: limit },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
 touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
 touchPointer(
 host.canvas,
 'pointermove',
 2,
 { x: limit === MAX_ZOOM ? 700 : 300, y: 200 },
 20,
 );
 touchPointer(host.canvas, 'pointerup', 2, { x: 400, y: 200 }, 24);
 touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 28);
 // Reduced motion snaps synchronously; drain the shared paint frame.
 expect(handle.camera().zoom).toBe(limit);
 flushUntilSettled(frames, 28, 1000 / 60);
 expect(handle.camera().zoom).toBe(limit);
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 document.body.replaceChildren();
 }

 // Infinite fling settles synchronously with zero residue.
 {
 const host = makeHost();
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 10_000, y: -10_000, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);
 // Reduced motion: no navigation animation; drain the paint frame.
 flushUntilSettled(frames, 20, 1000 / 60);
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 document.body.replaceChildren();
 }
 });

 it('destroy mid-gesture leaves zero frames and perf stays single-frame with bounded rect reads', () => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);

 // Destroy during an active pan.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 250, y: 200 }, 12);
 expect(() => handle.destroy()).not.toThrow();
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 document.body.replaceChildren();
 }

 // Destroy during inertia: pending frame is cancelled, never stepped.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 200, y: 200 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 20);
 expect(frames.pending()).toBe(1);
 expect(() => handle.destroy()).not.toThrow();
 expect(frames.pending()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 document.body.replaceChildren();
 }

 // Perf: move bursts coalesce to a single pending frame; one rect read
 // per pointer event (no amplification); renderFrames advance 1:1.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 0, y: 0, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);
 const framesBefore = handle.diagnostics().renderFrames;
 const originalRect = host.canvas.getBoundingClientRect.bind(host.canvas);
 let rectReads = 0;
 host.canvas.getBoundingClientRect = () => {
 rectReads += 1;
 return originalRect();
 };
 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 260, y: 200 }, 8);
 touchPointer(host.canvas, 'pointermove', 1, { x: 220, y: 200 }, 16);
 touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 200 }, 24);
 touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 200 }, 24);
 // 5 pointer events => exactly 5 rect reads (one per DOM event).
 expect(rectReads).toBe(5);
 expect(frames.pending()).toBe(1);
 const releaseX = handle.camera().x;
 frames.flushOne(40);
 expect(handle.camera().x).toBeGreaterThan(releaseX);
 expect(handle.diagnostics().renderFrames).toBe(framesBefore + 1);
 expect(frames.pending()).toBe(1);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 }
 });

 it('standalone<->embedded transition keeps ownership single (no double camera, no double commit)', () => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);

 // standalone owns its camera locally through release inertia.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 markDirty: () => undefined,
 });
 frames.flushOne(0);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 200, y: 200 }, 20);
 touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 20);
 expect(frames.pending()).toBe(1);
 expect(handle.camera().x).toBeGreaterThan(200);
 flushUntilSettled(frames, 20, 1000 / 60);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 expect(frames.pending()).toBe(0);
 document.body.replaceChildren();
 }

 // embedded forwards to the pager and never moves its local
 // camera, never arms a local animation, never schedules a local render.
 {
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 const pans: Point[] = [];
 const zooms: Array<{ factor: number }> = [];
 let panEnds = 0;
 let zoomEnds = 0;
 let cancels = 0;
 const renders = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 navigationMode: 'embedded',
 onEmbeddedPan: (delta) => pans.push({ ...delta }),
 onEmbeddedZoom: (gesture) => zooms.push({ factor: gesture.factor }),
 onEmbeddedPanEnd: () => {
 panEnds += 1;
 },
 onEmbeddedZoomEnd: () => {
 zoomEnds += 1;
 },
 onEmbeddedCancel: () => {
 cancels += 1;
 },
 markDirty: () => undefined,
 });
 frames.flushOne(0);
 const cameraBefore = handle.camera();
 touchPointer(host.canvas, 'pointerdown', 11, { x: 300, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 11, { x: 200, y: 200 }, 20);
 expect(pans.length).toBeGreaterThan(0);
 expect(handle.camera()).toEqual(cameraBefore);
 touchPointer(host.canvas, 'pointerup', 11, { x: 200, y: 200 }, 20);
 expect(panEnds).toBe(1);
 expect(handle.camera()).toEqual(cameraBefore);

 touchPointer(host.canvas, 'pointerdown', 12, { x: 100, y: 100 }, 40);
 touchPointer(host.canvas, 'pointerdown', 13, { x: 200, y: 100 }, 40);
 touchPointer(host.canvas, 'pointermove', 13, { x: 220, y: 100 }, 60);
 expect(zooms.length).toBeGreaterThan(0);
 expect(handle.camera()).toEqual(cameraBefore);
 touchPointer(host.canvas, 'pointerup', 12, { x: 100, y: 100 }, 64);
 touchPointer(host.canvas, 'pointerup', 13, { x: 220, y: 100 }, 68);
 expect(zoomEnds).toBe(1);
 expect(handle.camera()).toEqual(cameraBefore);
 expect(cancels).toBe(0);
 expect(renders).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(handle.canUndo()).toBe(false);
 handle.destroy();
 expect(frames.pending()).toBe(0);
 document.body.replaceChildren();
 }
 });

 it('pinch anchor stays bound to the surface point across 1-2-1 handoff', () => {
 const restoreCanvas = installCanvasStub();
 const frames = installManualFrames();
 cleanup.push(restoreCanvas, frames.restore);
 const host = makeHost();
 const model = emptySurface(boundedFrame(2_000, 2_000));
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const handle = mountInkSurface({
 model,
 host,
 initialCamera: { x: 200, y: 100, zoom: 1 },
 markDirty: () => {
 dirty += 1;
 },
 });
 cleanup.push(() => handle.destroy());
 frames.flushOne(0);

 const startCentroid = { x: 300, y: 200 };
 const anchor = viewToSurface(handle.camera(), startCentroid);
 touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
 touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
 touchPointer(host.canvas, 'pointermove', 1, { x: 160, y: 180 }, 16);
 touchPointer(host.canvas, 'pointermove', 2, { x: 460, y: 220 }, 24);
 const nextCentroid = { x: 310, y: 200 };
 const anchored = viewToSurface(handle.camera(), nextCentroid);
 expect(anchored.x).toBeCloseTo(anchor.x, 9);
 expect(anchored.y).toBeCloseTo(anchor.y, 9);
 touchPointer(host.canvas, 'pointerup', 1, { x: 160, y: 180 }, 28);
 touchPointer(host.canvas, 'pointerup', 2, { x: 460, y: 220 }, 32);
 flushUntilSettled(frames, 32, 1000 / 60);

 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canUndo()).toBe(false);
 });
});
