/**
 * Froglight Markdown input-rule micro-extensions.
 *
 * ONE Tiptap extension holds all trigger families — headings, bullets,
 * ordered lists, to-dos (unchecked + checked), quotes, code fences, and the
 * `---` divider — instead of scattering one plugin per node. Each rule fires
 * only at block start, consumes its trigger, and commits trigger deletion +
 * conversion in a single undoable transaction opened with `closeHistory`, so
 * one undo restores the exact pre-rule model (same granularity the
 * slash commits proved: without `closeHistory` the commit merges with the
 * adjacent trigger typing via the history `newGroupDelay`).
 *
 * Mechanics note (reimplemented, not copied): the conversion shapes mirror
 * the public Tiptap input-rule helpers (delete the matched range, then
 * set-block-type / wrap-into-list / insert-node on the same transaction) and
 * the BlockNote-derived contract from (central rule set, heading veto
 * for list markers, code-context suppression, Backspace-undo parity). No
 * BlockNote or Tiptap rule source is reproduced here; only the published
 * library APIs (`InputRule`, `closeHistory`, `findWrapping`/`canJoin`) are
 * used. IME safety and code-context suppression additionally hold at the
 * engine layer (`view.composing` / `spec.code` short-circuit every
 * `handleTextInput` before any rule runs); the per-rule guards below are
 * belt-and-braces so each rule is also safe if invoked directly.
 *
 * Precedence: this extension declares a high `priority` so its single
 * input-rules plugin runs before the StarterKit / extension-list rule
 * plugins. First match wins per `handleTextInput`, so our adapters — which
 * carry the source `blockId` (lists mint a fresh `listId` for the new
 * container by design, never reusing the paragraph's id) and open their own
 * undo unit — always shadow the built-ins on overlapping triggers, and
 * built-ins only see input our rules decline (never a double conversion).
 * The legacy horizontalRule rule is disabled at the provider (StarterKit
 * `horizontalRule: false`), so declined `---`/`___`/`***` stay literal text
 * instead of converting to an unmapped node that canonical decoding would
 * drop.
 *
 * Provider-internal: ProseMirror/Tiptap types never cross the public seam
 * (see `editor.ts`); they are confined to this module and `tiptap-handle.ts`.
 */

