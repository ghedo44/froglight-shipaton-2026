import type { Disposer, SettingsService } from '../../settings.js';
import {
  InkPresetStore,
  type InkPresetToolId,
  type InkToolPreset,
  type SurfaceToolPresetState,
} from './presets.js';

export const SURFACE_STYLE_LIBRARY_VERSION = 1;
const STORAGE_KEY = 'ink.style-library';

export interface SurfaceStylePreset {
  readonly id: string;
  readonly name: string;
  readonly toolKind: InkPresetToolId;
  readonly preset: InkToolPreset;
  readonly favorite: boolean;
  readonly order: number;
}

export interface SurfaceStyleLibraryState {
  readonly version: 1;
  readonly styles: readonly SurfaceStylePreset[];
  readonly currentStyleByTool: Readonly<Record<InkPresetToolId, string | null>>;
  readonly workingState: SurfaceToolPresetState;
}

const EMPTY_CURRENT: Readonly<Record<InkPresetToolId, null>> = {
  pen: null,
  fountain: null,
  brush: null,
  pencil: null,
  highlighter: null,
};

function copyPreset(preset: InkToolPreset): InkToolPreset {
  return {
    ...(preset.color !== undefined ? { color: preset.color } : {}),
    ...(preset.size !== undefined ? { size: preset.size } : {}),
    ...(preset.opacity !== undefined ? { opacity: preset.opacity } : {}),
    ...(preset.straight !== undefined ? { straight: preset.straight } : {}),
    ...(preset.brush !== undefined
      ? {
          brush: JSON.parse(
            JSON.stringify(preset.brush),
          ) as InkToolPreset['brush'],
        }
      : {}),
  };
}

function validStyle(value: unknown): value is SurfaceStylePreset {
  if (typeof value !== 'object' || value === null) return false;
  const raw = value as Partial<SurfaceStylePreset>;
  return (
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    typeof raw.name === 'string' &&
    raw.name.trim().length > 0 &&
    ['pen', 'fountain', 'brush', 'pencil', 'highlighter'].includes(
      raw.toolKind ?? '',
    ) &&
    typeof raw.preset === 'object' &&
    raw.preset !== null &&
    typeof raw.favorite === 'boolean' &&
    Number.isFinite(raw.order)
  );
}

export class SurfaceStyleLibrary {
  readonly #presets: InkPresetStore;
  readonly #settings: SettingsService | null;
  readonly #listeners = new Set<() => void>();
  readonly #idFactory: () => string;
  #styles: SurfaceStylePreset[] = [];
  #current: Record<InkPresetToolId, string | null> = { ...EMPTY_CURRENT };
  #sequence = 0;
  #settingsSubscription: Disposer | null = null;
  #committing = false;

