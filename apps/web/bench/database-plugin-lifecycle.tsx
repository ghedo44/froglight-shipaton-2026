import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  InMemorySearchService,
  captureDatabaseEvaluationContext,
  createDatabase,
  databaseKind,
  documentKindId,
  memoryVaultPlugin,
  resourcePropertyPath,
  workspacePath,
  type DatabaseModel,
  type DocumentRef,
  type EvaluatedDatabaseRow,
  type PropertyCatalog,
  type ResourcePropertyDefinition,
} from '@froglight/foundation';
import { createApp, type FroglightApp } from '@froglight/application';
import { CommunityPluginManager } from '@froglight/plugin-platform';
import { DatabaseContent } from '@froglight/ui/react';

const pluginId = 'acme.research';
const pluginKindId = documentKindId('acme.research.card');
const pluginPropertyType = 'acme.research.rating';

interface ResearchCard {
  readonly title: string;
  readonly body: string;
  readonly opaque: {
    readonly futureVersion: number;
    readonly payload: readonly (string | number)[];
  };
}

interface LifecycleReport {
  ready: boolean;
  error?: string;
  provider: 'active' | 'withdrawn';
  activations: number;
  disposals: number;
  documentRegistryChanges: number;
  propertyCatalogChanges: number;
  propertyWriteCallbacks: number;
  bytesBeforeWithdrawal: readonly number[];
  bytesAfterReactivation: readonly number[];
  databaseBytesBeforeWithdrawal: readonly number[];
  databaseBytesAfterReactivation: readonly number[];
  propertyBytesBeforeWithdrawal: readonly number[];
  propertyBytesAfterReactivation: readonly number[];
  membershipPreserved: boolean;
  propertyConfigurationPreserved: boolean;
  templateConfigurationPreserved: boolean;
  kindRegistrations: number;
  propertyTypeRegistrations: number;
}

declare global {
  interface Window {
    __froglightPluginDatabaseLifecycle?: LifecycleReport;
  }
}

const report: LifecycleReport = {
  ready: false,
  provider: 'withdrawn',
  activations: 0,
  disposals: 0,
  documentRegistryChanges: 0,
  propertyCatalogChanges: 0,
  propertyWriteCallbacks: 0,
  bytesBeforeWithdrawal: [],
  bytesAfterReactivation: [],
  databaseBytesBeforeWithdrawal: [],
  databaseBytesAfterReactivation: [],
  propertyBytesBeforeWithdrawal: [],
  propertyBytesAfterReactivation: [],
  membershipPreserved: false,
  propertyConfigurationPreserved: false,
  templateConfigurationPreserved: false,
  kindRegistrations: 0,
  propertyTypeRegistrations: 0,
};
window.__froglightPluginDatabaseLifecycle = report;

const pluginSource = `
export function activate(facades) {
  const report = globalThis.__froglightPluginDatabaseLifecycle;
  report.activations += 1;
  facades.documents.registerKind({
    id: 'acme.research.card',
    creation: {
      label: 'Research card',
      extension: '.research-card',
      createInitialModel: (title) => ({
        title,
        body: '',
        opaque: { futureVersion: 7, payload: ['preserve', 42] },
      }),
    },
    cloneTemplate: (model) => structuredClone(model),
    decode: (bytes) => ({
      model: JSON.parse(new TextDecoder().decode(bytes)),
      metadata: {},
      relationships: [],
    }),
    encode: (model) => new TextEncoder().encode(JSON.stringify(model)),
    searchText: (model) => model.title + '\\n' + model.body,
  });
  facades.properties.registerType({
    id: 'acme.research.rating',
    label: 'Research rating',
    storage: 'stored',
    editor: 'number',
    validate: (value, definition) => {
      const min = typeof definition.min === 'number' ? definition.min : 0;
      const max = typeof definition.max === 'number' ? definition.max : 5;
      return typeof value === 'number' && value >= min && value <= max
        ? null
        : 'Expected a rating from ' + min + ' to ' + max;
    },
  });
  report.documentRegistryChanges += 1;
  report.propertyCatalogChanges += 1;
  return () => {
    report.disposals += 1;
    report.documentRegistryChanges += 1;
    report.propertyCatalogChanges += 1;
  };
}
`;

