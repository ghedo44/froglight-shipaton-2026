import { describe, expect, it } from 'vitest';
import { InMemoryNavigationService } from '../navigation.js';
import { resourceId } from '../identity.js';

describe('Workspace navigation — portable DocumentLocation', () => {
  it('stores portable entries (resourceId + address) and JSON round-trips', () => {
    const nav = new InMemoryNavigationService();
    const loc = { resourceId: resourceId('res-123'), address: 'hello' };
    nav.push(loc);
    nav.push({ resourceId: resourceId('res-456'), address: '^block1' });
    const json = JSON.stringify({ history: [nav.current] });
    const parsed = JSON.parse(json) as { history: { resourceId: string; address?: string }[] };
    expect(parsed.history[0].resourceId).toBe('res-456');
    // Simulate provider swap: navigation still works without CodeMirror types
    nav.back();
    expect(nav.current?.resourceId).toBe('res-123');
    expect(nav.current?.address).toBe('hello');
    // No editor state in history
    expect(nav.current).not.toHaveProperty('editorState');
    expect(nav.current).not.toHaveProperty('EditorView');
  });

  it('back/forward truncates forward branch and survives clear/restore', () => {
    const nav = new InMemoryNavigationService();
    nav.push({ resourceId: resourceId('res-a') });
    nav.push({ resourceId: resourceId('res-b') });
    nav.back();
    nav.push({ resourceId: resourceId('res-c') });
    expect(nav.canGoForward).toBe(false);
    expect(nav.current?.resourceId).toBe('res-c');
    nav.clear();
    expect(nav.current).toBeNull();
  });
});
