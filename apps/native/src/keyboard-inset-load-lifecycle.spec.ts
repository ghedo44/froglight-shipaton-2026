import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('iOS keyboard plugin load lifecycle', () => {
  it('removes this plugin instance keyboard observers before re-registering', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const plugin = readFileSync(
      resolve(
        here,
        '../src-tauri/plugins/froglight-keyboard-inset/ios/Sources/FroglightKeyboardInsetPlugin.swift',
      ),
      'utf8',
    );

    expect(plugin).toContain('private func removeOwnKeyboardObservers()');
    expect(plugin).toMatch(
      /public override func load\(webview: WKWebView\)[\s\S]*?removeOwnKeyboardObservers\(\)[\s\S]*?nc\.addObserver/,
    );
    expect(plugin).toMatch(
      /deinit[\s\S]*?removeOwnKeyboardObservers\(\)/,
    );
  });
});
