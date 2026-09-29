// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
 emptySurface,
 infiniteFrame,
 rectangleObject,
} from '@froglight/foundation';
import { WhiteboardDocumentEditorProvider } from './editor.js';

/**
 * Whiteboard navigation seam integration.
 *
 * Whiteboard rides the shared `mountInkSurface` engine over an infinite
 * frame. These gap-fillers prove the seam end-to-end (not duplicating the
 * mounted provider specs): infinite unbounded momentum stays interruptible
 * with zero canonical effects at 60Hz and 120Hz, reduced-motion snaps with
 * zero residue, destroy mid-gesture leaves zero frames, and every run
 * byte-compares canonical JSON with dirty 0 / history 0.
 */

type Transform = readonly [number, number, number, number, number, number];

function installMountedEnvironment(): {
 readonly transforms: Transform[];
 readonly pendingFrames: () => number;
 readonly schedules: () => number;
 readonly flushFrame: (timeMs: number) => void;
 readonly restore: () => void;
} {
 const transforms: Transform[] = [];
 const noop = (): void => undefined;
 const context = {
 save: noop,
 restore: noop,
 beginPath: noop,
 closePath: noop,
 clip: noop,
 fill: noop,
 stroke: noop,
 rect: noop,
 fillRect: noop,
 strokeRect: noop,
 clearRect: noop,
 fillText: noop,
 drawImage: noop,
 moveTo: noop,
 lineTo: noop,
 arc: noop,
 ellipse: noop,
 translate: noop,
 rotate: noop,
 setLineDash: noop,
 setTransform: (...values: Transform) => void transforms.push(values),
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
 const originalContext = HTMLCanvasElement.prototype.getContext;
 const originalBounds = HTMLElement.prototype.getBoundingClientRect;
 const widthDescriptor = Object.getOwnPropertyDescriptor(
 HTMLElement.prototype,
 'clientWidth',
 );
 const heightDescriptor = Object.getOwnPropertyDescriptor(
 HTMLElement.prototype,
 'clientHeight',
 );
 HTMLCanvasElement.prototype.getContext = function () {
 return context as unknown as CanvasRenderingContext2D;
 } as unknown as typeof HTMLCanvasElement.prototype.getContext;
 HTMLElement.prototype.getBoundingClientRect = () =>
 ({
 x: 0,
 y: 0,
 left: 0,
 top: 0,
 right: 800,
 bottom: 600,
 width: 800,
 height: 600,
 toJSON: () => ({}),
 }) as DOMRect;
 Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
 configurable: true,
 get: () => 800,
 });
 Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
 configurable: true,
 get: () => 600,
 });

 const frames: FrameRequestCallback[] = [];
 let schedules = 0;
 const originalRequest = globalThis.requestAnimationFrame;
 const originalCancel = globalThis.cancelAnimationFrame;
 globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
 frames.push(callback);
 schedules += 1;
 return frames.length;
 }) as typeof requestAnimationFrame;
 globalThis.cancelAnimationFrame = (() => {
 frames.length = 0;
 }) as typeof cancelAnimationFrame;

 return {
 transforms,
 pendingFrames: () => frames.length,
 schedules: () => schedules,
 flushFrame: (timeMs) => {
 const callback = frames.shift();
 if (callback === undefined) throw new Error('expected a pending frame');
 callback(timeMs);
 },
 restore: () => {
 frames.length = 0;
 globalThis.requestAnimationFrame = originalRequest;
 globalThis.cancelAnimationFrame = originalCancel;
 HTMLCanvasElement.prototype.getContext = originalContext;
 HTMLElement.prototype.getBoundingClientRect = originalBounds;
 if (widthDescriptor === undefined)
 Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
 else
 Object.defineProperty(
 HTMLElement.prototype,
 'clientWidth',
 widthDescriptor,
 );
 if (heightDescriptor === undefined)
 Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
 else
 Object.defineProperty(
 HTMLElement.prototype,
 'clientHeight',
 heightDescriptor,
 );
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

function touch(
 canvas: HTMLCanvasElement,
 type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
 id: number,
 x: number,
 timeMs: number,
): void {
 const event = new MouseEvent(type, {
 bubbles: true,
 cancelable: true,
 clientX: x,
 clientY: 100,
 button: 0,
 });
 Object.defineProperties(event, {
 pointerId: { value: id },
 pointerType: { value: 'touch' },
 timeStamp: { value: timeMs },
 });
 canvas.dispatchEvent(event);
}

const cleanup: Array<() => void> = [];

afterEach(() => {
 for (const dispose of cleanup.splice(0).reverse()) dispose();
 document.body.replaceChildren();
});

function mountWhiteboard(model: ReturnType<typeof emptySurface>, dirty: () => void) {
 const parent = document.createElement('div');
 document.body.append(parent);
 const handle = new WhiteboardDocumentEditorProvider().createEditor({
 session: {
 model,
 markDirty: dirty,
 } as never,
 parent,
 });
 const canvas = parent.querySelector('canvas');
 if (canvas === null) throw new Error('expected mounted whiteboard canvas');
 return { parent, handle, canvas };
}

describe('Whiteboard navigation integration matrix', () => {
 it.each([
 { name: '60Hz', stepMs: 16 },
 { name: '120Hz', stepMs: 8 },
 ])(
 'infinite momentum is unresisted and interruptible with zero effects ($name)',
 ({ stepMs }) => {
 const environment = installMountedEnvironment();
 cleanup.push(environment.restore);
 const model = emptySurface(infiniteFrame());
 model.objects['fixed'] = rectangleObject('fixed', {
 x: -10_000,
 y: -10_000,
 width: 20_000,
 height: 20_000,
 });
 model.order.push('fixed');
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 cleanup.push(() => handle.destroy());
 environment.flushFrame(0);

 touch(canvas, 'pointerdown', 1, 300, 0);
 touch(canvas, 'pointermove', 1, 100, 20);
 touch(canvas, 'pointerup', 1, 100, 20);
 const transformsBeforeReleaseFrame = environment.transforms.length;
 environment.flushFrame(20 + stepMs);
 const releasedTranslation = Math.min(
 ...environment.transforms
 .slice(transformsBeforeReleaseFrame)
 .map((transform) => transform[4]),
 );
 expect(releasedTranslation).toBeLessThan(-200);
 expect(environment.pendingFrames()).toBe(1);
 // Interrupt mid-momentum: a new touch freezes the camera.
 const countBeforeInterrupt = environment.transforms.length;
 touch(canvas, 'pointerdown', 2, 300, 20 + stepMs);
 environment.flushFrame(20 + stepMs * 2);
 const afterInterrupt = environment.transforms.slice(countBeforeInterrupt);
 if (afterInterrupt.length > 0) {
 expect(
 Math.min(...afterInterrupt.map((transform) => transform[4])),
 ).toBeGreaterThanOrEqual(releasedTranslation - 1);
 }
 touch(canvas, 'pointercancel', 2, 300, 20 + stepMs * 2);

 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canExecCommand?.('undo')).toBe(false);
 // Single shared frame: never more than one pending frame.
 expect(environment.pendingFrames()).toBeLessThanOrEqual(1);
 },
 );

 it('infinite momentum keeps advancing without resistance when uninterrupted', () => {
 const environment = installMountedEnvironment();
 cleanup.push(environment.restore);
 const model = emptySurface(infiniteFrame());
 model.objects['fixed'] = rectangleObject('fixed', {
 x: -10_000,
 y: -10_000,
 width: 20_000,
 height: 20_000,
 });
 model.order.push('fixed');
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 cleanup.push(() => handle.destroy());
 environment.flushFrame(0);

 touch(canvas, 'pointerdown', 1, 300, 0);
 touch(canvas, 'pointermove', 1, 100, 20);
 touch(canvas, 'pointerup', 1, 100, 20);
 const markA = environment.transforms.length;
 environment.flushFrame(36);
 const translationA = Math.min(
 ...environment.transforms.slice(markA).map((t) => t[4]),
 );
 expect(environment.pendingFrames()).toBe(1);
 const markB = environment.transforms.length;
 environment.flushFrame(52);
 expect(
 Math.min(
 ...environment.transforms.slice(markB).map((t) => t[4]),
 ),
 ).toBeLessThan(translationA);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canExecCommand?.('undo')).toBe(false);
 });

 it('reduced-motion whiteboard fling snaps with zero residue and zero effects', () => {
 const restoreMotion = installReducedMotion(true);
 cleanup.push(restoreMotion);
 const environment = installMountedEnvironment();
 cleanup.push(environment.restore);
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const schedulesBefore = environment.schedules();
 void schedulesBefore;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 cleanup.push(() => handle.destroy());
 environment.flushFrame(0);

 touch(canvas, 'pointerdown', 1, 300, 0);
 touch(canvas, 'pointermove', 1, 100, 20);
 touch(canvas, 'pointerup', 1, 100, 20);
 // Reduced motion: no inertia animation is armed; drain paint only.
 for (
 let i = 0;
 i < 10 && environment.pendingFrames() > 0;
 i += 1
 ) {
 expect(environment.pendingFrames()).toBeLessThanOrEqual(1);
 environment.flushFrame(20 + i * 16);
 }
 expect(environment.pendingFrames()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canExecCommand?.('undo')).toBe(false);
 });

 it('destroy mid-gesture and mid-momentum leaves zero frames with canonical intact', () => {
 // Destroy during an active pan.
 {
 const environment = installMountedEnvironment();
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 environment.flushFrame(0);
 touch(canvas, 'pointerdown', 1, 300, 0);
 touch(canvas, 'pointermove', 1, 100, 20);
 expect(() => handle.destroy()).not.toThrow();
 expect(environment.pendingFrames()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 environment.restore();
 document.body.replaceChildren();
 }
 // Destroy during momentum.
 {
 const environment = installMountedEnvironment();
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 environment.flushFrame(0);
 touch(canvas, 'pointerdown', 1, 300, 0);
 touch(canvas, 'pointermove', 1, 100, 20);
 touch(canvas, 'pointerup', 1, 100, 20);
 expect(environment.pendingFrames()).toBe(1);
 expect(() => handle.destroy()).not.toThrow();
 expect(environment.pendingFrames()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 environment.restore();
 document.body.replaceChildren();
 }
 });

 it('true cancel discards the whiteboard gesture with no commit and no history', () => {
 const environment = installMountedEnvironment();
 cleanup.push(environment.restore);
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 cleanup.push(() => handle.destroy());
 environment.flushFrame(0);

 touch(canvas, 'pointerdown', 1, 300, 0);
 touch(canvas, 'pointermove', 1, 100, 20);
 touch(canvas, 'pointercancel', 1, 100, 24);
 for (let i = 0; i < 10 && environment.pendingFrames() > 0; i += 1)
 environment.flushFrame(24 + i * 16);
 expect(environment.pendingFrames()).toBe(0);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canExecCommand?.('undo')).toBe(false);
 });

 it('whiteboard pinch zooms through the shared engine with zero canonical cost', () => {
 const environment = installMountedEnvironment();
 cleanup.push(environment.restore);
 const model = emptySurface(infiniteFrame());
 const canonicalBefore = JSON.stringify(model);
 let dirty = 0;
 const { handle, canvas } = mountWhiteboard(model, () => {
 dirty += 1;
 });
 cleanup.push(() => handle.destroy());
 environment.flushFrame(0);

 touch(canvas, 'pointerdown', 1, 200, 0);
 touch(canvas, 'pointerdown', 2, 400, 0);
 touch(canvas, 'pointermove', 2, 600, 16);

 const tools = handle.tools;
 if (tools === undefined) throw new Error('expected whiteboard tools');
 const zoom = tools
 .snapshot()
 .controls.find(
 (control) => (control as { id: string }).id === 'whiteboard.zoom',
 );
 expect((zoom as { value: number }).value).toBe(200);
 expect(JSON.stringify(model)).toBe(canonicalBefore);
 expect(dirty).toBe(0);
 expect(handle.canExecCommand?.('undo')).toBe(false);
 });
});
