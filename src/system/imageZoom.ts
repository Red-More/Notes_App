//! Open a note picture in the editor page's full-screen viewer.
//!
//! Images live inside the Markdown preview HTML and CodeMirror widgets, which
//! are not part of the editor page's React tree. A window event keeps the
//! wiring to a single line at each call site.

export interface ZoomImage {
  src: string
  alt: string
}

const IMAGE_ZOOM_EVENT = 'notes-image-zoom'

/** Ask the note editor page to enlarge a picture. */
export function requestImageZoom(image: ZoomImage): void {
  window.dispatchEvent(new CustomEvent<ZoomImage>(IMAGE_ZOOM_EVENT, { detail: image }))
}

/** Subscribe to enlarge requests; returns the unsubscribe function. */
export function subscribeImageZoom(handler: (image: ZoomImage) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<ZoomImage>).detail)
  window.addEventListener(IMAGE_ZOOM_EVENT, listener)
  return () => window.removeEventListener(IMAGE_ZOOM_EVENT, listener)
}
