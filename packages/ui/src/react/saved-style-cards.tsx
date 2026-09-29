/**
 * First-class saved-style cards.
 *
 * Visual hierarchy per plan:
 *
 * ```text
 * Saved styles [cards][+]
 * Current style modified [Update][Save as new][Reset]
 * ```
 *
 * Each card communicates name, pen family, color, approximate stroke
 * appearance (via `BrushPreview`), width, selected state, and favorite
 * state — never color alone. All eight operations route through the
 * existing provider command channel (`execute` with the established
 * `*.saved-style` / `*.save-style` / `*.rename-style` / `*.favorite-style`
 * / `*.move-style-*` / `*.update-style` / `*.delete-style` /
 * `*.reset-style` ids); no second store exists. Working-vs-saved semantics
 * are explicit: selecting applies into working, modifying sets the
 * modified indicator without mutating the saved preset, update/reset are
 * explicit and disabled when clean.
 *
 * React owns visible structure; providers own state. The
 * section adapts the structured `savedStyles` payload on the
 * `surface.style.saved` choice control (see `surface-tool-settings.ts`);
 * legacy snapshots without that payload fall back to generic rendering in
 * the caller — this module never parses display labels.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  DocumentToolControl,
  SavedStyleCardData,
  SavedStylePresetData,
} from '@froglight/foundation';
import { BrushPreview } from './brush-preview.jsx';
import { Icon } from './Icon.jsx';
import styles from './saved-style-cards.module.css';

export type SavedStyleExecute = (id: string, value?: string) => void;

const TOOL_FAMILY_LABELS: Record<string, string> = {
  pen: 'Ball Pen',
  fountain: 'Fountain Pen',
  brush: 'Brush Pen',
  pencil: 'Pencil',
  highlighter: 'Highlighter',
};

/** Human family name for one preset tool id.*/
export function savedStyleFamilyLabel(toolKind: string): string {
  return TOOL_FAMILY_LABELS[toolKind] ?? toolKind;
}

/** Display width (`3.5 pt`) with a stable fallback for absent sizes. */
export function formatStyleWidth(preset: SavedStylePresetData): string {
  return typeof preset.size === 'number' && Number.isFinite(preset.size)
    ? `${preset.size} pt`
    : 'default width';
}

/**
 * Accessible card label: never color alone.
 * Example: `Blue Fountain Pen, 3.5 pt, favorite, selected`.
 */
export function savedStyleA11yLabel(
  style: SavedStyleCardData,
  selected: boolean,
): string {
  const family = savedStyleFamilyLabel(style.toolKind);
  const width = formatStyleWidth(style.preset);
  const parts = [`${style.name} ${family}`, width];
  if (style.favorite) parts.push('favorite');
  if (selected) parts.push('selected');
  return parts.join(', ');
}

/** Control-id suffix after `<prefix>.settings.<tool>.`. */
function fieldOf(id: string, prefix: string, tool: string): string | null {
  const head = `${prefix}.settings.${tool}.`;
  return id.startsWith(head) ? id.slice(head.length) : null;
}

function inferToolAndPrefix(
  controls: readonly DocumentToolControl[],
): { prefix: string; tool: string } | null {
  for (const control of controls) {
    if (
      control.kind === 'choice' &&
      control.semanticRole === 'surface.style.saved'
    ) {
      // `<prefix>.settings.<tool>.saved-style`
      const rest = control.id.slice(0, control.id.lastIndexOf('.saved-style'));
      const sep = rest.lastIndexOf('.settings.');
      if (sep < 0) return null;
      const prefix = rest.slice(0, sep);
      const tool = rest.slice(sep + '.settings.'.length);
      if (prefix !== '' && tool !== '') return { prefix, tool };
    }
  }
  return null;
}

export interface SavedStylesSectionProps {
  /** Full `settings`-group controls for the active tool. */
  readonly controls: readonly DocumentToolControl[];
  readonly execute: SavedStyleExecute;
}

/**
 * Visual saved-styles section replacing the generic form rendering for the
 * nine saved-style control ids. Returns null when no structured payload is
 * present (legacy snapshot) so the caller falls back to generic controls.
 */
