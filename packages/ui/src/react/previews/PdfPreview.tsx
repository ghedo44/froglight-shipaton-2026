import { useObjectUrl } from './shared.js';
import { Button } from '../Button.jsx';
import styles from './FilePreview.module.css';

/**
 * PDF preview. Hosts whose webview cannot render PDFs in an iframe declare
 * `canEmbedPdf: false` and get a fallback card whose primary action hands
 * the file to the notebook import pipeline.
 */
export function PdfPreview(props: {
  blob: Blob;
  name: string;
  canEmbedPdf: boolean;
  onImportAsNotebook?: () => void;
}): React.ReactElement {
  const url = useObjectUrl(props.blob);
  if (props.canEmbedPdf) {
    if (url === null)
      return <div className={styles['file-preview-loading']} aria-hidden="true" />;
    return <iframe src={url} title={props.name} />;
  }
  return (
    <div className={styles['file-preview-fallback']}>
      <p>
        This host cannot display PDFs inline. Import it as a notebook to read
        and annotate it here.
      </p>
      {props.onImportAsNotebook !== undefined ? (
        <Button
          type="button"
          variant="primary"
          onClick={props.onImportAsNotebook}
        >
          Import as notebook
        </Button>
      ) : null}
    </div>
  );
}
