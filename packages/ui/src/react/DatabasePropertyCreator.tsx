import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  databaseKindId,
  captureDatabaseEvaluationContext,
  FormulaFunctions,
  generateResourceId,
  parseFormula,
  type Aggregation,
  type DatabaseController,
  type DatabaseProperty,
  type PropertyValue,
  type ResourceId,
} from '@froglight/foundation';
import styles from './DatabaseView.module.css';

const formulaFunctions = new FormulaFunctions();
const formulaTemplates = [
  {
    name: 'if',
    hint: 'if(condition, yes, no)',
    template: 'if(true, null, null)',
  },
  { name: 'empty', hint: 'empty(value)', template: 'empty($selection)' },
  {
    name: 'concat',
    hint: 'concat(text, text)',
    template: 'concat($selection, "")',
    fallback: '""',
  },
  {
    name: 'length',
    hint: 'length(text or list)',
    template: 'length($selection)',
    fallback: '""',
  },
  {
    name: 'sum',
    hint: 'sum(list)',
    template: 'sum($selection)',
    fallback: '[]',
  },
  {
    name: 'average',
    hint: 'average(list)',
    template: 'average($selection)',
    fallback: '[]',
  },
  {
    name: 'round',
    hint: 'round(number)',
    template: 'round($selection)',
    fallback: '0',
  },
  {
    name: 'contains',
    hint: 'contains(value, item)',
    template: 'contains($selection, "")',
    fallback: '""',
  },
  {
    name: 'dateAdd',
    hint: 'dateAdd(date, days)',
    template: 'dateAdd($selection, 1)',
    fallback: '"2026-01-01"',
  },
] as const;

