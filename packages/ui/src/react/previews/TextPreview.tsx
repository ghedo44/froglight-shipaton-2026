import { useEffect, useState } from 'react';
import { Button } from '../Button.jsx';
import styles from './FilePreview.module.css';

const MAX_PREVIEW_CHARS = 200_000;

/** Decode blob text on mount; large files are truncated with a notice. */
function useRawText(blob: Blob): { text: string; truncated: boolean } | null {
  const [result, setResult] = useState<{
    text: string;
    truncated: boolean;
  } | null>(null);
  useEffect(() => {
    let live = true;
    void blob.text().then((full) => {
      if (!live) return;
      if (full.length > MAX_PREVIEW_CHARS) {
        setResult({
          text: full.slice(0, MAX_PREVIEW_CHARS),
          truncated: true,
        });
      } else {
        setResult({ text: full, truncated: false });
      }
    });
    return () => {
      live = false;
    };
  }, [blob]);
  return result;
}

export function TextPreview(props: { blob: Blob }): React.ReactElement {
  const decoded = useRawText(props.blob);
  const [wrap, setWrap] = useState(true);
  if (decoded === null)
    return (
      <div className={styles['file-preview-loading']} aria-hidden="true" />
    );
  return (
    <>
      <div className={styles['file-preview-controls']}>
        <Button type="button" onClick={() => setWrap((value) => !value)}>
          {wrap ? 'Don\u2019t wrap' : 'Wrap'}
        </Button>
        {decoded.truncated ? (
          <span className={styles['file-preview-meta']}>
            Truncated at 200,000 characters
          </span>
        ) : null}
      </div>
      <pre className={wrap ? undefined : styles['no-wrap']}>{decoded.text}</pre>
    </>
  );
}
