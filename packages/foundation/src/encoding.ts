/**
 * Portable UTF-8 helpers for platform-shared code.
 *
 * Backed by the WHATWG Encoding API (`TextEncoder`/`TextDecoder`), which is
 * available in Node.js and all browsers. The ambient types live in
 * `ambient.d.ts` so this package stays free of Node/DOM type dependencies.
 */

/** Encode a string as UTF-8 bytes. */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Decode UTF-8 bytes into a string (replacement characters for invalid input). */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Parse JSON with bounded task-sized work so large files keep the UI responsive. */
export async function parseJsonAsync(
  bytes: Uint8Array,
  isCurrent: () => boolean,
  workBudget = 64 * 1024,
  fastPathBytes = 512 * 1024,
): Promise<unknown | null> {
  if (bytes.byteLength <= fastPathBytes) {
    if (!isCurrent()) return null;
    return JSON.parse(utf8Decode(bytes)) as unknown;
  }
  const decoder = new TextDecoder();
  const textParts: string[] = [];
  const decodeChunkSize = Math.max(workBudget, 1024 * 1024);
  for (let offset = 0; offset < bytes.length; offset += decodeChunkSize) {
    if (!isCurrent()) return null;
    textParts.push(
      decoder.decode(bytes.subarray(offset, offset + decodeChunkSize), { stream: true }),
    );
    await yieldTask();
  }
  textParts.push(decoder.decode());
  if (!isCurrent()) return null;
  const source = textParts.join('');
  function* parseSteps(): Generator<void, unknown> {
    const values: unknown[] = [];
    const stack: Array<{
      kind: 'array' | 'object';
      value: unknown[] | Record<string, unknown>;
      state: 'first' | 'next' | 'colon' | 'value' | 'comma';
      key?: string;
    }> = [];
    let cursor = 0;
    let spent = 0;
    const isWhitespace = (code: number) =>
      code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;
    const isNumberCharacter = (code: number) =>
      (code >= 0x30 && code <= 0x39) || code === 0x65 || code === 0x45 ||
      code === 0x2b || code === 0x2d || code === 0x2e;
    const charge = (amount = 1): boolean => {
      spent += amount;
      if (spent < workBudget) return false;
      spent = 0;
      return true;
    };
    function* skipWhitespace(): Generator<void> {
      while (cursor < source.length && isWhitespace(source.charCodeAt(cursor))) {
        cursor++;
        if (charge()) yield;
      }
    }
    function* parseString(): Generator<void, string> {
      if (source[cursor] !== '"') throw new SyntaxError('Expected string');
      cursor++;
      let segmentStart = cursor;
      const parts: string[] = [];
      while (cursor < source.length) {
        const code = source.charCodeAt(cursor++);
        if (code === 0x22) {
          parts.push(source.slice(segmentStart, cursor - 1));
          return parts.join('');
        }
        if (code < 0x20) throw new SyntaxError('Control character in string');
        if (code === 0x5c) {
          parts.push(source.slice(segmentStart, cursor - 1));
          if (cursor >= source.length) throw new SyntaxError('Incomplete escape');
          const escape = source[cursor++]!;
          const simple: Record<string, string> = {
            '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
          };
          if (Object.hasOwn(simple, escape)) {
            parts.push(simple[escape]!);
          } else if (escape === 'u') {
            const hex = source.slice(cursor, cursor + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError('Invalid unicode escape');
            parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
            cursor += 4;
          } else {
            throw new SyntaxError('Invalid escape');
          }
          segmentStart = cursor;
        }
        if (charge()) yield;
      }
      throw new SyntaxError('Unterminated string');
    }
    const attach = (value: unknown): void => {
      const parent = stack.at(-1);
      if (parent === undefined) values.push(value);
      else if (parent.kind === 'array') {
        (parent.value as unknown[]).push(value);
        parent.state = 'comma';
      } else {
        Object.defineProperty(parent.value, parent.key!, {
          value, enumerable: true, configurable: true, writable: true,
        });
        parent.key = undefined;
        parent.state = 'comma';
      }
    };
    function* beginValue(): Generator<void> {
      yield* skipWhitespace();
      const char = source[cursor];
      if (char === '{' || char === '[') {
        cursor++;
        const value: unknown[] | Record<string, unknown> = char === '[' ? [] : {};
        attach(value);
        stack.push({ kind: char === '[' ? 'array' : 'object', value, state: 'first' });
      } else if (char === '"') {
        attach(yield* parseString());
      } else if (char === 't' && source.startsWith('true', cursor)) {
        cursor += 4;
        attach(true);
      } else if (char === 'f' && source.startsWith('false', cursor)) {
        cursor += 5;
        attach(false);
      } else if (char === 'n' && source.startsWith('null', cursor)) {
        cursor += 4;
        attach(null);
      } else {
          const start = cursor;
          while (cursor < source.length && isNumberCharacter(source.charCodeAt(cursor))) {
            cursor++;
            if (charge()) yield;
          }
          if (cursor === start) throw new SyntaxError('Expected JSON value');
          const token = source.slice(start, cursor);
          if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
            throw new SyntaxError('Invalid number');
          }
          attach(Number(token));
      }
    }

    yield* beginValue();
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      yield* skipWhitespace();
      const char = source[cursor];
      if (frame.kind === 'object') {
        if (frame.state === 'first' || frame.state === 'next') {
          if (char === '}' && frame.state === 'first') {
            cursor++;
            stack.pop();
          } else {
            if (char !== '"') throw new SyntaxError('Expected object key');
            frame.key = yield* parseString();
            frame.state = 'colon';
          }
        } else if (frame.state === 'colon') {
          if (char !== ':') throw new SyntaxError('Expected colon');
          cursor++;
          frame.state = 'value';
        } else if (frame.state === 'value') {
          yield* beginValue();
        } else if (char === '}') {
          cursor++;
          stack.pop();
        } else if (char === ',') {
          cursor++;
          frame.state = 'next';
        } else throw new SyntaxError('Expected comma or object end');
      } else if (frame.state === 'first' || frame.state === 'next') {
        if (char === ']' && frame.state === 'first') {
          cursor++;
          stack.pop();
        } else yield* beginValue();
      } else if (char === ']') {
        cursor++;
        stack.pop();
      } else if (char === ',') {
        cursor++;
        frame.state = 'next';
      } else throw new SyntaxError('Expected comma or array end');
      if (charge()) yield;
    }
    yield* skipWhitespace();
    if (cursor !== source.length || values.length !== 1) {
      throw new SyntaxError('Unexpected trailing content');
    }
    return values[0];
  }

  try {
    const parser = parseSteps();
    while (true) {
      const step = parser.next();
      if (step.done) return isCurrent() ? step.value : null;
      await yieldTask();
      if (!isCurrent()) return null;
    }
  } catch (error) {
    if (!isCurrent()) return null;
    throw error;
  }
}

