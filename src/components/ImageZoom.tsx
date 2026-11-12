import { useEffect } from 'react'
import type { ZoomImage } from '../system/imageZoom'
import { OverlayPortal } from './ui'
import { IconClose } from './Icons'

interface Props {
  image: ZoomImage
  onClose: () => void
}

/** Full-screen picture viewer opened by tapping an image in a note. */
export default function ImageZoom({ image, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <OverlayPortal>
      <div
        className="image-zoom-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={image.alt || '图片预览'}
        onClick={onClose}
      >
        <img
          className="image-zoom-image"
          src={image.src}
          alt={image.alt}
          onClick={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          className="image-zoom-close"
          onClick={onClose}
          aria-label="关闭图片"
        >
          <IconClose size={22} />
        </button>
      </div>
    </OverlayPortal>
  )
}