interface Harness {
  readonly app: FroglightApp;
  readonly manager: CommunityPluginManager;
  readonly catalog: PropertyCatalog;
  readonly card: DocumentRef;
  readonly database: DocumentRef;
  readonly model: DatabaseModel;
  rows(): Promise<readonly EvaluatedDatabaseRow[]>;
  snapshotAfterReactivation(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [databaseKind],
  });
  const workspace = app.getWorkspace();
  const properties = app.getResourceProperties();
  const query = app.getDatabaseQuery();
  const vault = app.getVault();
  if (!workspace || !properties || !query || !vault)
    throw new Error('Froglight database runtime did not activate');
  const manager = new CommunityPluginManager({ runtime: app.runtime });
  await manager.attach(vault);
  await manager.install({
    manifestJson: {
      manifestVersion: 1,
      id: pluginId,
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['documents.registerKind', 'properties.registerType'],
    },
    code: pluginSource,
  });
  await manager.enable(pluginId);
  report.provider = 'active';
  report.kindRegistrations = app.getDocumentKind(pluginKindId) ? 1 : 0;
  report.propertyTypeRegistrations = properties.catalog.get(pluginPropertyType)
    ? 1
    : 0;

  const initialCard: ResearchCard = {
    title: 'Independent plugin resource',
    body: 'Canonical bytes owned by the independent provider.',
    opaque: { futureVersion: 7, payload: ['preserve', 42] },
  };
  const card = await workspace.createDocument({
    kindId: pluginKindId,
    path: workspacePath('Independent.research-card'),
    initialModel: initialCard,
  });
  const rating: ResourcePropertyDefinition = {
    id: 'quality',
    name: 'Quality',
    type: pluginPropertyType,
    min: 0,
    max: 5,
    providerConfiguration: {
      palette: 'frog',
      untouched: ['future', 1],
    },
  };
  await properties.write(card, rating, 4);
  const model = createDatabase('Plugin resources');
  const initialView = model.views[0];
  if (!initialView) throw new Error('Default database view unavailable');
  model.properties = [rating];
  model.membership = {
    mode: 'explicit',
    resourceIds: [card.location.resourceId],
  };
  model.views[0] = {
    ...initialView,
    visibleProperties: ['quality'],
  };
  model.templates = [
    {
      id: 'research-card-template',
      name: 'Research card',
      kindId: pluginKindId,
      model: initialCard,
      defaults: { quality: 3 },
      providerConfiguration: { mode: 'independent', opaque: ['keep', 9] },
    },
  ];
  const view = model.views[0];
  if (!view) throw new Error('Database view unavailable');
  const database = await workspace.createDocument({
    kindId: databaseKind.id,
    path: workspacePath('Plugin resources.base'),
    initialModel: model,
  });
  const cardPath = workspace.resolveResourcePath(card.location.resourceId);
  const databasePath = workspace.resolveResourcePath(
    database.location.resourceId,
  );
  report.bytesBeforeWithdrawal = [...(await vault.read(cardPath))];
  report.databaseBytesBeforeWithdrawal = [...(await vault.read(databasePath))];
  report.propertyBytesBeforeWithdrawal = [
    ...(await vault.read(resourcePropertyPath(card.location.resourceId))),
  ];

  const rows = async () =>
    await query.execute(model, view, properties.rows(), '', {
      evaluation: captureDatabaseEvaluationContext(),
    });
  const snapshotAfterReactivation = async () => {
    report.bytesAfterReactivation = [...(await vault.read(cardPath))];
    report.databaseBytesAfterReactivation = [
      ...(await vault.read(databasePath)),
    ];
    report.propertyBytesAfterReactivation = [
      ...(await vault.read(resourcePropertyPath(card.location.resourceId))),
    ];
    const decoded = await workspace.readDocument<DatabaseModel>(
      database.documentId,
    );
    report.membershipPreserved =
      decoded.model.membership.mode === 'explicit' &&
      decoded.model.membership.resourceIds.length === 1 &&
      decoded.model.membership.resourceIds[0] === card.location.resourceId;
    const property = decoded.model.properties.find(
      (candidate) => candidate.id === 'quality',
    );
    report.propertyConfigurationPreserved =
      JSON.stringify(property?.['providerConfiguration']) ===
      JSON.stringify(rating['providerConfiguration']);
    report.templateConfigurationPreserved =
      JSON.stringify(decoded.model.templates[0]?.['providerConfiguration']) ===
      JSON.stringify(model.templates[0]?.['providerConfiguration']);
  };
  return {
    app,
    manager,
    catalog: properties.catalog,
    card,
    database,
    model,
    rows,
    snapshotAfterReactivation,
  };
}

