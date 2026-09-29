import { fileKindForPath, fileNameOf } from '../../file-kinds.js';
import { useRawFileBlob, type RawFileReader } from './shared.js';
import { ImagePreview } from './ImagePreview.jsx';
import { VideoPreview } from './VideoPreview.jsx';
import { AudioPreview } from './AudioPreview.jsx';
import { PdfPreview } from './PdfPreview.jsx';
import { TextPreview } from './TextPreview.jsx';
import { BinaryPreview } from './BinaryPreview.jsx';
import { Button } from '../Button.jsx';
import styles from './FilePreview.module.css';

/**
 * Preview surface for a raw (non-document) vault file. The kind comes from
 * the shared extension table; the blob is fetched lazily per activation.
 */
export function RawFilePreview(props: {
  path: string;
  reader: RawFileReader | null;
  canEmbedPdf?: boolean;
  onImportAsNotebook?: () => void;
}): React.ReactElement {
  const { path, reader } = props;
  const canEmbedPdf = props.canEmbedPdf ?? true;
  const load = useRawFileBlob(reader, path);
  const kind = fileKindForPath(path);
  const name = fileNameOf(path);

  // No in-preview title: the tab strip and the pane header already name the
  // file, so a third copy plus a size pill is pure chrome noise.
  let stage: React.ReactElement;
  if (load.status === 'ready' && load.blob !== null) {
    const blob = load.blob;
    switch (kind.preview) {
      case 'image':
        stage = <ImagePreview blob={blob} name={name} />;
        break;
      case 'video':
        stage = <VideoPreview blob={blob} />;
        break;
      case 'audio':
        stage = <AudioPreview blob={blob} />;
        break;
      case 'pdf':
        stage = (
          <PdfPreview
            blob={blob}
            name={name}
            canEmbedPdf={canEmbedPdf}
            onImportAsNotebook={props.onImportAsNotebook}
          />
        );
        break;
      case 'text':
        stage = <TextPreview blob={blob} />;
        break;
      default:
        stage = <BinaryPreview blob={blob} path={path} />;
        break;
    }
  } else {
    stage = <StateMessage load={load} onRetry={() => load.retry()} />;
  }

  return (
    <div className={styles['file-preview']} data-fl-component="file-preview">
      <div
        className={`${styles['file-preview-stage']} ${styles[`file-preview-${kind.preview}`]}`}
      >
        {stage}
      </div>
    </div>
  );
}

function StateMessage(props: {
  load: ReturnType<typeof useRawFileBlob>;
  onRetry: () => void;
}): React.ReactElement {
  const { load } = props;
  if (load.status === 'loading') {
    return (
      <span className={styles['file-preview-meta']}>Loading preview&hellip;</span>
    );
  }
  if (load.status === 'unavailable') {
    return (
      <span className={styles['file-preview-meta']}>
        Preview is unavailable because the file explorer plugin is not active.
      </span>
    );
  }
  if (load.status === 'missing') {
    return (
      <span className={styles['file-preview-meta']}>
        File not found. It may have been moved or deleted.
      </span>
    );
  }
  return (
    <>
      <span className={styles['file-preview-meta']}>
        Preview failed: {load.message ?? 'unknown error'}
      </span>
      <Button type="button" onClick={props.onRetry}>
        Retry
      </Button>
    </>
  );
}
