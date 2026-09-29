/**
 * Froglight icon system.
 *
 * Icons are authored 24px-grid SVG paths with 1.7px round strokes — never
 * emoji or Unicode glyphs. The default set lives here; a registry lets hosts
 * and plugins override any name or contribute new ones. Overrides are
 * reversible: disposing a registration restores the previous definition
 * (shadow semantics, matching the view registry).
 */

export type IconName =
  | 'apple'
  | 'satellite'
  | 'heart'
  | 'globe'
  | 'leaf'
  | 'coffee'
  | 'music'
  | 'camera'
  | 'briefcase'
  | 'rocket'
  | 'flask'
  | 'mountain'
  | 'compass'
  | 'lightbulb'
  | 'graduation-cap'
  | 'triangle'
  | 'diamond'
  | 'rounded-rectangle'
  | 'file'
  | 'file-plus'
  | 'file-import'
  | 'file-pdf'
  | 'file-image'
  | 'file-video'
  | 'file-audio'
  | 'file-text'
  | 'file-latex'
  | 'file-code'
  | 'file-archive'
  | 'markdown'
  | 'blockpage'
  | 'database'
  | 'folder'
  | 'folder-open'
  | 'folder-plus'
  | 'chevron-right'
  | 'chevron-down'
  | 'search'
  | 'graph'
  | 'settings'
  | 'plus'
  | 'minus'
  | 'save'
  | 'arrow-back'
  | 'arrow-forward'
  | 'edit'
  | 'book'
  | 'columns'
  | 'split-right'
  | 'split-down'
  | 'menu'
  | 'more'
  | 'trash'
  | 'close'
  | 'link'
  | 'shield'
  | 'spark'
  | 'refresh'
  | 'panel-left'
  | 'panel-right'
  | 'list-tree'
  | 'sliders'
  | 'check'
  | 'window-min'
  | 'window-max'
  | 'window-restore'
  | 'palette'
  | 'info'
  | 'blocks'
  | 'ink'
  | 'canvas'
  | 'notebook'
  | 'undo'
  | 'redo'
  | 'cursor'
  | 'pen'
  | 'fountain'
  | 'brush'
  | 'pencil'
  | 'highlighter'
  | 'eraser'
  | 'eraser-precision'
  | 'lasso'
  | 'shapes'
  | 'image'
  | 'rect'
  | 'ellipse'
  | 'arrow-line'
  | 'type'
  | 'zoom-in'
  | 'pages'
  | 'download'
  | 'indent'
  | 'outdent'
  | 'quote'
  | 'list-bullet'
  | 'list-numbered'
  | 'list-check'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'heading'
  | 'align'
  | 'distribute'
  | 'layers'
  | 'lock'
  | 'unlock'
  | 'group'
  | 'ungroup'
  | 'copy'
  | 'table'
  | 'divider'
  | 'wrap'
  | 'math'
  | 'math-display'
  | 'diagram'
  | 'row-add'
  | 'column-add'
  | 'row-remove'
  | 'column-remove'
  | 'row-header'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'arrow-right'
  | 'star'
  | 'pin'
  | 'rotate'
  | 'width'
  | 'height'
  | 'ruler'
  | 'fit';

