import { fileKindForPath, fileNameOf } from '../../file-kinds.js';
import { Button } from '../Button.jsx';
import styles from './FilePreview.module.css';
import { formatBytes, useObjectUrl } from './shared.js';

/**
 * Fallback for files with no inline preview: a working download plus the
 * metadata needed to decide what to do with the file.
 */
export function BinaryPreview(props: {
  blob: Blob;
  path: string;
}): React.ReactElement {
  const url = useObjectUrl(props.blob);
  const name = fileNameOf(props.path);
  const mime =
    props.blob.type !== '' ? props.blob.type : fileKindForPath(props.path).mime;
  return (
    <>
      {url !== null ? (
        <Button variant="primary" href={url} download={name}>
          Download
        </Button>
      ) : null}
      <span className={styles['file-preview-meta']}>
        {mime} · {formatBytes(props.blob.size)}
      </span>
    </>
  );
}
