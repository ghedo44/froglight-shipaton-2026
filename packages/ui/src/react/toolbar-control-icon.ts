import type { DocumentToolControl } from '@froglight/foundation';

/** Presentation for built-in semantic commands. Contributed controls keep their own glyph or label. */
const ICONS: Record<string, string> = {
  'writing.style': 'heading',
  'markdown.insert.table': 'table',
  'markdown.insert.divider': 'divider',
  'surface.text.wrap': 'wrap',
  'surface.insert.image': 'image',
  'surface.view.fit': 'fit',
  'surface.style.width': 'sliders',
  'surface.settings.size': 'sliders',
  'surface.settings.pen-type': 'pen',
  'surface.settings.eraser-filter': 'eraser',
  'surface.settings.eraser-auto-return': 'arrow-back',
  'surface.settings.lasso-mode': 'lasso',
  'surface.settings.lasso-filter': 'lasso',
  'surface.settings.save-style': 'save',
  'surface.text.style': 'heading',
  'surface.text.size': 'type',
  'surface.text.align': 'align',
  'surface.settings.eraser-size': 'eraser',
  'surface.style.saved': 'star',
  'notebook.page.template': 'pages',
  'notebook.page.jump': 'pages',
  'notebook.paper.spacing': 'sliders',
  'notebook.page.size': 'pages',
  'notebook.page.orientation': 'rotate',
  'notebook.page.width': 'width',
  'notebook.page.height': 'height',
  'ink.canvas.width': 'width',
  'ink.canvas.height': 'height',
  'ink.zoom': 'zoom-in',
  'notebook.zoom': 'zoom-in',
  'whiteboard.zoom': 'zoom-in',
  'notebook.page.add': 'file-plus',
  'notebook.page.duplicate': 'copy',
  'notebook.page.delete': 'trash',
  'notebook.page.overview': 'pages',
  'notebook.paper.reset': 'refresh',
  'notebook.insert.pdf.before': 'file-pdf',
  'notebook.insert.pdf.after': 'file-pdf',
  'ink.canvas.export': 'download',
  'latex.math.inline': 'math',
  'latex.math.display': 'math-display',
  'latex.environment.itemize': 'list-bullet',
  'latex.environment.enumerate': 'list-numbered',
  'latex.environment.quote': 'quote',
  'block.insert.table': 'table',
  'block.insert.image': 'image',
  'block.insert.video': 'file-video',
  'block.insert.audio': 'file-audio',
  'block.insert.file': 'file-plus',
  'block.insert.math': 'math',
  'block.insert.diagram': 'diagram',
  'table.addRow': 'row-add',
  'table.addColumn': 'column-add',
  'table.removeRow': 'row-remove',
  'table.removeColumn': 'column-remove',
  'table.moveRowUp': 'arrow-up',
  'table.moveRowDown': 'arrow-down',
  'table.moveColumnLeft': 'arrow-left',
  'table.moveColumnRight': 'arrow-right',
  'table.toggleHeader': 'row-header',
  'column.addColumn': 'column-add',
  'column.moveLeft': 'arrow-left',
  'column.moveRight': 'arrow-right',
  'media.replace': 'refresh',
  'media.clearRemote': 'file',
  'media.retry': 'refresh',
  'media.name': 'type',
  'media.caption': 'type',
  'media.alt': 'type',
  'media.remoteUrl': 'link',
  'math.source': 'math',
  'diagram.source': 'diagram',
  'math.retry': 'refresh',
  'diagram.retry': 'refresh',
  'surface.settings.straight': 'arrow-line',
  'latex.reference.label': 'pin',
  'latex.reference.ref': 'link',
  'latex.reference.cite': 'book',
};

export function toolbarControlIcon(
  control: DocumentToolControl,
): string | undefined {
  if ('icon' in control && control.icon !== undefined) return control.icon;
  const role = control.semanticRole;
  if (role !== undefined && ICONS[role] !== undefined) return ICONS[role];
  if (ICONS[control.id] !== undefined) return ICONS[control.id];
  if (control.kind === 'table') return 'table';
  if (control.kind === 'diagnostics') return 'info';
  if (control.id === 'notebook.source-outline') return 'list-tree';
  if (control.id === 'pdf.outline') return 'list-tree';
  if (control.id === 'notebook.ruler') return 'sliders';
  if (control.id === 'notebook.ruler-center') return 'fit';
  if (control.id === 'notebook.ruler-angle') return 'ruler';
  if (!/^(ink|notebook|whiteboard)\./.test(control.id)) return undefined;
  if (control.id.endsWith('.settings.line.arrows')) return 'arrow-line';
  if (/\.settings\.(pen|fountain|brush|pencil)\.(tip|cap)$/.test(control.id))
    return 'pen';
  if (
    /\.settings\.(pen|fountain|brush|pencil)\.velocity-pressure$/.test(
      control.id,
    )
  )
    return 'sliders';
  if (/\.settings\.(pen|fountain|brush|pencil)\.straight$/.test(control.id))
    return 'arrow-line';
  if (control.id.endsWith('.settings.pen.gesture-draw-hold')) return 'pen';
  if (control.id.endsWith('.settings.pen.gesture-scribble')) return 'eraser';
  if (control.id.endsWith('.settings.pen.gesture-circle')) return 'ellipse';
  if (control.id.endsWith('.favorite-style')) return 'star';
  if (control.id.endsWith('.move-style-earlier')) return 'arrow-left';
  if (control.id.endsWith('.move-style-later')) return 'arrow-right';
  if (control.id.endsWith('.update-style')) return 'save';
  if (control.id.endsWith('.delete-style')) return 'trash';
  if (control.id.endsWith('.reset-style')) return 'refresh';
  if (control.id.endsWith('.rename-style')) return 'edit';
  if (control.id.endsWith('.settings.eraser.auto-return')) return 'arrow-back';
  if (control.id.endsWith('.settings.lasso.mode')) return 'lasso';
  if (control.id.endsWith('.settings.lasso.filter')) return 'lasso';
  if (control.id.endsWith('.settings.eraser.filter')) return 'eraser';
  if (control.id.endsWith('.settings.highlighter.straight'))
    return 'arrow-line';
  if (control.id.endsWith('.settings.pen.type')) return 'pen';
  if (control.id.endsWith('.settings.pen.size')) return 'sliders';
  if (control.id.endsWith('.settings.highlighter.size')) return 'sliders';
  if (control.id.endsWith('.settings.pen.saved-style')) return 'star';
  if (control.id.endsWith('.settings.highlighter.saved-style')) return 'star';
  if (control.id.endsWith('.settings.lasso.saved-style')) return 'star';
  if (control.id.endsWith('.export')) return 'download';
  if (control.id.endsWith('.export-all')) return 'download';
  return undefined;
}
