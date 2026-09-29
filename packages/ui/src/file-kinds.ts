/**
 * Single extension-keyed table for file kinds: the icon shown in trees and
 * tab strips, the MIME type used to build preview blobs, and the preview
 * strategy for raw (non-document) files. The explorer, the tab strip, and
 * the preview components all read from this one source of truth.
 */

import type { IconName } from './icons.js';

export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'binary';

export interface FileKindInfo {
  readonly icon: IconName;
  readonly mime: string;
  readonly preview: PreviewKind;
}

const fileKind = (
  icon: IconName,
  mime: string,
  preview: PreviewKind,
): FileKindInfo => ({ icon, mime, preview });

const FILE_KINDS: Record<string, FileKindInfo> = {
  // Images the web engine can decode.
  png: fileKind('file-image', 'image/png', 'image'),
  jpg: fileKind('file-image', 'image/jpeg', 'image'),
  jpeg: fileKind('file-image', 'image/jpeg', 'image'),
  gif: fileKind('file-image', 'image/gif', 'image'),
  webp: fileKind('file-image', 'image/webp', 'image'),
  svg: fileKind('file-image', 'image/svg+xml', 'image'),
  bmp: fileKind('file-image', 'image/bmp', 'image'),
  ico: fileKind('file-image', 'image/x-icon', 'image'),
  avif: fileKind('file-image', 'image/avif', 'image'),
  tiff: fileKind('file-image', 'image/tiff', 'image'),
  tif: fileKind('file-image', 'image/tiff', 'image'),
  // Image formats engines cannot decode: keep the icon, force the download
  // fallback instead of a broken <img>.
  heic: fileKind('file-image', 'image/heic', 'binary'),
  heif: fileKind('file-image', 'image/heif', 'binary'),

  pdf: fileKind('file-pdf', 'application/pdf', 'pdf'),

  mp4: fileKind('file-video', 'video/mp4', 'video'),
  m4v: fileKind('file-video', 'video/mp4', 'video'),
  webm: fileKind('file-video', 'video/webm', 'video'),
  mov: fileKind('file-video', 'video/quicktime', 'video'),
  avi: fileKind('file-video', 'video/x-msvideo', 'video'),
  mkv: fileKind('file-video', 'video/x-matroska', 'video'),
  wmv: fileKind('file-video', 'video/x-ms-wmv', 'video'),
  flv: fileKind('file-video', 'video/x-flv', 'video'),

  mp3: fileKind('file-audio', 'audio/mpeg', 'audio'),
  wav: fileKind('file-audio', 'audio/wav', 'audio'),
  flac: fileKind('file-audio', 'audio/flac', 'audio'),
  ogg: fileKind('file-audio', 'audio/ogg', 'audio'),
  m4a: fileKind('file-audio', 'audio/mp4', 'audio'),
  aac: fileKind('file-audio', 'audio/mp4', 'audio'),
  wma: fileKind('file-audio', 'audio/x-ms-wma', 'audio'),
  opus: fileKind('file-audio', 'audio/opus', 'audio'),
  aiff: fileKind('file-audio', 'audio/aiff', 'audio'),
  aif: fileKind('file-audio', 'audio/aiff', 'audio'),

  md: fileKind('markdown', 'text/markdown', 'text'),
  markdown: fileKind('markdown', 'text/markdown', 'text'),
  mdx: fileKind('markdown', 'text/markdown', 'text'),
  txt: fileKind('file-text', 'text/plain', 'text'),
  csv: fileKind('file-text', 'text/csv', 'text'),
  log: fileKind('file-text', 'text/plain', 'text'),
  rtf: fileKind('file-text', 'text/rtf', 'text'),
  tex: fileKind('file-latex', 'text/x-tex', 'text'),
  latex: fileKind('file-text', 'text/x-tex', 'text'),
  bib: fileKind('file-text', 'text/x-bibtex', 'text'),

  json: fileKind('file-code', 'application/json', 'text'),
  js: fileKind('file-code', 'text/javascript', 'text'),
  ts: fileKind('file-code', 'text/typescript', 'text'),
  tsx: fileKind('file-code', 'text/typescript', 'text'),
  jsx: fileKind('file-code', 'text/jsx', 'text'),
  html: fileKind('file-code', 'text/html', 'text'),
  htm: fileKind('file-code', 'text/html', 'text'),
  css: fileKind('file-code', 'text/css', 'text'),
  xml: fileKind('file-code', 'application/xml', 'text'),
  yaml: fileKind('file-code', 'text/yaml', 'text'),
  yml: fileKind('file-code', 'text/yaml', 'text'),
  toml: fileKind('file-code', 'text/plain', 'text'),
  sh: fileKind('file-code', 'text/x-sh', 'text'),
  bat: fileKind('file-code', 'text/plain', 'text'),
  ps1: fileKind('file-code', 'text/plain', 'text'),
  c: fileKind('file-code', 'text/x-c', 'text'),
  cpp: fileKind('file-code', 'text/x-c', 'text'),
  h: fileKind('file-code', 'text/x-c', 'text'),
  hpp: fileKind('file-code', 'text/x-c', 'text'),
  cs: fileKind('file-code', 'text/x-csharp', 'text'),
  java: fileKind('file-code', 'text/x-java', 'text'),
  py: fileKind('file-code', 'text/x-python', 'text'),
  rb: fileKind('file-code', 'text/x-ruby', 'text'),
  go: fileKind('file-code', 'text/x-go', 'text'),
  rs: fileKind('file-code', 'text/x-rust', 'text'),
  php: fileKind('file-code', 'text/x-php', 'text'),

  zip: fileKind('file-archive', 'application/zip', 'binary'),
  tar: fileKind('file-archive', 'application/x-tar', 'binary'),
  gz: fileKind('file-archive', 'application/gzip', 'binary'),
  bz2: fileKind('file-archive', 'application/x-bzip2', 'binary'),
  xz: fileKind('file-archive', 'application/x-xz', 'binary'),
  '7z': fileKind('file-archive', 'application/x-7z-compressed', 'binary'),
  rar: fileKind('file-archive', 'application/vnd.rar', 'binary'),

  // Document kinds are opened by their plugins; a raw file with one of these
  // extensions has no inline preview.
  blockpage: fileKind('blockpage', 'application/octet-stream', 'binary'),
  base: fileKind('database', 'application/octet-stream', 'binary'),
  ink: fileKind('ink', 'application/octet-stream', 'binary'),
  whiteboard: fileKind('canvas', 'application/octet-stream', 'binary'),
  notebook: fileKind('notebook', 'application/octet-stream', 'binary'),
};

const FALLBACK: FileKindInfo = fileKind(
  'file',
  'application/octet-stream',
  'binary',
);

/** Extension of a path's file name; empty for extensionless names and dotfiles. */
function extensionOf(path: string): string {
  const fileName = fileNameOf(path);
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** The file-name segment of a workspace path. */
export function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Icon, MIME type, and preview strategy for a workspace path. */
export function fileKindForPath(path: string): FileKindInfo {
  return FILE_KINDS[extensionOf(path)] ?? FALLBACK;
}

export function iconForPath(path: string): IconName {
  return fileKindForPath(path).icon;
}

export function mimeForPath(path: string): string {
  return fileKindForPath(path).mime;
}

export function previewKindForPath(path: string): PreviewKind {
  return fileKindForPath(path).preview;
}