/** Default drawn set. Order inside a path does not matter. */
export const DEFAULT_ICON_PATHS: Record<IconName, string> = {
  apple:
    'M12 7c-4-4-9-1-8 5 1 5 3 9 6 7 1-.7 3-.7 4 0 3 2 5-2 6-7 1-6-4-9-8-5z M12 7c0-3 2-5 5-5-1 3-3 4-5 4',
  satellite:
    'M 14.12 5.64 L 18.36 9.88 11.29 16.95 7.05 12.71 Z M 14.83 6.34 Q 17.66 3.51 19.07 4.93 Q 20.49 6.34 17.66 9.17 M 8.46 1.39 L 12.00 4.93 5.64 11.29 2.10 7.76 Z M 10.23 3.16 L 3.87 9.53 M 6.34 3.51 L 9.88 7.05 M 4.22 5.64 L 7.76 9.17 M 19.07 12.00 L 22.61 15.54 16.24 21.90 12.71 18.36 Z M 20.84 13.77 L 14.47 20.13 M 16.95 14.12 L 20.49 17.66 M 14.83 16.24 L 18.36 19.78 M 8.82 8.11 L 10.23 9.53 M 14.47 13.77 L 15.89 15.18 M 9.17 14.83 L 8.46 15.54 M 2.81 15.54 Q 5.64 12.71 8.46 15.54 Q 11.29 18.36 8.46 21.19 Z M 5.64 18.36 L 4.22 19.78',
  heart: 'M20 5c-3-3-6-1-8 1-2-2-5-4-8-1-3 3-1 6 1 8l7 7 7-7c2-2 4-5 1-8z',
  globe:
    'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c-5 5-5 13 0 18 5-5 5-13 0-18',
  leaf: 'M20 3c-1 5 2 9-3 14-4 4-11 3-12-2C3 7 11 6 20 3z M4 21l10-10',
  coffee:
    'M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z M16 8h2a3 3 0 0 1 0 6h-2 M3 22h15 M7 2v3 M12 2v3',
  music:
    'M9 18V5l11-2v13 M9 9l11-2 M9 18a3 3 0 1 1-3-3c2 0 3 1 3 3 M20 16a3 3 0 1 1-3-3c2 0 3 1 3 3',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3z M16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  briefcase: 'M3 7h18v14H3z M8 7V3h8v4 M3 12c6 4 12 4 18 0 M12 12v4',
  rocket:
    'M8 16c-2-5 5-13 13-13 0 8-8 15-13 13z M8 9H4l-2 6 6 1 M15 16v4l-6 2-1-6 M14 8l2 2 M5 19l-3 3',
  flask: 'M9 3h6 M10 3v7L4 20v1h16v-1l-6-10V3 M7 16h10',
  mountain: 'M2 20 10 4l5 9 3-5 5 12z M7 10l3 2 3-2',
  compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M16 8l-3 5-5 3 3-5z',
  lightbulb: 'M9 18v-2c-6-4-4-13 3-13s9 9 3 13v2z M9 21h6 M10 18h4',
  'graduation-cap': 'M2 9l10-6 10 6-10 6z M6 12v6c4 3 8 3 12 0v-6 M22 9v9',

  table: 'M3.5 4.5h17v15h-17z M3.5 9.5h17 M9.5 4.5v15 M15 4.5v15 M3.5 14.5h17',
  divider: 'M4 12h16 M8 7h8 M8 17h8',
  wrap: 'M4 6h16 M4 10h16 M4 14h11a3 3 0 0 1 0 6h-3 M14 17l-2 3 2 2 M4 18h5',
  math: 'M4 17l5-10 4 10 M6 13h5 M15 7l5 10 M20 7l-5 10',
  'math-display': 'M5 5H3v14h2 M19 5h2v14h-2 M8 16l3-8 3 8 M9 13h4 M16 8v8',
  diagram:
    'M3.5 4h6v5h-6z M14.5 4h6v5h-6z M9 15h6v5H9z M6.5 9v3.5H12V15 M17.5 9v3.5H12',
  'row-add': 'M3 5h18v12H3z M3 11h18 M12 17v5 M9 19.5h6',
  'column-add': 'M3 4h14v16H3z M10 4v16 M17 12h5 M19.5 9.5v5',
  'row-remove': 'M3 4h18v13H3z M3 11h18 M9 20h6',
  'column-remove': 'M3 4h14v16H3z M10 4v16 M18 12h4',
  'row-header': 'M3 4h18v16H3z M3 10h18 M9 10v10 M15 10v10 M6 7h12',
  'arrow-up': 'M12 20V4 M6 10l6-6 6 6',
  'arrow-down': 'M12 4v16 M6 14l6 6 6-6',
  'arrow-left': 'M20 12H4 M10 6l-6 6 6 6',
  'arrow-right': 'M4 12h16 M14 6l6 6-6 6',
  star: 'M12 3l2.7 5.7 6.3.8-4.6 4.4 1.1 6.1L12 17l-5.5 3 1.1-6.1L3 9.5l6.3-.8z',
  pin: 'M8 3h8l-1 6 3 3v2H6v-2l3-3z M12 14v7',
  rotate: 'M5 7h11v13H5z M19 8V3h-5 M19 3a8 8 0 0 0-6 1',
  width: 'M4 6v12 M20 6v12 M6 12h12 M9 9l-3 3 3 3 M15 9l3 3-3 3',
  height: 'M6 4h12 M6 20h12 M12 6v12 M9 9l3-3 3 3 M9 15l3 3 3-3',
  ruler: 'M4 17l13-13 3 3L7 20z M11 10l3 3 M8 13l2 2',
  fit: 'M9 4H4v5 M15 4h5v5 M4 15v5h5 M20 15v5h-5 M8 8l-4-4 M16 8l4-4 M8 16l-4 4 M16 16l4 4',
  file: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9.5 12h5 M9.5 15.5h5',
  'file-plus':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M12 11v6 M9 14h6',
  'file-import':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M12 11v7 M8.5 14.5L12 18l3.5-3.5',
  folder:
    'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z',
  'folder-open':
    'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z M3 11.5h18',
  'folder-plus':
    'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z M12 10.5v5 M9.5 13h5',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.4 15.4L20 20',
  graph:
    'M6 8.2a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 6 8.2z M18 9.2a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 18 9.2z M8 20.2a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 8 20.2z M17 19.2a2.2 2.2 0 1 0 0-4.4A2.2 2.2 0 0 0 17 19.2z M6 6L18 7 M6 6L8 18 M18 7L17 17 M8 18L17 17',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  save: 'M5 5a2 2 0 0 1 2-2h10l4 4v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5z M8 3v5h8V4.5 M8 21v-7h8v7',
  'arrow-back': 'M19 12H5 M11 6l-6 6 6 6',
  'arrow-forward': 'M5 12h14 M13 6l6 6-6 6',
  edit: 'M14.5 4.5l5 5L8 21H3v-5L14.5 4.5z M12.5 6.5l5 5',
  book: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5z M4 18.5A2.5 2.5 0 0 1 6.5 16H20 M8 7.5h8',
  columns:
    'M4.5 4h15a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M12 4v16',
  'split-right':
    'M3.5 4.5h17v15h-17z M11.5 4.5v15 M15 12h5 M17.5 9.5L20 12l-2.5 2.5',
  'split-down':
    'M3.5 4.5h17v15h-17z M3.5 11.5h17 M12 15v5 M9.5 17.5L12 20l2.5-2.5',
  menu: 'M4 6.5h16 M4 12h16 M4 17.5h16',
  more: 'M6 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z M18 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z',
  trash:
    'M4 7h16 M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2 M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12 M10 11v5.5 M14 11v5.5',
  close: 'M6 6l12 12 M18 6L6 18',
  link: 'M10 14a4 4 0 0 0 6 .4l2.2-2.2a4 4 0 1 0-5.66-5.66L11.3 7.8 M14 10a4 4 0 0 0-6-.4l-2.2 2.2a4 4 0 1 0 5.66 5.66l1.24-1.26',
  shield:
    'M12 3l7.5 3v5.2c0 4.6-3.1 8-7.5 9.8-4.4-1.8-7.5-5.2-7.5-9.8V6l7.5-3z',
  spark:
    'M12 3.5c.8 5 2.7 6.9 7.7 7.7-5 .8-6.9 2.7-7.7 7.7-.8-5-2.7-6.9-7.7-7.7 5-.8 6.9-2.7 7.7-7.7z',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66 M17.5 3v3.5H14',
  'panel-left':
    'M4.5 4h15a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M9.5 4v16',
  'panel-right':
    'M4.5 4h15a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M14.5 4v16',
  'list-tree':
    'M4.5 5.5h3 M10.5 5.5h9 M6 5.5v6.5h3 M10.5 12h9 M6 12v6.5h3 M10.5 18.5h9',
  sliders:
    'M4 6h5 M15 6h5 M12 3v6 M4 12h9 M17 12h3 M15 9v6 M4 18h3 M13 18h7 M10 15v6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  'window-min': 'M6 12.2h12',
  'window-max': 'M6.5 6.5h11v11h-11z',
  'window-restore': 'M9.5 6.5h8v8h-2.5 M6.5 9.5h8v8h-8z',
  palette:
    'M12 3a9 9 0 0 0 0 18c1.4 0 2.2-.9 2.2-2 0-.6-.3-1-.6-1.4-.3-.4-.6-.8-.6-1.4 0-1.1.9-2 2-2h2.2c1.9 0 3.3-1.5 3.3-3.4C20.5 6.4 16.7 3 12 3z M7.5 10.2a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z M11.2 7.6a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z M15.4 8a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5.5 M12 7.6h.01',
  blocks:
    'M4.5 4.5h6.2v6.2H4.5z M13.3 4.5h6.2v6.2h-6.2z M4.5 13.3h6.2v6.2H4.5z M13.3 13.3h6.2v6.2h-6.2z',
  ink: 'M12 3.5l5 5-3.2 7.8L12 19l-1.8-2.7L7 8.5l5-5z M9.2 6.3l5.6 5.6 M12 12v6.5 M9 21h6',
  canvas:
    'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5z M7 14.5l4-5 3 3 3-3 M7 14.5h3 M17 9.5v3',
  notebook:
    'M8 3.5h9A1.5 1.5 0 0 1 18.5 5v14A1.5 1.5 0 0 1 17 20.5H8A1.5 1.5 0 0 1 6.5 19V5A1.5 1.5 0 0 1 8 3.5z M4 7.5h4 M4 12h4 M4 16.5h4 M10.5 9h5 M10.5 13h5',
  undo: 'M9 7l-5 5 5 5 M5 12h8.5a5.5 5.5 0 0 1 5.5 5.5',
  redo: 'M15 7l5 5-5 5 M19 12h-8.5A5.5 5.5 0 0 0 5 17.5',
  cursor: 'M6.5 3.5L18 12l-5.4 1.2L10 19.5z',
  pen: 'M4 20l1.2-4.2L15.5 5.5a2.1 2.1 0 0 1 3 3L8.2 18.8 4 20z M13.5 7.5l3 3',
  fountain:
    'M4.5 19.5L10.2 17.4 M4.5 19.5L6.6 13.8 M4.5 19.5L7.2 16.8 M10.2 17.4L16.2 10 M6.6 13.8L14 7.8 M14.2 12.2L11.8 9.8 M16.2 10L14 7.8',
  brush:
    'M4 20C5.6 19.2 7.4 18 9.3 16.8 M4 20C5 18.4 6 16.6 7.2 14.7 M9.3 16.8L7.2 14.7 M9.3 16.8L16.5 10.6 M7.2 14.7L13.4 7.5 M16.5 10.6L13.4 7.5',
  pencil:
    'M4 20L5.2 18.8 M5.2 18.8L10.6 15.3 M5.2 18.8L8.7 13.4 M10.6 15.3L8.7 13.4 M10.6 15.3L16.2 9.6 M8.7 13.4L14.4 7.8 M16.2 9.6L14.4 7.8 M14.5 11.4L12.6 9.5 M15.5 10.3L13.7 8.5',
  highlighter: 'M15 4l5 5-8 8H8.2L4 19l1-4.2L15 4z M12.5 6.5l5 5 M4 21.5h7',
  eraser:
    'M11 4l9 9-5.5 5.5h-4L5 13a1.5 1.5 0 0 1 0-2.1L8.9 4a1.5 1.5 0 0 1 2.1 0z M9 7l8 8 M12 20.5h8',
  'eraser-precision':
    'M14.5 3.5l6 6-7 7h-3L5.4 11.4a1.4 1.4 0 0 1 0-2L12.7 3.6a1.4 1.4 0 0 1 1.8-.1z M13.2 8.2l3.2 3.2 M12 20.5h8',
  lasso:
    'M4.5 9.5a7.5 4.8 0 1 0 15 0 7.5 4.8 0 1 0-15 0z M11.6 14.2c.1 2.1-1.5 3-2.4 4.4-.5.9.2 2 1.3 2 1 0 1.7-.9 1.4-1.9-.3-1.1-1.4-1.6-2.7-1.7',
  shapes: 'M4 4h9v9H4z M19.5 15a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z',
  image:
    'M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5z M8.2 11a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z M5 17l4.5-4.5 2.8 2.8 3-3L19 16',
  triangle: 'M12 3 22 21H2Z',
  diamond: 'M12 2 22 12 12 22 2 12Z',
  'rounded-rectangle':
    'M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z',
  rect: 'M4.5 6.5h15v11h-15z',
  ellipse: 'M12 17.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z',
  'arrow-line': 'M5 19L19 5 M13 5h6v6',
  type: 'M5 6V4.5h14V6 M12 4.5v15 M9 19.5h6',
  'zoom-in':
    'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.4 15.4L20 20 M8 10.5h5 M10.5 8v5',
  pages:
    'M7.5 3.5h12A1.5 1.5 0 0 1 21 5v10.5 M17.5 8.5v10A1.5 1.5 0 0 1 16 20H5a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 5 7h11a1.5 1.5 0 0 1 1.5 1.5z',
  download: 'M12 4v11 M7.5 11l4.5 4.5L16.5 11 M5 19.5h14',
  indent: 'M4 5h16 M4 19h16 M10 9.5h10 M10 14.5h10 M4 9.5l3 2.5-3 2.5',
  outdent: 'M4 5h16 M4 19h16 M10 9.5h10 M10 14.5h10 M7 9.5L4 12l3 2.5',
  quote:
    'M10 11H5V6h5v5z M19 11h-5V6h5v5z M5 11c0 3-1 4.5-2 5.5 M14 11c0 3-1 4.5-2 5.5',
  'list-bullet': 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  'list-numbered':
    'M10 6h10 M10 12h10 M10 18h10 M4 5h1v3 M4 11h1v3H4.5a.5.5 0 0 0 0 1H5 M4 18h1a1 1 0 0 1 0 2H4',
  'list-check':
    'M9 6h11 M9 12h11 M9 18h11 M3.5 6l1.2 1.2L7 4.8 M3.5 12l1.2 1.2L7 10.8 M3.5 18l1.2 1.2L7 16.8',
  bold: 'M7 4.5h6a3.5 3.5 0 0 1 0 7H7z M7 11.5h7a3.75 3.75 0 0 1 0 7.5H7z M7 4.5v14.5',
  italic: 'M10 4.5h8 M6 19.5h8 M14.5 4.5l-5 15',
  strikethrough:
    'M5 12h14 M8 8.5a3.5 3.5 0 0 1 3.5-3h1a3.5 3.5 0 0 1 3.5 3 M16 15a3.5 3.5 0 0 1-3.5 3h-1A3.5 3.5 0 0 1 8 15',
  code: 'M9 7l-5 5 5 5 M15 7l5 5-5 5',
  heading: 'M6 4.5v15 M18 4.5v15 M6 12h12',
  align: 'M5 5v14 M9 7h10 M9 12h7 M9 17h10',
  distribute: 'M5 5v14 M19 5v14 M8 8h3v8H8z M13 8h3v8h-3z',
  layers:
    'M12 3.5L21 8l-9 4.5L3 8l9-4.5z M4.5 12l7.5 3.8 7.5-3.8 M4.5 16l7.5 3.8 7.5-3.8',
  lock: 'M6.5 10h11v10h-11z M8.5 10V7a3.5 3.5 0 0 1 7 0v3 M12 14v2.5',
  unlock: 'M6.5 10h11v10h-11z M15.5 10V7a3.5 3.5 0 0 0-6.5-1.8 M12 14v2.5',
  group:
    'M4.5 4.5h6v6h-6z M13.5 13.5h6v6h-6z M9 7.5h4a3.5 3.5 0 0 1 3.5 3.5v2.5',
  ungroup: 'M4.5 4.5h6v6h-6z M13.5 13.5h6v6h-6z M10 13.5l4-4 M10 9.5l4 4',
  copy: 'M8 8h11v11H8z M5 16V5h11',
  'file-pdf':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9 12h1.8a1.5 1.5 0 0 1 0 3H9v-3z M9 14.6h1.2 M12.7 12v3 M12.7 13.5h1.8l1 1.5 M15.5 12v3h2.2 M15.5 13.5h1.6',
  'file-image':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M7.5 15.2l3-3 2 1.8 3-2.7 1.5 3.7H7.5z M9.2 10a1.1 1.1 0 1 1 0-2.2 1.1 1.1 0 0 1 0 2.2z',
  'file-video':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M10 11.5l5 3-5 3v-6z',
  'file-audio':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9.5 13.3a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z M14 10.2v5.2 M9.5 14.7V11l5-1.2',
  'file-text':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9 12h6 M9 15h6 M9 18h4',
  'file-code':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9.5 13.5l-2.7 2.7 2.7 2.7 M14.5 13.5l2.7 2.7-2.7 2.7 M11.5 19l2-8',
  'file-archive':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9 12h6 M9.5 14.8v5 M14.5 14.8v5 M9.8 17h4.4',
  markdown:
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M8.5 17v-5l3.5 3 3.5-3v5',
  blockpage:
    'M6 3.5h12A1.5 1.5 0 0 1 19.5 5v14A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z M8 8h3v3H8z M13 8h3 M13 10.5h3 M8 14h8 M8 17h6',
  database:
    'M4.5 6.5c0-1.7 3.4-3 7.5-3s7.5 1.3 7.5 3-3.4 3-7.5 3-7.5-1.3-7.5-3z M4.5 6.5v11c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-11 M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3',
  'file-latex':
    'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z M14 3v4h4 M9.5 11.5h5L12 14l2.5 2.5h-5',
};