import { Extension, InputRule } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type NodeType } from '@tiptap/pm/model';
import {
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { canJoin, findWrapping } from '@tiptap/pm/transform';
import { newBlockId } from './model-edit.js';

/**
 * The rule runner hands handlers a chainable editor state: a live
 * `EditorState` carrying the in-progress transaction as `.tr`. Mutations
 * apply to that transaction; returning `null` discards it (the typed input
 * then falls back to a literal insert), while falling through with steps
 * recorded dispatches it as one undoable unit.
 */
interface RuleState extends EditorState {
  tr: Transaction;
}

interface RuleRange {
  readonly from: number;
  readonly to: number;
}

/** Read the in-progress transaction off a chainable rule state. */
function ruleTransaction(state: EditorState): Transaction {
  return (state as RuleState).tr;
}

/**
 * Keep the document's trailing-paragraph invariant inside the rule
 * transaction. StarterKit's trailing-node plugin appends an empty paragraph
 * whenever a dispatch leaves the doc ending with a non-paragraph block —
 * via `appendTransaction`, i.e. a second transaction in the same dispatch
 * cycle that wipes this rule's undoable plugin state (Backspace would then
 * fall through to `clearNodes` instead of undoing the rule, dropping the
 * trigger text and the stable id). Creating the identical node (`paragraph`
 * defaults, null id — canonically skipped, same as the plugin's own) in the
 * rule's own transaction keeps the commit single-dispatch: one undo unit,
 * Backspace parity intact.
 */
function ensureTrailingParagraph(
  tr: Transaction,
  schema: EditorState['schema'],
): void {
  const last = tr.doc.lastChild;
  if (last !== null && last !== undefined && last.type.name === 'paragraph')
    return;
  const paragraph = schema.nodes.paragraph;
  if (paragraph === undefined) return;
  tr.insert(tr.doc.content.size, paragraph.create());
}

/** Existing stable id on a block, or a fresh one when absent. */
function carryBlockId(attrs: Record<string, unknown>): string {
  const raw = attrs['blockId'];
  return typeof raw === 'string' && raw !== '' ? raw : newBlockId();
}

/**
 * Structural block-start anchor: the matched range must begin exactly where
 * the caret's parent block content begins. The `^` in each `find` pattern
 * anchors to the engine's text window (capped at 500 chars), so this guard
 * additionally kills mid-prose false positives (`1.` mid-sentence) and any
 * window-edge artefact structurally.
 */
function isBlockStart(state: EditorState, range: RuleRange): boolean {
  const { $from } = state.selection;
  try {
    return range.from === $from.start();
  } catch {
    return false;
  }
}

/** Code contexts never convert (mirrors the `#slashTodoCommit` refusal). */
function isCodeContext(state: EditorState): boolean {
  const parent = state.selection.$from.parent;
  return parent.type.spec.code === true || parent.type.name === 'codeBlock';
}

/**
 * Heading veto for list markers: a line opening with `#` belongs to
 * the heading rule, never to a list rule. Anchored patterns already exclude
 * this shape; the explicit guard documents the veto at the rule site.
 */
function hasHeadingVeto(state: EditorState): boolean {
  const parent = state.selection.$from.parent;
  try {
    const text = parent.textBetween(0, parent.content.size);
    return /^\s*#/.test(text);
  } catch {
    return false;
  }
}

/** Collapsed caret inside a convertible textblock, outside code. */
function caretTextblock(state: EditorState): boolean {
  if (!state.selection.empty) return false;
  const parent = state.selection.$from.parent;
  if (!parent.isTextblock) return false;
  return !isCodeContext(state);
}

/** Change a textblock's type while carrying its stable id.*/
function convertBlockType(
  state: EditorState,
  range: RuleRange,
  type: NodeType,
  attrs: Record<string, unknown>,
): boolean {
  const tr = ruleTransaction(state);
  const $start = tr.doc.resolve(range.from);
  if (
    !$start
      .node(-1)
      .canReplaceWith($start.index(-1), $start.indexAfter(-1), type)
  ) {
    return false;
  }
  closeHistory(tr);
  tr.delete(range.from, range.to);
  tr.setBlockType(range.from, range.from, type, {
    ...attrs,
    preserved: $start.parent.attrs.preserved,
  });
  ensureTrailingParagraph(tr, state.schema);
  return true;
}

/**
 * Delete the trigger range, then wrap the caret block in `type` carrying
 * `attrs` (list `listId`, quote `blockId`). Joins onto an identical previous
 * sibling so `- ` under a bullet list extends it instead of forking a second
 * list node. Returns false (no dispatch) when no wrapping is possible.
 */
function wrapTriggerBlock(
  state: EditorState,
  range: RuleRange,
  type: NodeType,
  attrs: Record<string, unknown>,
  joinPredicate?: (
    match: string,
    before: { attrs: Record<string, unknown>; childCount: number },
  ) => boolean,
  matchText?: string,
): boolean {
  const tr = ruleTransaction(state);
  closeHistory(tr);
  tr.delete(range.from, range.to);
  const blockRange = tr.doc.resolve(range.from).blockRange();
  const sourcePreserved = tr.doc.resolve(range.from).parent.attrs.preserved;
  const wrapperAttrs = {
    ...attrs,
    ...(sourcePreserved === null || sourcePreserved === undefined
      ? {}
      : { preserved: sourcePreserved }),
  };
  const wrapping = blockRange && findWrapping(blockRange, type, wrapperAttrs);
  if (!wrapping) return false;
  tr.wrap(blockRange, wrapping);
  if (range.from > 0) {
    const before = tr.doc.resolve(range.from - 1).nodeBefore;
    if (
      before !== null &&
      before !== undefined &&
      before.type === type &&
      canJoin(tr.doc, range.from - 1) &&
      (joinPredicate === undefined ||
        matchText === undefined ||
        joinPredicate(matchText, {
          attrs: before.attrs as Record<string, unknown>,
          childCount: before.childCount,
        }))
    ) {
      tr.join(range.from - 1);
    }
  }
  ensureTrailingParagraph(tr, state.schema);
  return true;
}

/** Mark the list item around the rule caret as a to-do (cf. slash path). */
function checkTodoItem(tr: Transaction, checked: boolean): boolean {
  const $c = tr.selection.$from;
  for (let depth = $c.depth; depth >= 0; depth -= 1) {
    if ($c.node(depth).type.name !== 'listItem') continue;
    const pos = $c.before(depth);
    const item = tr.doc.nodeAt(pos);
    if (item === null) return false;
    tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked });
    return true;
  }
  return false;
}