async function yieldTask(): Promise<void> {
  const scope = globalThis as unknown as {
    scheduler?: { yield?: () => Promise<void> };
    setTimeout(task: () => void, delayMs: number): unknown;
  };
  if (scope.scheduler?.yield !== undefined) {
    await scope.scheduler.yield();
  } else {
    await new Promise<void>((resolve) => scope.setTimeout(resolve, 0));
  }
}

/**
 * Serialize canonical JSON in small task-sized pieces. The value is read as
 * the serializer advances; `isCurrent` lets a document session discard a
 * partial encoding when an edit lands between pieces and restart from the
 * newer model. Froglight canonical models are JSON-shaped records/arrays, so
 * the output matches two-space `JSON.stringify` formatting for those values.
 */
export async function stringifyJsonAsync(
  value: unknown,
  isCurrent: () => boolean,
  indent = 2,
  yieldEveryTokens = 2048,
): Promise<string | null> {
  const parts: string[] = [];
  let tokenCount = 0;
  const seen = new Set<object>();

  function* serialize(current: unknown, depth: number): Generator<string> {
    if (current === null || typeof current !== 'object') {
      if (typeof current === 'bigint') {
        throw new TypeError('Do not know how to serialize a BigInt');
      }
      yield JSON.stringify(current) ?? 'null';
      return;
    }
    if (seen.has(current)) throw new TypeError('Converting circular structure to JSON');
    const currentPad = ' '.repeat(indent * depth);
    const currentChildPad = ' '.repeat(indent * (depth + 1));
    seen.add(current);
    const pad = currentPad;
    const childPad = currentChildPad;
    if (Array.isArray(current)) {
      if (current.length === 0) {
        yield '[]';
      } else {
        yield `[\n`;
        for (let index = 0; index < current.length; index++) {
          if (index > 0) yield `,\n`;
          yield childPad;
          const item = current[index];
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
            yield 'null';
          } else {
            yield* serialize(item, depth + 1);
          }
        }
        yield `\n${pad}]`;
      }
    } else {
      yield '{';
      let hasEntry = false;
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        const item = (current as Record<string, unknown>)[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        yield hasEntry ? `,\n${childPad}` : `\n${childPad}`;
        yield `${JSON.stringify(key)}: `;
        yield* serialize(item, depth + 1);
        hasEntry = true;
      }
      if (hasEntry) yield `\n${pad}`;
      yield '}';
    }
    seen.delete(current);
  }

  for (const token of serialize(value, 0)) {
    parts.push(token);
    tokenCount++;
    if (tokenCount >= yieldEveryTokens) {
      tokenCount = 0;
      await new Promise<void>((resolve) => {
        const scope = globalThis as unknown as {
          setTimeout(task: () => void, delayMs: number): unknown;
        };
        scope.setTimeout(resolve, 0);
      });
      if (!isCurrent()) return null;
    }
  }
  return isCurrent() ? parts.join('') : null;
}

/** Serialize and UTF-8 encode canonical JSON cooperatively. */
export async function utf8EncodeJsonAsync(
  value: unknown,
  isCurrent: () => boolean,
  trailingNewline = false,
): Promise<Uint8Array | null> {
  const json = await stringifyJsonAsync(value, isCurrent);
  return json === null ? null : utf8Encode(`${json}${trailingNewline ? '\n' : ''}`);
}