/**
 * Reversible icon registry. A later registration for the same name shadows
 * the previous one; disposing the replacement restores it.
 */
export interface IconRegistry {
  register(name: string, svgPath: string): { dispose(): void };
  get(name: string): string | undefined;
  has(name: string): boolean;
  names(): readonly string[];
}

const defaultPaths = new Map<string, string>(
  Object.entries(DEFAULT_ICON_PATHS),
);
const overrides = new Map<string, string>();

function resolve(name: string): string | undefined {
  return overrides.get(name) ?? defaultPaths.get(name);
}

/** Path lookup shared by createIcon() and the React <Icon/> twin. */
export function resolveIconPath(name: string): string | undefined {
  return resolve(name);
}

/** Process-wide default registry used by createIcon(). */
export const defaultIconRegistry: IconRegistry = {
  register(name, svgPath) {
    const previous = overrides.get(name);
    overrides.set(name, svgPath);
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        if (previous === undefined) overrides.delete(name);
        else overrides.set(name, previous);
      },
    };
  },
  get: (name) => resolve(name),
  has: (name) => resolve(name) !== undefined,
  names: () => [...new Set([...defaultPaths.keys(), ...overrides.keys()])],
};

export function createIcon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('froglight-icon', `icon-${name}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const d = resolve(name);
  if (d !== undefined) path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}
