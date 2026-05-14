import type { ReactNode } from 'react'
import { cx } from '../primitives/cx'
import styles from './Attachment.module.css'

export type AttachmentDisplayKind = 'file' | 'image'

export interface AttachmentProps {
  kind: AttachmentDisplayKind
  name: string
  size?: string | number
  /** Image src for `image` kind. */
  src?: string
  onRemove?: () => void
  className?: string
}

/**
 * Attachment chip used in chat messages and the composer tray.
 * Image attachments render as a 76px thumb; files render as a chip
 * with a type-badge derived from the filename extension.
 */
export function Attachment({
  kind,
  name,
  size,
  src,
  onRemove,
  className,
}: AttachmentProps): ReactNode {
  if (kind === 'image') {
    return (
      <div className={cx(styles.image, className)}>
        {src !== undefined ? (
          <img src={src} alt={name} className={styles.imageImg} />
        ) : (
          <div className={styles.imagePlaceholder} aria-label={name}>
            {name}
          </div>
        )}
        {onRemove && <RemoveButton onClick={onRemove} />}
      </div>
    )
  }
  const badge = inferFileBadge(name)
  return (
    <div className={cx(styles.file, className)}>
      <span className={styles.fileBadge} aria-hidden="true">
        {badge}
      </span>
      <span className={styles.fileBody}>
        <span className={styles.fileName} title={name}>
          {name}
        </span>
        {size !== undefined && <span className={styles.fileSize}>{formatSize(size)}</span>}
      </span>
      {onRemove && <RemoveButton onClick={onRemove} inline />}
    </div>
  )
}

function RemoveButton({ onClick, inline }: { onClick: () => void; inline?: boolean }): ReactNode {
  return (
    <button
      type="button"
      aria-label="Remove"
      onClick={onClick}
      className={cx(styles.remove, inline === true && styles.removeInline)}
    >
      ×
    </button>
  )
}

function inferFileBadge(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const known = ['pdf', 'md', 'txt', 'json', 'log', 'csv', 'py', 'js', 'ts', 'tsx', 'css', 'html']
  return known.includes(ext) ? ext : 'file'
}

function formatSize(size: string | number): string {
  if (typeof size === 'string') return size
  const b = size
  if (b < 1024) return `${String(b)} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}
