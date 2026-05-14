import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { Button } from '../primitives/Button'
import { Kbd } from '../primitives/Kbd'
import { cx } from '../primitives/cx'
import { Attachment } from './Attachment'
import styles from './ChatComposer.module.css'

export type ComposerMode = 'pure' | 'checkpointed' | 'destructive'

export interface ComposerAttachment {
  id: string
  kind: 'file' | 'image'
  name: string
  mime: string
  size: number
  /** Object URL for image preview. */
  src?: string
}

export interface ChatComposerProps {
  /** Agent display name; used in the placeholder. */
  agent: string
  defaultMode?: ComposerMode
  /** Submit handler; called with the composed message + cleared
   *  attachments. Implementation owns upload / API. */
  onSubmit: (args: { body: string; mode: ComposerMode; attachments: ComposerAttachment[] }) => void
  /** Disable while a submit is in flight. */
  disabled?: boolean
  className?: string
}

/**
 * Composer for one chat turn. Plus opens the file picker, the textarea
 * accepts paste of images, the mode segmented applies to the next
 * message only (resets to default after send).
 */
export function ChatComposer({
  agent,
  defaultMode = 'checkpointed',
  onSubmit,
  disabled = false,
  className,
}: ChatComposerProps): ReactNode {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<ComposerMode>(defaultMode)
  const [files, setFiles] = useState<ComposerAttachment[]>([])
  const fileInput = useRef<HTMLInputElement | null>(null)

  const onPick = (e: ChangeEvent<HTMLInputElement>): void => {
    const list = e.target.files
    if (!list) return
    const next: ComposerAttachment[] = []
    for (const f of Array.from(list)) {
      next.push({
        id: `pending-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
        kind: f.type.startsWith('image/') ? 'image' : 'file',
        name: f.name,
        mime: f.type || 'application/octet-stream',
        size: f.size,
        ...(f.type.startsWith('image/') ? { src: URL.createObjectURL(f) } : {}),
      })
    }
    setFiles((fs) => [...fs, ...next])
    e.target.value = ''
  }

  const remove = (id: string): void => {
    setFiles((fs) => fs.filter((f) => f.id !== id))
  }

  const submit = (): void => {
    if (disabled) return
    const body = text.trim()
    if (body.length === 0 && files.length === 0) return
    onSubmit({ body, mode, attachments: files })
    setText('')
    setFiles([])
    setMode(defaultMode)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter') return
    if (e.shiftKey) {
      // Shift+Enter inserts a newline ... fall through to default behavior.
      return
    }
    // Enter (and ⌘/Ctrl+Enter as an alias) submits.
    e.preventDefault()
    submit()
  }

  return (
    <div className={cx(styles.wrap, className)}>
      {files.length > 0 && (
        <div className={styles.tray}>
          {files.map((f) => (
            <Attachment
              key={f.id}
              kind={f.kind}
              name={f.name}
              size={f.size}
              {...(f.src !== undefined ? { src: f.src } : {})}
              onRemove={() => {
                remove(f.id)
              }}
            />
          ))}
        </div>
      )}

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
        }}
        onKeyDown={onKeyDown}
        placeholder={`Message ${agent}…  drop files or images, or use /command`}
        rows={3}
        className={styles.textarea}
        disabled={disabled}
      />

      <div className={styles.actions}>
        <button
          type="button"
          aria-label="Attach"
          className={styles.plus}
          onClick={() => fileInput.current?.click()}
          disabled={disabled}
        >
          +
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          onChange={onPick}
          className={styles.fileInput}
        />

        <div className={styles.modeWrap} role="radiogroup" aria-label="Send mode">
          {(['pure', 'checkpointed', 'destructive'] as ComposerMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={cx(styles.modeBtn, mode === m && styles.modeBtnActive)}
              onClick={() => {
                setMode(m)
              }}
              disabled={disabled}
            >
              {m}
            </button>
          ))}
        </div>

        <span className={styles.spacer} />
        <span className={styles.hint}>
          <Kbd>⏎</Kbd> to send · <Kbd>⇧</Kbd> <Kbd>⏎</Kbd> for newline
        </span>
        <Button variant="primary" size="md" onClick={submit} disabled={disabled}>
          Send
        </Button>
      </div>
    </div>
  )
}
