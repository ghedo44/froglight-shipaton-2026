import { newBlockId } from './model-edit.js';
import { Fragment } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** A toggle summary behaves like a list row; its body is entered explicitly. */
export function enterToggleSummary(view: EditorView): boolean {
  const { $from, $to } = view.state.selection;
  if (
    $from.parent.type.name !== 'paragraph' ||
    $from.depth < 2 ||
    !$from.sameParent($to)
  )
    return false;
  const depth = $from.depth - 1;
  const toggle = $from.node(depth);
  if (toggle.type.name !== 'toggle' || $from.index(depth) !== 0) return false;
  const from = $from.before(depth);
  const tr = closeHistory(view.state.tr);
  if ($from.parent.content.size === 0 && toggle.childCount === 1) {
    tr.replaceWith(
      from,
      from + toggle.nodeSize,
      view.state.schema.nodes.paragraph.create({
        blockId: toggle.attrs.blockId,
      }),
    );
    tr.setSelection(TextSelection.create(tr.doc, from + 1));
  } else {
    const title = toggle.firstChild!;
    const first = toggle.copy(
      Fragment.fromArray([
        title.copy(title.content.cut(0, $from.parentOffset)),
        ...toggle.content.content.slice(1),
      ]),
    );
    const next = toggle.type.create(
      { blockId: newBlockId(), collapsed: toggle.attrs.collapsed },
      title.type.create(null, title.content.cut($to.parentOffset)),
    );
    tr.replaceWith(from, from + toggle.nodeSize, [first, next]);
    tr.setSelection(TextSelection.create(tr.doc, from + first.nodeSize + 2));
  }
  view.dispatch(tr);
  return true;
}
