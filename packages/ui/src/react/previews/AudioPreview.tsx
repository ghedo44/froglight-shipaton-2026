import { useObjectUrl } from './shared.js';
import styles from './FilePreview.module.css';

export function AudioPreview(props: { blob: Blob }): React.ReactElement {
  const url = useObjectUrl(props.blob);
  if (url === null) return <div className={styles['file-preview-loading']} aria-hidden="true" />;
  return <audio src={url} controls />;
}
