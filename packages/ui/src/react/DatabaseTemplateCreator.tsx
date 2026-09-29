import { useCallback, useRef, useState } from 'react';
import {
  cloneTemplateValue,
  generateResourceId,
  type DatabaseController,
  type DatabaseRelationChoice,
  type DatabaseTemplate,
  type DocumentEditorRegistry,
  type DocumentRegistry,
  type PropertyValue,
  type ResourceId,
} from '@froglight/foundation';
import { Cell } from './DatabaseContent.js';
import type { RelationChoicePage } from './DatabaseRelationPicker.js';
import {
  ProviderTemplateEditor,
  type ProviderTemplateEditorRef,
} from './ProviderTemplateEditor.js';
import styles from './DatabaseView.module.css';

interface TemplateDraft {
  readonly id: string;
  readonly kindId: string;
  readonly model: unknown;
  readonly creating: boolean;
  name: string;
  defaults: Record<string, PropertyValue>;
}

/** Author document content and property defaults without creating a workspace document. */
export function DatabaseTemplateCreator({
  controller,
  disabled,
  mutate,
  documents,
  editors,
  relationChoices,
  loadRelationChoices,
}: {
  controller: DatabaseController;
  disabled: boolean;
  mutate(operation: () => Promise<unknown>): Promise<void>;
  documents: DocumentRegistry;
  editors: DocumentEditorRegistry;
  relationChoices: Readonly<Record<string, readonly DatabaseRelationChoice[]>>;
  loadRelationChoices?(
    propertyId: string,
    search: string,
    selected: readonly ResourceId[],
    signal: AbortSignal,
  ): Promise<RelationChoicePage>;
}) {
  const [name, setName] = useState('');
  const [kindId, setKindId] = useState('');
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [editorAvailable, setEditorAvailable] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [defaultError, setDefaultError] = useState('');
  const editorRef = useRef<ProviderTemplateEditorRef | null>(null);
  const creators = documents
    .list()
    .filter((kind) => kind.creation && kind.cloneTemplate);
  const selected = creators.find((kind) => kind.id === kindId) ?? creators[0];
  const onEditorAvailability = useCallback(
    (available: boolean) => setEditorAvailable(available),
    [],
  );
  const onEditorDirty = useCallback(() => setContentDirty(true), []);

  const editTemplate = (template: DatabaseTemplate): void => {
    const kind = documents.recognize(template.kindId);
    if (!kind?.cloneTemplate) return;
    setDefaultError('');
    setContentDirty(false);
    setDraft({
      id: template.id,
      name: template.name,
      kindId: template.kindId,
      model: cloneTemplateValue(template.model),
      defaults: cloneTemplateValue(template.defaults),
      creating: false,
    });
  };

  if (draft) {
    const kind = documents.recognize(draft.kindId);
    const writable = controller.model.properties.filter(
      (property) =>
        controller.properties.catalog.writeReason(property) === null &&
        !(property.type === 'relation' && property.relation?.inverse),
    );
    return (
      <section
        className={styles.templateEditor}
        aria-label={draft.creating ? 'New template' : 'Edit template'}
      >
        <header className={styles.templateHeader}>
          <div>
            <strong>{draft.creating ? 'New template' : 'Edit template'}</strong>
            <small>
              Content and property defaults are saved together. No document is
              added to the workspace.
            </small>
          </div>
          {contentDirty && <span>Unsaved content</span>}
        </header>
        <label className={styles.templateName}>
          Template name
          <input
            required
            value={draft.name}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, name: event.target.value } : current,
              )
            }
          />
        </label>
        {kind?.cloneTemplate ? (
          <ProviderTemplateEditor
            editors={editors}
            kindId={kind.id}
            templateId={draft.id}
            model={draft.model}
            editorRef={editorRef}
            onAvailabilityChange={onEditorAvailability}
            onDirty={onEditorDirty}
          />
        ) : (
          <p className={styles.templateError} role="alert">
            This template’s document kind is unavailable or cannot safely clone
            template content. Its stored content has been left unchanged.
          </p>
        )}
        <fieldset className={styles.templateDefaults}>
          <legend>Property defaults</legend>
          {writable.length === 0 ? (
            <p className={styles.templateNotice}>
              Add a writable property to configure defaults.
            </p>
          ) : (
            writable.map((property) => {
              const descriptor = controller.properties.catalog.get(
                property.type,
              );
              return (
                <div key={property.id}>
                  <span>{property.name}</span>
                  <Cell
                    property={property}
                    editor={descriptor?.editor}
                    choices={relationChoices[property.id]}
                    relationLookupScope={`${controller.model.id}:${property.id}:template`}
                    loadRelationChoices={
                      loadRelationChoices
                        ? (search, selected, signal) =>
                            loadRelationChoices(
                              property.id,
                              search,
                              selected,
                              signal,
                            )
                        : undefined
                    }
                    value={draft.defaults[property.id] ?? null}
                    readOnly={false}
                    busy={disabled}
                    onWrite={(value) => {
                      const diagnostic =
                        controller.properties.catalog.diagnostic(
                          property,
                          value,
                        );
                      setDefaultError(
                        diagnostic ? `${property.name}: ${diagnostic}` : '',
                      );
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              defaults: {
                                ...current.defaults,
                                [property.id]: value,
                              },
                            }
                          : current,
                      );
                    }}
                  />
                </div>
              );
            })
          )}
          {defaultError && (
            <p className={styles.templateError} role="alert">
              {defaultError}
            </p>
          )}
        </fieldset>
        <div className={styles.templateActions}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setDraft(null);
              setContentDirty(false);
              setDefaultError('');
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={
              disabled ||
              !draft.name.trim() ||
              !kind?.cloneTemplate ||
              !editorAvailable ||
              Boolean(defaultError)
            }
            onClick={() => {
              const providerEditor = editorRef.current;
              if (!providerEditor || !editorAvailable || defaultError) return;
              providerEditor.flush();
              void mutate(async () => {
                await controller.saveTemplate({
                  id: draft.id,
                  name: draft.name.trim(),
                  kindId: draft.kindId,
                  model: cloneTemplateValue(providerEditor.model),
                  defaults: cloneTemplateValue(draft.defaults),
                });
                setDraft(null);
                setContentDirty(false);
              });
            }}
          >
            Save template
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.templateManager} aria-label="Database templates">
      <div className={styles.templateSectionHeading}>
        <div>
          <strong>Templates</strong>
          <small>
            Reusable document content with optional property defaults.
          </small>
        </div>
      </div>
      {controller.model.templates.length > 0 && (
        <div className={styles.templateList}>
          {controller.model.templates.map((template) => {
            const kind = documents.recognize(template.kindId);
            const supported = Boolean(kind?.cloneTemplate);
            return (
              <div className={styles.templateRow} key={template.id}>
                <div>
                  <strong>{template.name}</strong>
                  <small>
                    {kind?.creation?.label ?? template.kindId}
                    {!supported ? ' · Provider unavailable' : ''}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={disabled || !supported}
                  onClick={() => editTemplate(template)}
                >
                  Edit
                </button>
              </div>
            );
          })}
        </div>
      )}
      <form
        className={styles.templateCreate}
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !selected?.creation || !selected.cloneTemplate)
            return;
          setDefaultError('');
          setContentDirty(false);
          setDraft({
            id: generateResourceId(),
            name: name.trim(),
            kindId: selected.id,
            model: selected.creation.createInitialModel(name.trim()),
            defaults: {},
            creating: true,
          });
          setName('');
        }}
      >
        <label>
          Template name
          <input
            required
            value={name}
            disabled={disabled || creators.length === 0}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Document kind
          <select
            aria-label="Template document kind"
            value={selected?.id ?? ''}
            disabled={disabled || creators.length === 0}
            onChange={(event) => setKindId(event.target.value)}
          >
            {creators.map((kind) => (
              <option key={kind.id} value={kind.id}>
                {kind.creation!.label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={disabled || creators.length === 0}>
          Customize template
        </button>
      </form>
      {creators.length === 0 && (
        <p className={styles.templateNotice} role="status">
          No installed document kind currently supports safe template cloning.
        </p>
      )}
    </section>
  );
}
