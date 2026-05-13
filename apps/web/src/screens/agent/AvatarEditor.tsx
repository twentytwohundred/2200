/**
 * Avatar editor (per-Agent · sits under the Identity tab).
 *
 * Three states, never two at once:
 *   1. No image, not cropping  →  drop zone + glyph fallback row
 *   2. Image uploaded          →  thumbnail + Replace / Remove + glyph row
 *   3. Cropping (just picked)  →  crop frame + zoom slider + Cancel / Save
 *
 * Image always wins over glyph; both off falls back to the deterministic
 * initial. Webp output is 256×256 at quality 0.82 → typically 30-50 KB
 * regardless of source size.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'
import Cropper, { type Area } from 'react-easy-crop'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type Agent } from '../../lib/api'
import { AgentMark, Button, Meta } from '../../primitives'
import { cx } from '../../primitives/cx'
import styles from './AvatarEditor.module.css'

const SUGGESTED_GLYPHS = [
  '🤖',
  '🧠',
  '⚡',
  '🎯',
  '🛠',
  '📚',
  '🔭',
  '🪐',
  '🎙',
  '🎨',
  '🧪',
  '🦊',
] as const

const TARGET_DIM = 256
const TARGET_QUALITY = 0.82

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export interface AvatarEditorProps {
  agentName: string
}

export function AvatarEditor({ agentName }: AvatarEditorProps): ReactElement {
  const queryClient = useQueryClient()

  const agentQuery = useQuery({
    queryKey: ['agents', agentName],
    queryFn: () => api.agent(agentName),
    enabled: agentName.length > 0,
    staleTime: 5_000,
  })

  const agent: Agent | undefined = agentQuery.data

  // Glyph editor state.
  const [glyphDraft, setGlyphDraft] = useState<string>('')
  useEffect(() => {
    setGlyphDraft(agent?.avatar ?? '')
  }, [agent?.avatar])

  // Image upload + crop state.
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  const onFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setError("That doesn't look like an image. Try a PNG or JPG.")
      return
    }
    setError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        setImageSrc(result)
        setCrop({ x: 0, y: 0 })
        setZoom(1)
        setCroppedAreaPixels(null)
      }
    }
    reader.readAsDataURL(file)
  }, [])

  const onPick = (): void => {
    fileInputRef.current?.click()
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setIsDragging(true)
  }

  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setIsDragging(false)
  }

  const saveGlyph = useMutation({
    mutationFn: (value: string) => api.agentAvatarSet(agentName, value),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
    },
  })

  const saveImage = useMutation({
    mutationFn: async () => {
      if (!imageSrc || !croppedAreaPixels) {
        throw new Error('No image cropped yet.')
      }
      const blob = await cropAndCompress(imageSrc, croppedAreaPixels, TARGET_DIM, TARGET_QUALITY)
      const data_base64 = await blobToBase64(blob)
      return api.agentAvatarImageSet(agentName, { data_base64, mime: 'image/webp' })
    },
    onSuccess: () => {
      setImageSrc(null)
      setCroppedAreaPixels(null)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
    },
  })

  const deleteImage = useMutation({
    mutationFn: () => api.agentAvatarImageDelete(agentName),
    onSuccess: () => {
      setConfirmRemove(false)
      if (confirmTimer.current) {
        clearTimeout(confirmTimer.current)
        confirmTimer.current = null
      }
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
      void queryClient.invalidateQueries({ queryKey: ['agents', agentName] })
    },
  })

  const armRemove = (): void => {
    setConfirmRemove(true)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => {
      setConfirmRemove(false)
    }, 3000)
  }

  const glyphTrimmed = glyphDraft.trim().slice(0, 8)
  const glyphDirty = glyphTrimmed !== (agent?.avatar ?? '')
  const hasImage = (agent?.avatar_image_url ?? null) !== null
  const isCropping = imageSrc !== null

  return (
    <div className={styles.editor}>
      <div className={styles.section}>
        <Meta>portrait image</Meta>

        {isCropping && imageSrc ? (
          <div className={styles.cropArea}>
            <div className={styles.cropFrame}>
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            </div>
            <div className={styles.cropControls}>
              <label className={styles.zoomLabel}>
                <Meta>zoom</Meta>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => {
                    setZoom(Number(e.target.value))
                  }}
                  className={styles.zoomRange}
                />
              </label>
              <span className={styles.spacer} />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setImageSrc(null)
                  setCroppedAreaPixels(null)
                }}
                disabled={saveImage.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  saveImage.mutate()
                }}
                disabled={!croppedAreaPixels || saveImage.isPending}
              >
                {saveImage.isPending ? 'Compressing…' : 'Save image'}
              </Button>
            </div>
          </div>
        ) : hasImage ? (
          <div className={styles.imageRow}>
            <AgentMark
              id={agentName}
              name={agentName}
              size="xl"
              imageUrl={api.authedUrl(agent?.avatar_image_url) ?? undefined}
            />
            <span className={styles.spacer} />
            <Button size="sm" variant="ghost" onClick={onPick}>
              Replace
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (confirmRemove) {
                  deleteImage.mutate()
                } else {
                  armRemove()
                }
              }}
              disabled={deleteImage.isPending}
              onMouseLeave={
                confirmRemove
                  ? () => {
                      setConfirmRemove(false)
                      if (confirmTimer.current) {
                        clearTimeout(confirmTimer.current)
                        confirmTimer.current = null
                      }
                    }
                  : undefined
              }
            >
              {deleteImage.isPending ? 'Removing…' : confirmRemove ? 'Click to confirm' : 'Remove'}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className={styles.fileInput}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onFile(file)
                e.target.value = ''
              }}
            />
          </div>
        ) : (
          <div
            className={cx(styles.dropZone, isDragging && styles.dropZoneActive)}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={onPick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPick()
              }
            }}
          >
            <div className={styles.dropPrompt}>
              <span className={styles.dropGlyph}>＋</span>
              <span className={styles.dropTitle}>Drop an image or click to pick a file</span>
              <span className={styles.dropHint}>
                PNG, JPG, or WebP. Compressed to 256×256 WebP on save.
              </span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className={styles.fileInput}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onFile(file)
                e.target.value = ''
              }}
            />
          </div>
        )}

        {(saveImage.isError || error) && (
          <p className={styles.error}>{error ?? formatError(saveImage.error)}</p>
        )}
      </div>

      <div className={styles.section}>
        <Meta>glyph fallback {hasImage ? '(only shown if portrait is removed)' : ''}</Meta>
        <div className={styles.glyphRow}>
          <input
            className={styles.glyphInput}
            value={glyphDraft}
            onChange={(e) => {
              setGlyphDraft(e.target.value.slice(0, 8))
            }}
            placeholder="🤖"
            spellCheck={false}
          />
          <div className={styles.suggestions}>
            {SUGGESTED_GLYPHS.map((g) => (
              <button
                key={g}
                type="button"
                className={styles.swatch}
                onClick={() => {
                  setGlyphDraft(g)
                }}
                title={`Use ${g}`}
              >
                {g}
              </button>
            ))}
          </div>
          <span className={styles.spacer} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setGlyphDraft('')
            }}
            disabled={glyphDraft.length === 0 || saveGlyph.isPending}
          >
            Clear
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              saveGlyph.mutate(glyphTrimmed)
            }}
            disabled={!glyphDirty || saveGlyph.isPending}
          >
            {saveGlyph.isPending ? 'Saving…' : 'Save glyph'}
          </Button>
        </div>
        {saveGlyph.isError && <p className={styles.error}>{formatError(saveGlyph.error)}</p>}
      </div>
    </div>
  )
}

async function cropAndCompress(
  imageSrc: string,
  area: Area,
  targetDim: number,
  quality: number,
): Promise<Blob> {
  const image = await loadImage(imageSrc)
  const canvas = document.createElement('canvas')
  canvas.width = targetDim
  canvas.height = targetDim
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unsupported')
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, targetDim, targetDim)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('toBlob returned null; the browser may not support webp encoding'))
      },
      'image/webp',
      quality,
    )
  })
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = (): void => {
      resolve(img)
    }
    img.onerror = (): void => {
      reject(new Error('image load failed'))
    }
    img.src = src
  })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}
