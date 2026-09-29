/** Presentation metadata for the shared insertion catalog. */
export const SLASH_GROUPS = [
  'Basic',
  'Headings',
  'Lists',
  'Media',
  'Layout',
  'Technical',
  'Knowledge',
  'Plugins',
] as const;

export function slashPresentation(item: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly typeId?: string;
}): {
  group: string;
  description: string;
  symbol: string;
} {
  const id = item.id;
  if (id.startsWith('opaque:'))
    return {
      group: 'Plugins',
      description: item.hint ?? item.typeId ?? '',
      symbol: '◆',
    };
  if (id.startsWith('core:heading-'))
    return {
      group: 'Headings',
      description: `Start a ${item.label.toLowerCase()} section`,
      symbol: `H${id.slice(-1)}`,
    };
  const presentations: Record<string, [string, string, string]> = {
    'core:paragraph': ['Basic', 'Write plain text', '¶'],
    'core:quote': ['Basic', 'Set a quotation apart', '❞'],
    'core:todo': ['Basic', 'Track a task', '☑'],
    'core:toggle': ['Basic', 'Hide details until needed', '▸'],
    'core:callout': ['Basic', 'Highlight important information', '✦'],
    'core:divider': ['Basic', 'Separate sections', '—'],
    'core:bullet': ['Lists', 'Create a bulleted list', '•'],
    'core:numbered': ['Lists', 'Create a numbered list', '1.'],
    'core:image': ['Media', 'Add a picture', '▧'],
    'core:video': ['Media', 'Add a video', '▷'],
    'core:audio': ['Media', 'Add audio', '♫'],
    'core:file': ['Media', 'Attach a file', '▤'],
    'core:table': ['Layout', 'Organize information in cells', '▦'],
    'core:code': ['Technical', 'Write a code snippet', '</>'],
    'core:math': ['Technical', 'Write an equation', '∑'],
    'core:diagram': ['Technical', 'Create a diagram', '◇'],
    'core:resource-link': ['Knowledge', 'Link to another resource', '↗'],
    'core:resource-embed': ['Knowledge', 'Preview another resource', '▣'],
    'core:transclusion': ['Knowledge', 'Include content from a resource', '↳'],
    'core:linked-view': ['Knowledge', 'Show a linked view', '⊞'],
  };
  const [group, description, symbol] = presentations[id] ?? [
    'Basic',
    item.hint ?? '',
    '•',
  ];
  return { group, description, symbol };
}