function AcceptanceSurface({ harness }: { readonly harness: Harness }) {
  const [provider, setProvider] = useState<'active' | 'withdrawn'>('active');
  const [rows, setRows] = useState<readonly EvaluatedDatabaseRow[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(
    async () => setRows(await harness.rows()),
    [harness],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withdraw = async () => {
    setBusy(true);
    await harness.manager.disable(pluginId);
    report.provider = 'withdrawn';
    report.kindRegistrations = harness.app.getDocumentKind(pluginKindId)
      ? 1
      : 0;
    report.propertyTypeRegistrations = harness.catalog.get(pluginPropertyType)
      ? 1
      : 0;
    setProvider('withdrawn');
    await refresh();
    setBusy(false);
  };
  const reactivate = async () => {
    setBusy(true);
    await harness.manager.enable(pluginId);
    report.provider = 'active';
    report.kindRegistrations = harness.app.getDocumentKind(pluginKindId)
      ? 1
      : 0;
    report.propertyTypeRegistrations = harness.catalog.get(pluginPropertyType)
      ? 1
      : 0;
    setProvider('active');
    await harness.snapshotAfterReactivation();
    await refresh();
    setBusy(false);
  };
  const properties = harness.app.getResourceProperties();
  if (!properties) throw new Error('Resource property service unavailable');
  return (
    <section aria-label="Plugin database lifecycle acceptance">
      <h1>Plugin database lifecycle acceptance</h1>
      <p>
        Independent document provider:{' '}
        <strong data-testid="provider-state">{provider}</strong>
      </p>
      <p role="status" data-testid="document-action-state">
        {provider === 'active'
          ? 'Research card actions available'
          : 'Research card provider unavailable; canonical content is preserved'}
      </p>
      <div>
        <button
          type="button"
          disabled={busy || provider === 'withdrawn'}
          onClick={() => void withdraw()}
        >
          Disable provider
        </button>{' '}
        <button
          type="button"
          disabled={busy || provider === 'active'}
          onClick={() => void reactivate()}
        >
          Re-enable provider
        </button>
      </div>
      <DatabaseContent
        model={harness.model}
        view={harness.model.views[0]}
        rows={rows}
        readOnly={false}
        catalog={harness.catalog}
        write={() => undefined}
        writeCell={async (id, propertyId, value) => {
          report.propertyWriteCallbacks += 1;
          if (id !== harness.card.location.resourceId)
            throw new Error('Unexpected database row');
          const definition = harness.model.properties.find(
            (property) => property.id === propertyId,
          );
          if (!definition) throw new Error('Property definition unavailable');
          await properties.write(harness.card, definition, value);
          await refresh();
        }}
        openResource={() => undefined}
      />
    </section>
  );
}

const rootNode = document.getElementById('plugin-database-root');
if (!rootNode) throw new Error('Plugin database lifecycle root unavailable');
const root = createRoot(rootNode);
void createHarness()
  .then(async (harness) => {
    root.render(<AcceptanceSurface harness={harness} />);
    report.ready = true;
  })
  .catch((error: unknown) => {
    report.error = error instanceof Error ? error.message : String(error);
    report.ready = true;
    root.render(<pre role="alert">{report.error}</pre>);
  });
