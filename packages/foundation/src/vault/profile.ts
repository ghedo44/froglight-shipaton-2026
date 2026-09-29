import { workspacePath } from '../paths.js';
import type { VaultService } from './contract.js';
import { ensureDirectory } from './helpers.js';

export const VAULT_PROFILE_PATH = workspacePath('.froglight/vault.json');
export const VAULT_ICONS = [
  'folder-open',
  'apple',
  'satellite',
  'book',
  'star',
  'heart',
  'globe',
  'leaf',
  'coffee',
  'music',
  'camera',
  'briefcase',
  'rocket',
  'flask',
  'palette',
  'code',
  'mountain',
  'compass',
  'lightbulb',
  'graduation-cap',
] as const;
export const VAULT_COLORS = [
  'neutral',
  'violet',
  'blue',
  'green',
  'amber',
  'rose',
  'orange',
  'teal',
] as const;
export type VaultIcon = (typeof VAULT_ICONS)[number];
export type VaultColor = (typeof VAULT_COLORS)[number];
export interface VaultAppearance {
  readonly icon: VaultIcon;
  readonly color: VaultColor;
}
export interface VaultProfile extends VaultAppearance {
  readonly name: string;
}
export const DEFAULT_VAULT_APPEARANCE: VaultAppearance = {
  icon: 'folder-open',
  color: 'neutral',
};
const MAX_BYTES = 16 * 1024;

function parseRecord(
  bytes: Uint8Array,
): Record<string, unknown> & VaultProfile {
  if (bytes.byteLength > MAX_BYTES)
    throw new Error('Vault details exceed the size limit.');
  let value: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    const encoded = new TextEncoder().encode(text);
    if (
      encoded.length !== bytes.length ||
      encoded.some((byte, index) => byte !== bytes[index])
    )
      throw new Error('Invalid UTF-8');
    value = JSON.parse(text);
  } catch {
    throw new Error('Vault details contain invalid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid vault details.');
  const record = value as Record<string, unknown>;
  if (record['format'] !== 'froglight.vault' || record['version'] !== 1)
    throw new Error('Unsupported vault details format.');
  validateProfile(record);
  return record as Record<string, unknown> & VaultProfile;
}
function validateProfile(value: Record<string, unknown>): void {
  if (
    typeof value['name'] !== 'string' ||
    value['name'].trim().length === 0 ||
    value['name'].length > 120 ||
    [...value['name']].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error(
      'Vault name must contain 1–120 characters without control characters.',
    );
  if (
    !VAULT_ICONS.some((icon) => icon === value['icon']) ||
    !VAULT_COLORS.some((color) => color === value['color'])
  )
    throw new Error('Unsupported vault icon or color.');
}
export function decodeVaultProfile(bytes: Uint8Array): VaultProfile {
  const { name, icon, color } = parseRecord(bytes);
  return { name, icon, color };
}
async function readRecord(
  vault: VaultService,
): Promise<(Record<string, unknown> & VaultProfile) | null> {
  try {
    const stat = await vault.stat(VAULT_PROFILE_PATH);
    if (stat.size > MAX_BYTES)
      throw new Error('Vault details exceed the size limit.');
    return parseRecord(await vault.read(VAULT_PROFILE_PATH));
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'NOT_FOUND'
    )
      return null;
    throw error;
  }
}
export async function readVaultProfile(
  vault: VaultService,
): Promise<VaultProfile | null> {
  const record = await readRecord(vault);
  return record === null
    ? null
    : { name: record.name, icon: record.icon, color: record.color };
}
/** Canonical local write. Observable vaults notify the ordinary sync pipeline. */
export async function writeVaultProfile(
  vault: VaultService,
  profile: VaultProfile,
): Promise<void> {
  validateProfile({ ...profile });
  const existing = await readRecord(vault);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      ...existing,
      format: 'froglight.vault',
      version: 1,
      name: profile.name,
      icon: profile.icon,
      color: profile.color,
    }) + '\n',
  );
  if (bytes.byteLength > MAX_BYTES)
    throw new Error('Vault details exceed the size limit.');
  await ensureDirectory(vault, workspacePath('.froglight'));
  await vault.write(VAULT_PROFILE_PATH, bytes);
}
