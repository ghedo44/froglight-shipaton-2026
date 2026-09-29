# Froglight

**Shipaton 2026 — Next Gen Award**

A local-first workspace for writing, studying and visual thinking. Froglight
brings text notes, handwriting, PDFs and whiteboards together so a study session
can move between them without changing apps.

The submission focuses on the native iOS/iPadOS app. The browser/PWA host runs
the shared workbench and offers a quick way to explore it. Froglight is pre-release.

## What you can do

- Write Markdown notes and structured Block Pages.
- Write and draw in paged notebooks or infinite whiteboards.
- Annotate PDF-backed notebook pages while keeping the original PDF intact.
- Connect and find documents with links, search and database views.
- Save and reopen local work without an account or network.

## Try the core workflow

1. Create a disposable local vault from the launcher.
2. Create a notebook, write or draw on a page, and try the ink tools and undo/redo.
3. Import a PDF into a notebook and annotate its pages.
4. Add a text note or whiteboard in the same vault and switch between documents.
5. Save, close and reopen a document to check persistence.

Use the native app to evaluate pen, touch and iPad interactions. The browser host
can demonstrate the shared workspace, but does not verify Apple Pencil behavior.

## Run the browser version

With **Node.js 24** and **pnpm 11.20.0**, run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm nx run web:build
pnpm --filter @froglight/web preview
```

Open the localhost URL printed by Vite. Local editing needs no service credentials.
See [Build and run](docs/BUILDING.md) for desktop setup, optional service
configuration and verification commands. For the native submission target, see
[iOS/iPadOS build and installation](docs/IOS_LIMRUN.md).

## How it works

User files are authoritative. Each document family keeps its own format and
editing engine; the shared workspace handles navigation, document identity,
saving and recovery. Search indexes and previews are derived and rebuildable.
PDF annotations are stored separately from the original PDF.

The Tauri native host and browser host share React UI and TypeScript document
services. Ink, notebooks and whiteboards share a Surface engine. Pending Surface
edits use a local recovery journal before publication to the vault; editor
undo/redo and persistent document revisions are separate.

Local editing is available without signing in. Optional Froglight Pro sync uses
Firebase and native RevenueCat purchases. The RevenueCat entitlement is `pro`,
with offering `default`; the Firebase integration supplies server-side sync
authorization. Purchases and cloud sync require your own service configuration.
Cloud sync replicates committed files and is not end-to-end encrypted.

## Source map

| Location                                                       | What to inspect                                          |
| -------------------------------------------------------------- | -------------------------------------------------------- |
| `apps/native`, `apps/web`                                      | Native and browser hosts                                 |
| `packages/application`, `packages/ui`                          | Shared workflows and workbench                           |
| `packages/editor-*`                                            | Text, ink, notebook and whiteboard editors               |
| `packages/foundation`                                          | Document models, saving, recovery and workspace services |
| `packages/provider-*`                                          | Storage, PDF, LaTeX and cloud integrations               |
| `packages/runtime`, `packages/sdk`, `packages/plugin-platform` | Capability composition and plugin support                |
| `infra/firebase`                                               | Optional sync backend configuration and emulator tests   |
| `.github/workflows`                                            | Build and verification workflows                         |
| `assets`                                                       | App icon and brand assets                                |

## License

[MIT](LICENSE), copyright © 2026 Federico Ghedini.
Third-party dependencies retain their own licenses.