function headingRule(): InputRule {
  return new InputRule({
    find: /^(#{1,6})\s$/,
    handler: ({ state, range, match }) => {
      if (!caretTextblock(state)) return null;
      if (!isBlockStart(state, range)) return null;
      const type = state.schema.nodes.heading;
      if (type === undefined) return null;
      const hashes = match[1];
      const level = Math.min(
        6,
        Math.max(1, typeof hashes === 'string' ? hashes.length : 1),
      );
      const blockId = carryBlockId(
        state.selection.$from.parent.attrs as Record<string, unknown>,
      );
      if (!convertBlockType(state, range, type, { blockId, level }))
        return null;
      return;
    },
  });
}

function bulletRule(): InputRule {
  return new InputRule({
    find: /^\s?[-+*]\s$/,
    handler: ({ state, range }) => {
      if (!caretTextblock(state)) return null;
      if (!isBlockStart(state, range)) return null;
      if (hasHeadingVeto(state)) return null;
      const type = state.schema.nodes.bulletList;
      if (type === undefined) return null;
      if (!wrapTriggerBlock(state, range, type, { listId: newBlockId() })) {
        return null;
      }
      return;
    },
  });
}

function orderedRule(): InputRule {
  return new InputRule({
    find: /^\s?(\d+)\.\s$/,
    handler: ({ state, range, match }) => {
      if (!caretTextblock(state)) return null;
      if (!isBlockStart(state, range)) return null;
      if (hasHeadingVeto(state)) return null;
      const type = state.schema.nodes.orderedList;
      if (type === undefined) return null;
      const start = Number(match[1]);
      if (
        !wrapTriggerBlock(
          state,
          range,
          type,
          {
            listId: newBlockId(),
            start: Number.isFinite(start) ? Math.max(1, Math.floor(start)) : 1,
          },
          // Join only onto a continuing sequence (`2. ` under start-1 with
          // one item joins; `5. ` forks a new list) — same continuity rule
          // the stock ordered-list rule applies.
          (text, before) => {
            const beforeType = before.attrs['type'];
            const beforeStart = before.attrs['start'];
            return (
              (beforeType === undefined ||
                beforeType === null ||
                beforeType === '1') &&
              before.childCount +
                (typeof beforeStart === 'number' ? beforeStart : 1) ===
                Number(text)
            );
          },
          typeof match[1] === 'string' ? match[1] : undefined,
        )
      ) {
        return null;
      }
      return;
    },
  });
}

function todoRule(find: RegExp, checked: boolean): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range }) => {
      if (!caretTextblock(state)) return null;
      if (!isBlockStart(state, range)) return null;
      if (hasHeadingVeto(state)) return null;
      const type = state.schema.nodes.bulletList;
      if (type === undefined) return null;
      const tr = ruleTransaction(state);
      if (!wrapTriggerBlock(state, range, type, { listId: newBlockId() }))
        return null;
      // Infallible by construction here: the wrap just placed a list item
      // around the caret. A failure discards the whole transaction (the
      // typed trigger then falls back to a literal insert).
      if (!checkTodoItem(tr, checked)) return null;
      return;
    },
  });
}

function quoteRule(): InputRule {
  return new InputRule({
    find: /^>\s$/,
    handler: ({ state, range }) => {
      if (!caretTextblock(state)) return null;
      if (!isBlockStart(state, range)) return null;
      const type = state.schema.nodes.blockquote;
      if (type === undefined) return null;
      const blockId = carryBlockId(
        state.selection.$from.parent.attrs as Record<string, unknown>,
      );
      if (!wrapTriggerBlock(state, range, type, { blockId })) return null;
      return;
    },
  });
}