export function SavedStylesSection(
  props: SavedStylesSectionProps,
): React.ReactElement | null {
  const { controls, execute } = props;
  const inferred = inferToolAndPrefix(controls);
  if (inferred === null) return null;
  const { prefix, tool } = inferred;
  const saved = controls.find(
    (entry): entry is Extract<DocumentToolControl, { kind: 'choice' }> =>
      entry.kind === 'choice' &&
      entry.id === `${prefix}.settings.${tool}.saved-style`,
  );
  if (saved === undefined || saved.savedStyles === undefined) return null;
  const cardStyles: readonly SavedStyleCardData[] = saved.savedStyles;
  const currentId = saved.value !== '' ? saved.value : null;
  const modified = saved.savedStyleModified === true;
  const workingPreset: SavedStylePresetData = saved.workingPreset ?? {};
  const byField = new Map<string, DocumentToolControl>();
  for (const control of controls) {
    const field = fieldOf(control.id, prefix, tool);
    if (field !== null) byField.set(field, control);
  }
  const saveControl = byField.get('save-style');
  const renameControl = byField.get('rename-style');
  const earlierControl = byField.get('move-style-earlier');
  const laterControl = byField.get('move-style-later');
  const updateControl = byField.get('update-style');
  const deleteControl = byField.get('delete-style');
  const resetControl = byField.get('reset-style');
  const selected =
    currentId !== null
      ? (cardStyles.find((style) => style.id === currentId) ?? null)
      : null;

  const selectedCardRef = useRef<HTMLButtonElement | null>(null);
  const saveNameRef = useRef<HTMLInputElement | null>(null);
  const [saveDraft, setSaveDraft] = useState('');
  const [renameDraft, setRenameDraft] = useState(selected?.name ?? '');
  useEffect(() => {
    setRenameDraft(selected?.name ?? '');
  }, [selected?.id, selected?.name]);

  const run = (field: string, value?: string): void => {
    execute(`${prefix}.settings.${tool}.${field}`, value);
  };

  const commitSave = (): void => {
    const name = saveDraft.trim();
    if (name === '') return;
    saveNameRef.current?.focus();
    run('save-style', name);
    setSaveDraft('');
  };
  const commitRename = (): void => {
    const name = renameDraft.trim();
    if (name === '' || selected === null || name === selected.name) return;
    run('rename-style', name);
  };

  return (
    <section
      className={styles['fl-saved-styles']}
      aria-label="Saved styles"
      data-saved-styles={tool}
    >
      <div className={styles['fl-saved-styles-head']}>
        <span className={styles['fl-saved-styles-title']} aria-hidden="true">
          Saved styles
        </span>
        {modified && currentId !== null ? (
          <span className={styles['fl-saved-styles-modified']} role="status">
            Current style modified
          </span>
        ) : null}
      </div>

      {cardStyles.length === 0 ? (
        <p className={styles['fl-saved-styles-empty']}>
          No saved styles yet — save the current style to reuse it.
        </p>
      ) : (
        <ul
          className={styles['fl-saved-styles-grid']}
          aria-label="Saved styles"
        >
          {cardStyles.map((style) => {
            const isSelected = style.id === currentId;
            return (
              <li
                key={style.id}
                className={styles['fl-saved-style-cell']}
                data-selected={isSelected ? 'true' : undefined}
                data-favorite={style.favorite ? 'true' : undefined}
              >
                <button
                  type="button"
                  className={styles['fl-saved-style-card']}
                  ref={isSelected ? selectedCardRef : undefined}
                  aria-label={savedStyleA11yLabel(style, isSelected)}
                  aria-pressed={isSelected}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => run('saved-style', style.id)}
                >
                  <BrushPreview
                    toolKind={style.toolKind}
                    preset={style.preset}
                  />
                  <span
                    className={styles['fl-saved-style-name']}
                    aria-hidden="true"
                  >
                    {style.name}
                  </span>
                  <span
                    className={styles['fl-saved-style-meta']}
                    aria-hidden="true"
                  >
                    <span
                      className={styles['fl-saved-style-dot']}
                      style={
                        style.preset.color !== undefined
                          ? { backgroundColor: style.preset.color }
                          : undefined
                      }
                    />
                    {savedStyleFamilyLabel(style.toolKind)} ·{' '}
                    {formatStyleWidth(style.preset)}
                  </span>
                  <span className={styles['fl-saved-style-badges']}>
                    {style.favorite ? (
                      <span
                        className={styles['fl-saved-style-badge']}
                        data-badge="favorite"
                      >
                        Favorite
                      </span>
                    ) : null}
                    {isSelected ? (
                      <span
                        className={styles['fl-saved-style-badge']}
                        data-badge="selected"
                      >
                        Selected
                      </span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={styles['fl-saved-style-star']}
                  aria-label={
                    style.favorite
                      ? `Unfavorite ${style.name}`
                      : `Favorite ${style.name}`
                  }
                  aria-pressed={style.favorite}
                  title={style.favorite ? 'Unfavorite' : 'Favorite'}
                  onClick={() => run('favorite-style', style.id)}
                >
                  <span>{style.favorite ? 'Unfavorite' : 'Favorite'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected !== null ? (
        <div
          className={styles['fl-saved-styles-detail']}
          data-selected-style={selected.id}
        >
          <div className={styles['fl-saved-styles-working']}>
            <span
              className={styles['fl-saved-styles-working-label']}
              aria-hidden="true"
            >
              {modified ? 'Working style (modified)' : 'Working style'}
            </span>
            <BrushPreview toolKind={selected.toolKind} preset={workingPreset} />
          </div>
          <div
            className={styles['fl-saved-styles-actions']}
            role="group"
            aria-label={`Actions for ${selected.name}`}
          >
            {updateControl !== undefined ? (
              <button
                type="button"
                className={styles['fl-saved-styles-action']}
                aria-label={`Update ${selected.name} to the working style`}
                disabled={
                  updateControl.kind === 'button' &&
                  updateControl.disabled === true
                }
                onClick={() => {
                  selectedCardRef.current?.focus();
                  run('update-style');
                }}
              >
                <Icon name="save" size={15} />
                <span>Update preset</span>
              </button>
            ) : null}
            {resetControl !== undefined ? (
              <button
                type="button"
                className={styles['fl-saved-styles-action']}
                aria-label={`Reset working style to ${selected.name}`}
                disabled={
                  resetControl.kind === 'button' &&
                  resetControl.disabled === true
                }
                onClick={() => {
                  selectedCardRef.current?.focus();
                  run('reset-style');
                }}
              >
                <Icon name="refresh" size={15} />
                <span>Reset</span>
              </button>
            ) : null}
            {/* Per-card star toggles above are the single favorite control:
                the detail region keeps update/reset/reorder/delete only. */}
            {earlierControl !== undefined ? (
              <button
                type="button"
                className={styles['fl-saved-styles-action']}
                aria-label={`Move ${selected.name} earlier`}
                disabled={
                  earlierControl.kind === 'button' &&
                  earlierControl.disabled === true
                }
                onClick={() => {
                  selectedCardRef.current?.focus();
                  run('move-style-earlier');
                }}
              >
                <span>Move earlier</span>
              </button>
            ) : null}
            {laterControl !== undefined ? (
              <button
                type="button"
                className={styles['fl-saved-styles-action']}
                aria-label={`Move ${selected.name} later`}
                disabled={
                  laterControl.kind === 'button' &&
                  laterControl.disabled === true
                }
                onClick={() => {
                  selectedCardRef.current?.focus();
                  run('move-style-later');
                }}
              >
                <span>Move later</span>
              </button>
            ) : null}
            {deleteControl !== undefined ? (
              <button
                type="button"
                className={styles['fl-saved-styles-action']}
                data-action="delete"
                aria-label={`Delete ${selected.name}`}
                onClick={() => {
                  saveNameRef.current?.focus();
                  run('delete-style', selected.id);
                }}
              >
                <Icon name="trash" size={15} />
                <span>Delete</span>
              </button>
            ) : null}
          </div>
          {renameControl !== undefined && renameControl.kind === 'input' ? (
            <form
              className={styles['fl-saved-styles-form']}
              aria-label={`Rename ${selected.name}`}
              onSubmit={(event) => {
                event.preventDefault();
                event.currentTarget.querySelector('input')?.focus();
                commitRename();
              }}
            >
              <label className={styles['fl-saved-styles-field']}>
                <span className={styles['fl-saved-styles-field-label']}>
                  Rename
                </span>
                <input
                  type="text"
                  aria-label={`Rename ${selected.name}`}
                  placeholder="Style name"
                  value={renameDraft}
                  maxLength={80}
                  onChange={(event) =>
                    setRenameDraft(event.currentTarget.value)
                  }
                />
              </label>
              <button
                type="submit"
                className={styles['fl-saved-styles-action']}
                disabled={
                  renameDraft.trim() === '' ||
                  renameDraft.trim() === selected.name
                }
              >
                <Icon name="edit" size={15} />
                <span>Rename</span>
              </button>
            </form>
          ) : null}
        </div>
      ) : (
        <p className={styles['fl-saved-styles-working-note']}>
          Working style — select a saved style or save the current one.
        </p>
      )}

      {saveControl !== undefined && saveControl.kind === 'input' ? (
        <form
          className={styles['fl-saved-styles-form']}
          aria-label="Save current style as new"
          onSubmit={(event) => {
            event.preventDefault();
            commitSave();
          }}
        >
          <label className={styles['fl-saved-styles-field']}>
            <span className={styles['fl-saved-styles-field-label']}>
              Save current as new
            </span>
            <input
              type="text"
              ref={saveNameRef}
              aria-label="New style name"
              placeholder={saveControl.placeholder ?? 'Style name'}
              value={saveDraft}
              maxLength={80}
              onChange={(event) => setSaveDraft(event.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            className={styles['fl-saved-styles-action']}
            data-action="save"
            disabled={saveDraft.trim() === ''}
          >
            <Icon name="plus" size={15} />
            <span>Save as new</span>
          </button>
        </form>
      ) : null}
    </section>
  );
}
