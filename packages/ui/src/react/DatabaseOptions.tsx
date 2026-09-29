import { useState } from 'react';
import { type DatabaseProperty } from '@froglight/foundation';

/** Options are user-authored values. Their IDs survive rename and reordering. */
export function DatabaseOptions({
  property,
  disabled,
  save,
}: {
  property: DatabaseProperty;
  disabled: boolean;
  save(property: DatabaseProperty): void;
}) {
  const [name, setName] = useState('');
  const options = property.options ?? [];
  return (
    <fieldset>
      <legend>{property.name} options</legend>
      {options.map((option, index) => (
        <div key={option.id}>
          <input
            aria-label={`${property.name} option name`}
            defaultValue={option.name}
            disabled={disabled}
            onBlur={(event) => {
              const name = event.target.value.trim();
              if (name && name !== option.name)
                save({
                  ...property,
                  options: options.map((item) =>
                    item.id === option.id ? { ...item, name } : item,
                  ),
                });
            }}
          />
          <select
            aria-label={`Color for ${option.name}`}
            value={option.color ?? 'default'}
            disabled={disabled}
            onChange={(event) =>
              save({
                ...property,
                options: options.map((item) =>
                  item.id === option.id
                    ? { ...item, color: event.target.value }
                    : item,
                ),
              })
            }
          >
            {[
              'default',
              'gray',
              'red',
              'orange',
              'yellow',
              'green',
              'blue',
              'purple',
              'pink',
            ].map((color) => (
              <option key={color}>{color}</option>
            ))}
            {option.color &&
              ![
                'default',
                'gray',
                'red',
                'orange',
                'yellow',
                'green',
                'blue',
                'purple',
                'pink',
              ].includes(option.color) && <option>{option.color}</option>}
          </select>
          <button
            type="button"
            aria-label={`Move ${option.name} up`}
            disabled={disabled || index === 0}
            onClick={() => {
              const next = [...options];
              [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
              save({ ...property, options: next });
            }}
          >
            Move up
          </button>
          <button
            type="button"
            aria-label={`Remove ${option.name} option`}
            disabled={disabled}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove “${option.name}” from the choices? Existing documents keep the stored option ID as an unresolved value until you change it.`,
                )
              )
                return;
              save({
                ...property,
                options: options.filter((item) => item.id !== option.id),
              });
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          save({
            ...property,
            options: [
              ...options,
              { id: (() => {
                  const stem = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'option';
                  let id = stem;
                  for (let suffix = 2; options.some((option) => option.id === id); suffix += 1)
                    id = `${stem}-${suffix}`;
                  return id;
                })(), name: name.trim() },
            ],
          });
          setName('');
        }}
      >
        <input
          aria-label={`New option for ${property.name}`}
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
        />
        <button disabled={disabled || !name.trim()}>Add option</button>
      </form>
    </fieldset>
  );
}