function fenceRule(): InputRule {
  return new InputRule({
    find: /^```(.*?)\s$/,
    handler: ({ state, range, match }) => {
      if (!caretTextblock(state)) return null;
      if (!isBlockStart(state, range)) return null;
      const type = state.schema.nodes.codeBlock;
      if (type === undefined) return null;
      // Language resolution: a bare fence yields no language; a single
      // token rides verbatim (trimmed). Compound text (` ```a b `) declines
      // instead of guessing — the input stays literal text.
      const raw = typeof match[1] === 'string' ? match[1].trim() : '';
      if (raw !== '' && /[\s`]/.test(raw)) return null;
      const blockId = carryBlockId(
        state.selection.$from.parent.attrs as Record<string, unknown>,
      );
      if (
        !convertBlockType(state, range, type, {
          blockId,
          ...(raw !== '' ? { language: raw } : {}),
        })
      ) {
        return null;
      }
      return;
    },
  });
}

function dividerRule(): InputRule {
  return new InputRule({
    find: /^---$/,
    handler: ({ state, range }) => {
      if (!state.selection.empty) return null;
      const $from = state.selection.$from;
      // Top-level paragraphs only: the replacement splices block-level
      // nodes at the caret position, which is only valid between doc
      // children. Deeper `---` declines here and stays literal text: the
      // legacy horizontal-rule input rule is disabled at the provider, so
      // there is no fallthrough conversion.
      if ($from.depth !== 1) return null;
      const parent = $from.parent;
      if (parent.type.name !== 'paragraph' || isCodeContext(state)) return null;
      if (!isBlockStart(state, range)) return null;
      // The trigger must be the block's entire content (`---` converts an
      // empty paragraph): anything else (`x---`, `---x`) stays literal so
      // the splice below can never land inside a textblock.
      if (parent.content.size !== range.to - range.from) return null;
      const dividerType = state.schema.nodes.divider;
      const paragraphType = state.schema.nodes.paragraph;
      if (dividerType === undefined || paragraphType === undefined) return null;
      // Replace the whole (trigger-only) block: the divider inherits the
      // source block id and the caret lands in a fresh
      // paragraph after it. One replaceWith = one history step.
      const blockPos = range.from - 1;
      if (blockPos < 0) return null;
      const tr = ruleTransaction(state);
      const parentNode = tr.doc.nodeAt(blockPos);
      if (parentNode === null || parentNode.type.name !== 'paragraph')
        return null;
      closeHistory(tr);
      const dividerNode = dividerType.create({
        blockId: carryBlockId(parentNode.attrs as Record<string, unknown>),
      });
      const nextParagraph = paragraphType.create({ blockId: newBlockId() });
      tr.replaceWith(
        blockPos,
        blockPos + parentNode.nodeSize,
        Fragment.fromArray([dividerNode, nextParagraph]),
      );
      tr.setSelection(
        TextSelection.create(tr.doc, blockPos + dividerNode.nodeSize + 1),
      );
      tr.scrollIntoView();
      return;
    },
  });
}

/**
 * The centralized input-rule set: one extension, priority-sorted
 * rules, each converting via a single undoable transaction. `undoable`
 * defaults to true on every rule, which wires the core Backspace handler's
 * undo-last-rule-first parity (`undoInputRule`) with no extra code.
 */
export const FlbpInputRules = Extension.create({
  name: 'flbpInputRules',
  // Higher priority runs earlier and takes precedence over lower-priority
  // extensions: our adapters shadow the overlapping StarterKit /
  // extension-list rules (heading, bullet/ordered lists, quote, code fence)
  // on every shared trigger. The legacy horizontalRule rule is disabled at
  // the provider, so our divider rule solely owns `---`. Declined input
  // stays literal.
  priority: 200,
  addInputRules() {
    return [
      headingRule(),
      bulletRule(),
      orderedRule(),
      todoRule(/^\s?\[\s?\]\s$/, false),
      todoRule(/^\s?\[[Xx]\]\s$/, true),
      quoteRule(),
      fenceRule(),
      dividerRule(),
    ];
  },
});
