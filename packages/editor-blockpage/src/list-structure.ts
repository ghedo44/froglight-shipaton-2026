import { newBlockId } from './model-edit.js';
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Selection, type Transaction } from '@tiptap/pm/state';

export const isList = (node: PMNode): boolean =>
  ['bulletList', 'orderedList'].includes(node.type.name);

/** Lift one item's inline text and keep its nested blocks owned by the new block. */
export function itemToBlocks(
  item: PMNode,
  schema: Schema,
  type = 'paragraph',
  level = 1,
): Fragment {
  const id = newBlockId();
  const inline = item.firstChild?.content ?? Fragment.empty;
  const attrs = { blockId: id, preserved: item.attrs.preserved, level };
  const paragraph = schema.nodes.paragraph.create(attrs, inline);
  const children = item.content.content.slice(1);
  let block: PMNode;
  if (type === 'toggle' || type === 'callout') {
    block = schema.nodes[type].create(attrs, [paragraph, ...children]);
    return Fragment.from(block);
  }
  if (type === 'quote')
    block = schema.nodes.blockquote.create(attrs, paragraph);
  else if (type === 'code')
    block = schema.nodes.codeBlock.create(
      attrs,
      item.firstChild?.textContent
        ? schema.text(item.firstChild.textContent)
        : null,
    );
  else block = schema.nodes[type].create(attrs, inline);
  return Fragment.fromArray(
    children.length
      ? [block, schema.nodes.blockGroup.create({ owner: id }, children)]
      : [block],
  );
}

/** Insert/replace at a list boundary without flattening the surrounding items. */
export function splitListAt(
  tr: Transaction,
  pos: number,
  content: Fragment,
  remove = 0,
): number | null {
  const $pos = tr.doc.resolve(pos);
  const list = $pos.parent;
  if (!isList(list)) return null;
  const index = $pos.index();
  const before = list.content.content.slice(0, index);
  const after = list.content.content.slice(index + remove);
  const replacement: PMNode[] = [];
  if (before.length) replacement.push(list.copy(Fragment.fromArray(before)));
  replacement.push(...content.content);
  if (after.length)
    replacement.push(
      list.type.create(
        {
          ...list.attrs,
          listId: before.length ? newBlockId('list') : list.attrs.listId,
          ...(list.type.name === 'orderedList' ? { start: 1 } : {}),
        },
        after,
      ),
    );
  const parent = $pos.node(-1);
  const parentIndex = $pos.index(-1);
  if (
    !parent.canReplace(
      parentIndex,
      parentIndex + 1,
      Fragment.fromArray(replacement),
    )
  )
    return null;
  const from = $pos.before();
  const selected =
    from + (replacement[0] && before.length ? replacement[0].nodeSize : 0);
  tr.replaceWith(from, $pos.after(), replacement);
  tr.setSelection(Selection.near(tr.doc.resolve(selected + 1)));
  return selected;
}

/** Adding a text block to a list deliberately converts its text to an item. */
export function blocksToItem(
  content: Fragment,
  schema: Schema,
): Fragment | null {
  const first = content.firstChild;
  if (!first || !first.isTextblock) return null;
  const children = content.content
    .slice(1)
    .flatMap((node) =>
      node.type.name === 'blockGroup' ? [...node.content.content] : [node],
    );
  return Fragment.from(
    schema.nodes.listItem.create({ preserved: first.attrs.preserved }, [
      schema.nodes.paragraph.create({ blockId: null }, first.content),
      ...children,
    ]),
  );
}
