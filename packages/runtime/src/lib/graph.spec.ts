/**
 * Unit tests for the internal dependency graph: true topological teardown
 * ordering, SCC cycle handling, hard/soft edge semantics, and determinism.
 *
 * The graph is internal runtime state and is not exported from the package
 * index; these tests import it directly (same project, layer:runtime).
 *
 * Rationale: hard-edge cycles cannot arise from initially-declared
 * mutually-unsatisfied requirements (a fiber only activates once its
 * declared requirements are committed), but dynamic `ctx.require()` calls
 * after activation can create hard-edge cycles at runtime. The cycle
 * behavior of `teardownOrder` is exercised here at the graph level, while
 * the runtime-level tests cover the reachable configurations (including a
 * runtime-created dynamic cycle).
 */

import { describe, expect, it } from 'vitest';

import { DependencyGraph } from './graph.js';

describe('DependencyGraph teardown ordering', () => {
  it('disposes a diamond in consumer-first topological order', () => {
    // f1 provides x; f2 requires x provides y; f3 requires x+y provides z;
    // f4 requires z. BFS depth would tie f2 and f3 at depth 1; the true
    // topological order disposes f3 before f2 (f3 depends on f2).
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addProvider('f2', 'y');
    graph.addProvider('f3', 'z');
    graph.addProvider('f4', 'w');
    graph.addHardConsumer('f2', 'x');
    graph.addHardConsumer('f3', 'x');
    graph.addHardConsumer('f3', 'y');
    graph.addHardConsumer('f4', 'z');

    expect(graph.teardownOrder('f1')).toEqual(['f4', 'f3', 'f2', 'f1']);
    expect(graph.cycles()).toEqual([]);
  });

  it('never disposes a provider before a multi-path consumer', () => {
    // f3 depends on f1 via two paths (x directly, and y via f2). No valid
    // order may place f3 after f2 or f1.
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addProvider('f2', 'y');
    graph.addProvider('f3', 'z');
    graph.addHardConsumer('f2', 'x');
    graph.addHardConsumer('f3', 'x');
    graph.addHardConsumer('f3', 'y');

    const order = graph.teardownOrder('f1');
    expect(order.indexOf('f3')).toBeLessThan(order.indexOf('f2'));
    expect(order.indexOf('f2')).toBeLessThan(order.indexOf('f1'));
    expect(order).toHaveLength(3);
  });

  it('treats a hard dependency cycle as one deterministic SCC group', () => {
    // f1 requires y and provides x; f2 requires x and provides y.
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addProvider('f2', 'y');
    graph.addHardConsumer('f1', 'y');
    graph.addHardConsumer('f2', 'x');

    expect(graph.cycles()).toEqual([['f1', 'f2']]);
    // One group, members in ascending fiber-id order, regardless of root.
    expect(graph.teardownOrder('f1')).toEqual(['f1', 'f2']);
    expect(graph.teardownOrder('f2')).toEqual(['f1', 'f2']);
  });

  it('handles a self-cycle without hanging', () => {
    // A fiber that requires a token it provides itself.
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addHardConsumer('f1', 'x');

    expect(graph.cycles()).toEqual([['f1']]);
    expect(graph.teardownOrder('f1')).toEqual(['f1']);
  });

  it('tears down sibling consumers in deterministic order', () => {
    // f2 and f3 both consume x and are incomparable; the documented tie
    // rule emits them in descending fiber-id order (the reversal of the
    // ascending Kahn ready queue).
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addHardConsumer('f2', 'x');
    graph.addHardConsumer('f3', 'x');

    expect(graph.teardownOrder('f1')).toEqual(['f3', 'f2', 'f1']);
  });

  it('soft edges never affect teardown', () => {
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addSoftConsumer('f2', 'x');
    graph.addHardConsumer('f3', 'x');

    // f2 observes x softly: it is not part of the teardown set.
    expect(graph.teardownOrder('f1')).toEqual(['f3', 'f1']);
    expect([...graph.softRequiredTokens('f2')]).toEqual(['x']);
    expect(graph.cycles()).toEqual([]);
  });

  it('reports hard and soft required tokens separately', () => {
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addProvider('f2', 'y');
    graph.addHardConsumer('f3', 'x');
    graph.addSoftConsumer('f3', 'y');

    expect([...graph.hardRequiredTokens('f3')]).toEqual(['x']);
    expect([...graph.softRequiredTokens('f3')]).toEqual(['y']);
  });

  it('removing a fiber drops every edge it owns', () => {
    const graph = new DependencyGraph();
    graph.addProvider('f1', 'x');
    graph.addHardConsumer('f2', 'x');
    graph.addSoftConsumer('f2', 'y');
    graph.removeFiber('f2');

    expect(graph.hardConsumersOf('x').has('f2')).toBe(false);
    expect(graph.softConsumersOf('y').has('f2')).toBe(false);
    expect(graph.teardownOrder('f1')).toEqual(['f1']);
  });
});