function displayFormulaValue(value: PropertyValue): string {
  if (value === null) return 'Empty';
  if (typeof value === 'string') return value || 'Empty text';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function DatabasePropertyCreator({
  controller,
  disabled,
  mutate,
  existing,
}: {
  existing?: DatabaseProperty;
  controller: DatabaseController;
  disabled: boolean;
  mutate(operation: () => Promise<unknown>): Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [storageKey, setStorageKey] = useState(existing?.storageKey ?? '');
  const [id, setId] = useState(() => existing?.id ?? generateResourceId());
  const [type, setType] = useState(existing?.type ?? 'text');
  const [formula, setFormula] = useState(existing?.formula ?? '');
  const [targetId, setTargetId] = useState(
    existing?.relation?.databaseId ?? '',
  );
  const [inverseName, setInverseName] = useState('');
  const [relationId, setRelationId] = useState(
    existing?.rollup?.relation ?? '',
  );
  const [targetProperty, setTargetProperty] = useState(
    existing?.rollup?.property ?? '',
  );
  const [aggregation, setAggregation] = useState<Aggregation>(
    existing?.rollup?.aggregation ?? 'count',
  );
  const formulaInput = useRef<HTMLTextAreaElement>(null);
  const formulaHelpId = useId();
  const formulaStatusId = useId();
  const [preview, setPreview] = useState<
    | { state: 'idle' | 'loading' | 'empty' }
    | { state: 'ready'; row: string; value: string }
    | { state: 'error'; message: string }
  >({ state: 'idle' });
  const [rollupPreview, setRollupPreview] = useState<
    | { state: 'idle' | 'loading' | 'empty' }
    | { state: 'ready'; row: string; value: string }
    | { state: 'error'; message: string }
  >({ state: 'idle' });
  const formulaAnalysis = useMemo(() => {
    if (type !== 'formula') return {};
    if (!formula.trim()) return { error: 'Enter a formula.' };
    try {
      const parsed = parseFormula(formula);
      const properties = new Set(
        controller.model.properties.map((property) => property.id),
      );
      const unavailable = parsed.dependencies.filter(
        (dependency) =>
          !properties.has(dependency) &&
          !['$title', '$kind', '$path'].includes(dependency),
      );
      if (unavailable.length)
        return {
          parsed,
          error: `Unavailable ${unavailable.length === 1 ? 'property' : 'properties'}: ${unavailable.join(', ')}. Insert a current property to replace the reference.`,
        };
      if (parsed.dependencies.includes(id))
        return {
          parsed,
          error: 'A formula cannot refer to itself.',
        };
      return { parsed };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [controller.model.properties, formula, id, type]);
  useEffect(() => {
    if (
      type !== 'formula' ||
      !formulaAnalysis.parsed ||
      formulaAnalysis.error
    ) {
      setPreview({ state: 'idle' });
      return;
    }
    let active = true;
    setPreview({ state: 'loading' });
    void (async () => {
      try {
        const rows = await controller.properties.rows();
        const property: DatabaseProperty = {
          ...existing,
          id,
          name: existing?.name ?? 'Formula preview',
          type: 'formula',
          formula,
        };
        const properties = existing
          ? controller.model.properties.map((item) =>
              item.id === existing.id ? property : item,
            )
          : [...controller.model.properties, property];
        const result = await controller.query.execute(
          { ...controller.model, properties },
          { id: 'formula-preview', name: 'Formula preview', type: 'table' },
          rows,
          '',
          { evaluation: captureDatabaseEvaluationContext() },
        );
        if (!active) return;
        const sample = result[0];
        if (sample?.diagnostics[id])
          setPreview({ state: 'error', message: sample.diagnostics[id] });
        else if (sample)
          setPreview({
            state: 'ready',
            row: sample.title,
            value: displayFormulaValue(sample.values[id] ?? null),
          });
        else {
          // Constant formulas can still provide a useful preview in an empty database.
          const value = formulaAnalysis.parsed.dependencies.length
            ? undefined
            : formulaFunctions.evaluate(formulaAnalysis.parsed, () => null);
          setPreview(
            value === undefined
              ? { state: 'empty' }
              : {
                  state: 'ready',
                  row: 'Constant result',
                  value: displayFormulaValue(value),
                },
          );
        }
      } catch (error) {
        if (active)
          setPreview({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [controller, existing, formula, formulaAnalysis, id, type]);
  const insertFormula = (
    text: string,
    selectedText = '',
    fallback = 'null',
  ) => {
    const input = formulaInput.current;
    const start = input?.selectionStart ?? formula.length;
    const end = input?.selectionEnd ?? start;
    const insertion = text.replace('$selection', selectedText || fallback);
    setFormula(`${formula.slice(0, start)}${insertion}${formula.slice(end)}`);
    requestAnimationFrame(() => {
      input?.focus();
      const cursor = start + insertion.length;
      input?.setSelectionRange(cursor, cursor);
    });
  };
  const relation = controller.model.properties.find(
    (property) => property.id === relationId,
  );
  const target = relation?.relation?.databaseId
    ? controller.relations?.definitions.get(
        relation.relation.databaseId as ResourceId,
      )
    : controller.model;
  useEffect(() => {
    if (type !== 'rollup') {
      setRollupPreview({ state: 'idle' });
      return;
    }
    const selectedRelation = controller.model.properties.find(
      (property) => property.id === relationId && property.type === 'relation',
    );
    const selectedTarget = selectedRelation?.relation?.databaseId
      ? controller.relations?.definitions.get(
          selectedRelation.relation.databaseId as ResourceId,
        )
      : controller.model;
    if (!selectedRelation || !selectedTarget || !targetProperty) {
      setRollupPreview({ state: 'idle' });
      return;
    }
    if (
      !selectedTarget.properties.some(
        (property) => property.id === targetProperty,
      )
    ) {
      setRollupPreview({
        state: 'error',
        message: 'Related property unavailable.',
      });
      return;
    }
    let active = true;
    setRollupPreview({ state: 'loading' });
    void (async () => {
      try {
        const property: DatabaseProperty = {
          id,
          name: name.trim() || 'Rollup preview',
          type: 'rollup',
          rollup: {
            relation: relationId,
            property: targetProperty,
            aggregation,
          },
        };
        const properties = existing
          ? controller.model.properties.map((item) =>
              item.id === existing.id ? property : item,
            )
          : [...controller.model.properties, property];
        const result = await controller.query.execute(
          { ...controller.model, properties },
          { id: 'rollup-preview', name: 'Rollup preview', type: 'table' },
          await controller.properties.rows(),
          '',
          { evaluation: captureDatabaseEvaluationContext() },
        );
        if (!active) return;
        const sample =
          result.find(
            (row) =>
              Array.isArray(row.values[relationId]) &&
              row.values[relationId].length > 0,
          ) ?? result[0];
        if (!sample) setRollupPreview({ state: 'empty' });
        else if (sample.diagnostics[id])
          setRollupPreview({ state: 'error', message: sample.diagnostics[id] });
        else
          setRollupPreview({
            state: 'ready',
            row: sample.title,
            value: displayFormulaValue(sample.values[id] ?? null),
          });
      } catch (error) {
        if (active)
          setRollupPreview({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => {
      active = false;
    };
  }, [
    aggregation,
    controller,
    existing,
    id,
    name,
    relationId,
    targetProperty,
    type,
  ]);
  return (
    <form
      className={styles.propertyForm}
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void mutate(async () => {
          const key = storageKey || name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
          let nativeKey = key || `property-${id.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
          if (!existing && controller.model.version === 1) {
            const definitions = await Promise.all(controller.workspace.listDocuments()
              .filter((ref) => ref.kindId === databaseKindId)
              .map(async (ref) => ref.documentId === controller.session.document.documentId
                ? controller.model
                : (await controller.workspace.readDocument<typeof controller.model>(ref.documentId)).model));
            if (definitions.some((model) => model.properties.some((field) =>
              field.id !== id && field.storageKey === nativeKey))) {
              if (storageKey) throw new Error('Document key is already bound; enter a unique key.');
              const stem = nativeKey;
              nativeKey = `${stem}-${id.replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
              if (definitions.some((model) => model.properties.some((field) =>
                field.id !== id && field.storageKey === nativeKey)))
                throw new Error('Document key is already bound; enter a unique key.');
            }
          }
          const property = { ...existing, id, name: name.trim(), type,
            ...(!existing && controller.model.version === 1 && !['formula', 'rollup', 'created', 'updated'].includes(type)
              ? { storageKey: nativeKey }
              : {}) };
          if (type === 'relation') {
            const next = {
              ...property,
              relation: { ...existing?.relation, databaseId: targetId },
            };
            if (next.relation.inverse) await controller.saveProperty(next);
            else await controller.saveRelation(next, inverseName);
          } else
            await controller.saveProperty({
              ...property,
              ...(type === 'formula' ? { formula } : {}),
              ...(type === 'rollup'
                ? {
                    rollup: {
                      relation: relationId,
                      property: targetProperty,
                      aggregation,
                    },
                  }
                : {}),
              ...(['select', 'multi-select'].includes(type)
                ? { options: existing?.options ?? [] }
                : {}),
            });
          if (!existing) {
            setName('');
            setStorageKey('');
            setId(generateResourceId());
          }
        });
      }}
    >
      {controller.model.version === 1 && !['formula', 'rollup', 'created', 'updated'].includes(type) && (
        <label>Document key <input value={storageKey} onChange={(event) => setStorageKey(event.target.value)}
          disabled={disabled || !!existing} placeholder="From property name" pattern="[A-Za-z][A-Za-z0-9_-]*" /></label>
      )}
      <label>
        Property name{' '}
        <input
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <label>
        Type{' '}
        <select
          value={type}
          disabled={disabled}
          onChange={(event) => setType(event.target.value)}
        >
          {controller.properties.catalog.list().map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      {type === 'formula' && (
        <fieldset className={styles.formulaEditor}>
          <legend>Formula</legend>
          <div className={styles.formulaInsertions}>
            <label>
              Insert property
              <select
                aria-label="Insert formula property"
                disabled={disabled}
                value=""
                onChange={(event) => {
                  if (event.target.value)
                    insertFormula(
                      `prop(${JSON.stringify(event.target.value)})`,
                    );
                }}
              >
                <option value="">Choose a property</option>
                {controller.model.properties
                  .filter((property) => property.id !== id)
                  .map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Insert function
              <select
                aria-label="Insert formula function"
                disabled={disabled}
                value=""
                onChange={(event) => {
                  const input = formulaInput.current;
                  const selection = input?.value.slice(
                    input.selectionStart,
                    input.selectionEnd,
                  );
                  const template = formulaTemplates.find(
                    ({ name }) => name === event.target.value,
                  );
                  if (template)
                    insertFormula(
                      template.template,
                      selection,
                      'fallback' in template ? template.fallback : undefined,
                    );
                }}
              >
                <option value="">Choose a function</option>
                {formulaTemplates.map((template) => (
                  <option key={template.name} value={template.name}>
                    {template.hint}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            ref={formulaInput}
            aria-label="Formula expression"
            aria-describedby={`${formulaHelpId} ${formulaStatusId}`}
            aria-invalid={Boolean(formulaAnalysis.error)}
            value={formula}
            disabled={disabled}
            onChange={(event) => setFormula(event.target.value)}
            rows={3}
            required
          />
          <small id={formulaHelpId} className={styles.formulaHelp}>
            Properties are stored by stable ID, so renaming them will not break
            this formula. Operators include +, -, *, /, comparisons, && and ||.
          </small>
          <div
            id={formulaStatusId}
            className={
              formulaAnalysis.error ? styles.formulaError : styles.formulaStatus
            }
            role="status"
          >
            {formulaAnalysis.error
              ? formulaAnalysis.error
              : preview.state === 'loading'
                ? 'Checking a sample row…'
                : preview.state === 'error'
                  ? `Preview: ${preview.message}`
                  : preview.state === 'ready'
                    ? `Preview · ${preview.row}: ${preview.value}`
                    : preview.state === 'empty'
                      ? 'No matching rows are available to preview.'
                      : ''}
          </div>
        </fieldset>
      )}
      {type === 'relation' && (
        <>
          <label>
            Target database{' '}
            <select
              required
              disabled={disabled}
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Choose a database</option>
              {controller.properties
                .rows()
                .filter((row) => row.kindId === databaseKindId)
                .map((row) => (
                  <option key={row.resourceId} value={row.resourceId}>
                    {row.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Two-way property name{' '}
            <input
              placeholder="Optional name in the target database"
              disabled={disabled}
              value={inverseName}
              onChange={(event) => setInverseName(event.target.value)}
            />
          </label>
        </>
      )}
      {type === 'rollup' && (
        <>
          <label>
            Relation property{' '}
            <select
              required
              disabled={disabled}
              value={relationId}
              onChange={(event) => {
                setRelationId(event.target.value);
                setTargetProperty('');
              }}
            >
              <option value="">Choose a relation</option>
              {controller.model.properties
                .filter((property) => property.type === 'relation')
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Related property{' '}
            <select
              required
              disabled={disabled || !relationId}
              value={targetProperty}
              onChange={(event) => setTargetProperty(event.target.value)}
            >
              <option value="">Choose a property</option>
              {target?.properties
                .filter((property) => property.type !== 'rollup')
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Calculation{' '}
            <select
              disabled={disabled}
              value={aggregation}
              onChange={(event) =>
                setAggregation(event.target.value as Aggregation)
              }
            >
              {['count', 'sum', 'average', 'min', 'max', 'list', 'unique'].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </label>
          <div
            className={
              rollupPreview.state === 'error'
                ? styles.formulaError
                : styles.formulaStatus
            }
            role="status"
          >
            {rollupPreview.state === 'loading'
              ? 'Checking a related sample row…'
              : rollupPreview.state === 'error'
                ? `Preview: ${rollupPreview.message}`
                : rollupPreview.state === 'ready'
                  ? `Preview · ${rollupPreview.row}: ${rollupPreview.value}`
                  : rollupPreview.state === 'empty'
                    ? 'No matching rows are available to preview.'
                    : 'Choose a relation and related property for a preview.'}
          </div>
        </>
      )}
      <button
        disabled={disabled || Boolean(formulaAnalysis.error)}
        type="submit"
      >
        {existing ? 'Save property' : 'Add property'}
      </button>
    </form>
  );
}
