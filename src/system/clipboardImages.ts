//! Picture extraction for paste in the note editor.
//!
//! Desktop browsers expose clipboard pictures as `clipboardData.files`. Mobile
//! WebViews often strip that list and leave only an HTML fragment whose <img>
//! carries a base64 data URL, and some IME clipboards hide the picture from the
//! page entirely — that last case falls back to the Android shell bridge.

/** `data:image/png;base64,...`; group 1 is the MIME type, group 2 the payload. */
const DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,([\w+/=\s]+)$/i

/** Name of the Android shell object injected by MainActivity. */
const NATIVE_BRIDGE_KEY = 'notesNative'

interface NativeBridge {
  /** Base64 data URL of the system clipboard picture, or null. */
  readClipboardImage?: () => string | null
}

function nativeBridge(): NativeBridge | null {
  // Absent in browsers, desktop and iOS builds, so the caller just gets null.
  return (window as unknown as Record<string, NativeBridge | undefined>)[NATIVE_BRIDGE_KEY] ?? null
}

/** Decode a base64 image data URL into a File; null for any other URL. */
export function fileFromDataUrl(url: string, name: string): File | null {
  const match = DATA_URL_RE.exec(url.trim())
  if (!match) return null
  try {
    const binary = atob(match[2].replace(/\s+/g, ''))
    if (binary.length === 0) return null
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new File([bytes], name, { type: match[1] })
  } catch {
    return null
  }
}

/** Data URLs referenced by an HTML fragment, or by a plain-text body. */
function imageUrlsIn(raw: string, html: boolean): string[] {
  if (!html) {
    const text = raw.trim()
    return DATA_URL_RE.test(text) ? [text] : []
  }
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  return Array.from(doc.querySelectorAll('img')).map((image) => image.getAttribute('src') ?? '')
}

/**
 * Pictures carried by a paste or drop transfer: real files first, then base64
 * images embedded in the HTML form some mobile WebViews deliver instead.
 */
export function imageFilesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const files = Array.from(data.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null)
  if (files.length > 0) return files

  // Independent sequence so embedded images are named clipboard-1, clipboard-2…
  // regardless of any real files collected above.
  let embeddedIndex = 0
  for (const type of ['text/html', 'text/plain']) {
    const raw = data.getData(type)
    if (!raw) continue
    for (const url of imageUrlsIn(raw, type === 'text/html')) {
      const file = fileFromDataUrl(url, `clipboard-${embeddedIndex + 1}.png`)
      if (file) {
        embeddedIndex += 1
        files.push(file)
      }
    }
    if (files.length > 0) break
  }
  return files
}

/**
 * True when the transfer also carries pasteable text. Such a paste must keep
 * its default behavior, so the native clipboard is never consulted for it.
 */
export function hasTextPayload(data: DataTransfer | null): boolean {
  if (!data) return false
  return Array.from(data.types).some((type) => type === 'text/plain' || type === 'text/html')
}

/**
 * Ask the Android shell for the system clipboard picture. Used when a paste
 * event reached the page without the image bytes (content:// clip data).
 */
export function clipboardImageFromNative(): File | null {
  const bridge = nativeBridge()
  if (!bridge?.readClipboardImage) return null
  try {
    const url = bridge.readClipboardImage()
    return url ? fileFromDataUrl(url, 'clipboard.png') : null
  } catch {
    return null
  }
}