  constructor(options: {
    readonly presets: InkPresetStore;
    readonly settings?: SettingsService;
    readonly idFactory?: () => string;
  }) {
    this.#presets = options.presets;
    this.#settings = options.settings ?? null;
    this.#idFactory =
      options.idFactory ??
      (() =>
        `style-${Date.now().toString(36)}-${(++this.#sequence).toString(36)}`);
    this.#load();
    this.#settingsSubscription =
      this.#settings?.onChange((key) => {
        if (key !== STORAGE_KEY || this.#committing) return;
        this.#load();
        this.#listeners.forEach((listener) => listener());
      }) ?? null;
  }

  snapshot(): SurfaceStyleLibraryState {
    return {
      version: SURFACE_STYLE_LIBRARY_VERSION,
      styles: this.#styles.map((style) => ({
        ...style,
        preset: copyPreset(style.preset),
      })),
      currentStyleByTool: { ...this.#current },
      workingState: this.#presets.snapshot(),
    };
  }

  styles(tool?: InkPresetToolId): readonly SurfaceStylePreset[] {
    return this.#styles
      .filter((style) => tool === undefined || style.toolKind === tool)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((style) => ({ ...style, preset: copyPreset(style.preset) }));
  }

  saveCurrent(tool: InkPresetToolId, name: string): string | null {
    const cleanName = name.trim();
    if (cleanName.length === 0) return null;
    const id = this.#idFactory();
    this.#styles.push({
      id,
      name: cleanName,
      toolKind: tool,
      preset: copyPreset(this.#presets.getTool(tool)),
      favorite: false,
      order: this.#styles.filter((style) => style.toolKind === tool).length,
    });
    this.#current[tool] = id;
    this.#commit();
    return id;
  }

  apply(id: string): boolean {
    const style = this.#styles.find((candidate) => candidate.id === id);
    if (style === undefined) return false;
    this.#presets.setTool(style.toolKind, copyPreset(style.preset));
    this.#current[style.toolKind] = style.id;
    this.#commit();
    return true;
  }

  update(id: string): boolean {
    const index = this.#styles.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    const style = this.#styles[index]!;
    this.#styles[index] = {
      ...style,
      preset: copyPreset(this.#presets.getTool(style.toolKind)),
    };
    this.#current[style.toolKind] = id;
    this.#commit();
    return true;
  }

  rename(id: string, name: string): boolean {
    const cleanName = name.trim();
    const index = this.#styles.findIndex((candidate) => candidate.id === id);
    if (index < 0 || cleanName.length === 0) return false;
    this.#styles[index] = { ...this.#styles[index]!, name: cleanName };
    this.#commit();
    return true;
  }

  setFavorite(id: string, favorite: boolean): boolean {
    const index = this.#styles.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.#styles[index] = { ...this.#styles[index]!, favorite };
    this.#commit();
    return true;
  }

  reorder(tool: InkPresetToolId, ids: readonly string[]): boolean {
    const existing = this.#styles.filter((style) => style.toolKind === tool);
    if (
      ids.length !== existing.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !existing.some((style) => style.id === id))
    )
      return false;
    const order = new Map(ids.map((id, index) => [id, index]));
    this.#styles = this.#styles.map((style) =>
      style.toolKind === tool
        ? { ...style, order: order.get(style.id) ?? style.order }
        : style,
    );
    this.#commit();
    return true;
  }

  delete(id: string): boolean {
    const style = this.#styles.find((candidate) => candidate.id === id);
    if (style === undefined) return false;
    this.#styles = this.#styles.filter((candidate) => candidate.id !== id);
    if (this.#current[style.toolKind] === id)
      this.#current[style.toolKind] = null;
    this.#commit();
    return true;
  }

  reset(tool: InkPresetToolId): boolean {
    const id = this.#current[tool];
    return id !== null && this.apply(id);
  }

  isModified(tool: InkPresetToolId): boolean {
    const id = this.#current[tool];
    const saved = this.#styles.find((style) => style.id === id);
    return (
      saved !== undefined &&
      JSON.stringify(saved.preset) !==
        JSON.stringify(this.#presets.getTool(tool))
    );
  }

  onChange(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  dispose(): void {
    this.#settingsSubscription?.dispose();
    this.#settingsSubscription = null;
    this.#listeners.clear();
  }

  #commit(): void {
    this.#committing = true;
    try {
      this.#settings?.set(STORAGE_KEY, JSON.stringify(this.snapshot()));
    } finally {
      this.#committing = false;
    }
    this.#listeners.forEach((listener) => listener());
  }

  #load(): void {
    const raw = this.#settings?.get(STORAGE_KEY);
    if (typeof raw !== 'string') {
      this.#styles = [];
      this.#current = { ...EMPTY_CURRENT };
      return;
    }
    try {
      const value = JSON.parse(raw) as Partial<SurfaceStyleLibraryState>;
      if (
        value.version !== SURFACE_STYLE_LIBRARY_VERSION ||
        !Array.isArray(value.styles)
      )
        return;
      this.#styles = value.styles
        .filter(validStyle)
        .map((style) => ({ ...style, preset: copyPreset(style.preset) }));
      for (const tool of Object.keys(EMPTY_CURRENT) as InkPresetToolId[]) {
        const id = value.currentStyleByTool?.[tool];
        this.#current[tool] =
          typeof id === 'string' &&
          this.#styles.some(
            (style) => style.id === id && style.toolKind === tool,
          )
            ? id
            : null;
      }
    } catch {
      // Corrupt preferences never prevent document editing; v1 presets remain.
    }
  }
}
