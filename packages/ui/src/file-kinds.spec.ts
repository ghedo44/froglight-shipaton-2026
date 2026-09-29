import { describe, it, expect } from 'vitest';
import {
  fileKindForPath,
  iconForPath,
  mimeForPath,
  previewKindForPath,
} from './file-kinds.js';

describe('fileKindForPath', () => {
  it('maps an image extension to image preview with image MIME and icon', () => {
    expect(fileKindForPath('vacation.png')).toEqual({
      icon: 'file-image',
      mime: 'image/png',
      preview: 'image',
    });
  });

  it('resolves the extension case-insensitively from a full path', () => {
    expect(fileKindForPath('assets/photos/photo.PNG').preview).toBe('image');
    expect(fileKindForPath('assets/photos/photo.PNG').mime).toBe('image/png');
  });

  it('demotes HEIC to the unrenderable fallback while keeping the image icon', () => {
    const kind = fileKindForPath('portrait.heic');
    expect(kind.icon).toBe('file-image');
    expect(kind.mime).toBe('image/heic');
    expect(kind.preview).toBe('binary');
  });

  it('maps video extensions to video preview', () => {
    expect(fileKindForPath('clip.mp4')).toEqual({
      icon: 'file-video',
      mime: 'video/mp4',
      preview: 'video',
    });
    expect(fileKindForPath('clip.webm').preview).toBe('video');
  });

  it('maps audio extensions to audio preview', () => {
    expect(fileKindForPath('song.flac')).toEqual({
      icon: 'file-audio',
      mime: 'audio/flac',
      preview: 'audio',
    });
  });

  it('maps PDF to the pdf preview kind', () => {
    expect(fileKindForPath('papers/report.pdf')).toEqual({
      icon: 'file-pdf',
      mime: 'application/pdf',
      preview: 'pdf',
    });
  });

  it('maps plain text and code extensions to text preview', () => {
    expect(fileKindForPath('notes.txt')).toEqual({
      icon: 'file-text',
      mime: 'text/plain',
      preview: 'text',
    });
    expect(fileKindForPath('src/app.ts').icon).toBe('file-code');
    expect(fileKindForPath('src/app.ts').preview).toBe('text');
    expect(fileKindForPath('data.json').preview).toBe('text');
  });

  it('keeps the note icon for markdown while previewing as text', () => {
    expect(fileKindForPath('readme.md')).toEqual({
      icon: 'markdown',
      mime: 'text/markdown',
      preview: 'text',
    });
  });

  it('uses the document icons for Block Page and Database files', () => {
    expect(iconForPath('plan.blockpage')).toBe('blockpage');
    expect(iconForPath('tasks.base')).toBe('database');
  });

  it('maps archives to the archive icon with no inline preview', () => {
    const kind = fileKindForPath('bundle.zip');
    expect(kind.icon).toBe('file-archive');
    expect(kind.preview).toBe('binary');
  });

  it('falls back to a generic binary file for unknown extensions', () => {
    expect(fileKindForPath('blob.zzz')).toEqual({
      icon: 'file',
      mime: 'application/octet-stream',
      preview: 'binary',
    });
  });

  it('falls back for files without an extension', () => {
    expect(fileKindForPath('Makefile').preview).toBe('binary');
    expect(fileKindForPath('Makefile').icon).toBe('file');
  });

  it('treats a leading dot as a dotfile, not an extension', () => {
    expect(fileKindForPath('.gitignore')).toEqual({
      icon: 'file',
      mime: 'application/octet-stream',
      preview: 'binary',
    });
  });
});

describe('convenience resolvers', () => {
  it('agree with the full kind record', () => {
    expect(iconForPath('papers/report.pdf')).toBe('file-pdf');
    expect(mimeForPath('clip.mp4')).toBe('video/mp4');
    expect(previewKindForPath('song.flac')).toBe('audio');
    expect(previewKindForPath('blob.zzz')).toBe('binary');
  });
});
