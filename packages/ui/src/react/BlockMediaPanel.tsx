import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './BlockMediaPanel.module.css';

type Rect = { x: number; y: number; width: number; height: number };

interface MediaControl {
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly disabled?: boolean;
}

const MEDIA_SELECTOR =
  'figure[data-flbp-image], figure[data-flbp-video], figure[data-flbp-audio], figure[data-flbp-file]';

function mediaAt(anchor: Rect): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>(MEDIA_SELECTOR)].find(
      (figure) => {
        const rect = figure.getBoundingClientRect();
        return (
          Math.abs(rect.x - anchor.x) < 3 &&
          Math.abs(rect.y - anchor.y) < 3 &&
          Math.abs(rect.width - anchor.width) < 3
        );
      },
    ) ?? null
  );
}

function mediaKind(figure: HTMLElement): string | null {
  for (const kind of ['image', 'video', 'audio', 'file'])
    if (figure.hasAttribute(`data-flbp-${kind}`)) return kind;
  return null;
}

/** Local/remote source and metadata presentation over semantic media tools. */
export function BlockMediaPanel(props: {
  readonly anchor: Rect;
  readonly controls: readonly MediaControl[];
  readonly onAction: (id: string, value?: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'local' | 'remote'>('local');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [alt, setAlt] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const control = (id: string): MediaControl | undefined =>
    props.controls.find((item) => item.id === id);
  const canRemote = control('media.remoteUrl') !== undefined;
  const start = (): void => {
    setRemoteUrl(control('media.remoteUrl')?.value ?? '');
    setCaption(control('media.caption')?.value ?? '');
    setAlt(control('media.alt')?.value ?? '');
    setName(control('media.name')?.value ?? '');
    setTab('local');
    setError('');
    setOpen(true);
  };
  useEffect(() => setOpen(false), [props.anchor.x, props.anchor.y]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [open]);
  const saveRemote = (): void => {
    const value = remoteUrl.trim();
    try {
      const url = new URL(value);
      if (
        !/^https:\/\//i.test(value) ||
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        value.length > 4096 ||
        value.includes('\\') ||
        [...value].some((character) => {
          const code = character.codePointAt(0);
          return code !== undefined && (code <= 32 || code === 127);
        })
      )
        throw new Error('invalid');
    } catch {
      setError('Enter a valid HTTPS URL without credentials.');
      return;
    }
    props.onAction('media.remoteUrl', value);
    setError('');
    setOpen(false);
  };
  const dropFile = (file: File): void => {
    const figure = mediaAt(props.anchor);
    const blockId = figure?.dataset.blockId;
    const kind = figure === null ? null : mediaKind(figure);
    if (figure === null || !blockId || kind === null) {
      setError('Select the media block again and retry.');
      return;
    }
    figure.dispatchEvent(
      new CustomEvent('flbp:media-picked', {
        detail: { blockId, kind, capture: false, files: [file] },
        bubbles: true,
      }),
    );
    setError('');
    setOpen(false);
  };
  const saveDetails = (): void => {
    if (
      name === (control('media.name')?.value ?? '') &&
      caption === (control('media.caption')?.value ?? '') &&
      alt === (control('media.alt')?.value ?? '')
    ) {
      setOpen(false);
      return;
    }
    const details = {
      ...(control('media.name') !== undefined ? { name } : {}),
      caption,
      alt,
    };
    props.onAction('media.details', JSON.stringify(details));
    setOpen(false);
  };
  return (
    <div
      className={styles.toolbar}
      data-anchor="float.selection"
      role="toolbar"
      aria-label="Media controls"
    >
      <button
        type="button"
        aria-label={control('media.replace')?.label ?? 'Replace media'}
        disabled={control('media.replace')?.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => props.onAction('media.replace')}
      >
        Replace
      </button>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => (open ? setOpen(false) : start())}
      >
        Details
      </button>
      {open
        ? createPortal(
            <>
              <button
                type="button"
                className={styles.scrim}
                aria-label="Close media panel"
                onClick={() => setOpen(false)}
              />
              <div
                className={styles.panel}
                role="dialog"
                aria-label="Media details"
                ref={panelRef}
                style={{
                  left: Math.max(
                    8,
                    Math.min(window.innerWidth - 330, props.anchor.x),
                  ),
                  top: Math.max(
                    8,
                    Math.min(window.innerHeight - 440, props.anchor.y + 38),
                  ),
                }}
              >
                <div className={styles.heading}>Media</div>
                <div
                  className={styles.tabs}
                  role="tablist"
                  aria-label="Media source"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'local'}
                    onClick={() => setTab('local')}
                  >
                    From device
                  </button>
                  {canRemote ? (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'remote'}
                      onClick={() => setTab('remote')}
                    >
                      Remote URL
                    </button>
                  ) : null}
                </div>
                {tab === 'local' ? (
                  <div
                    className={styles.dropzone}
                    data-flbp-media-dropzone=""
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const file = event.dataTransfer.files[0];
                      if (file !== undefined) dropFile(file);
                    }}
                  >
                    <span>Drop a file here</span>
                    <button
                      type="button"
                      onClick={() => props.onAction('media.replace')}
                    >
                      Choose file
                    </button>
                  </div>
                ) : (
                  <form
                    className={styles.remote}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveRemote();
                    }}
                  >
                    <label htmlFor="flbp-media-remote">HTTPS URL</label>
                    <input
                      id="flbp-media-remote"
                      type="url"
                      value={remoteUrl}
                      onChange={(event) =>
                        setRemoteUrl(event.currentTarget.value)
                      }
                      placeholder="https://…"
                    />
                    <button type="submit">Use remote URL</button>
                    <button
                      type="button"
                      onClick={() => props.onAction('media.replace')}
                    >
                      Choose local file instead
                    </button>
                  </form>
                )}
                <div className={styles.fields}>
                  {control('media.name') !== undefined ? (
                    <label>
                      Name
                      <input
                        value={name}
                        onChange={(event) => setName(event.currentTarget.value)}
                      />
                    </label>
                  ) : null}
                  <label>
                    Caption
                    <input
                      value={caption}
                      onChange={(event) =>
                        setCaption(event.currentTarget.value)
                      }
                    />
                  </label>
                  <label>
                    Alt text
                    <input
                      value={alt}
                      onChange={(event) => setAlt(event.currentTarget.value)}
                    />
                  </label>
                  <button type="button" onClick={saveDetails}>
                    Save details
                  </button>
                </div>
                {error ? (
                  <p className={styles.error} role="alert">
                    {error}
                  </p>
                ) : null}
                <button
                  className={styles.retry}
                  type="button"
                  onClick={() => props.onAction('media.retry')}
                >
                  Retry preview
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
