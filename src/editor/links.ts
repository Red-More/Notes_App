export interface LinkTarget {
  /** Address copied to the clipboard. */
  address: string
  /** In-page anchor (footnotes): keep default navigation, never copy. */
  internal: boolean
  /** Whether the system browser can open this address. */
  openable: boolean
}

const WEB_PROTOCOL = /^https?:/i
const SYSTEM_PROTOCOL = /^(mailto:|tel:)/i

/**
 * Classify a rendered link. `resolvedHref` is the browser-resolved absolute URL
 * (`anchor.href`), while `rawHref` preserves the authored address.
 */
export function classifyHref(
  rawHref: string,
  resolvedHref: string,
): LinkTarget | null {
  const raw = rawHref.trim()
  if (!raw) return null
  if (raw.startsWith('#')) {
    return { address: raw, internal: true, openable: false }
  }
  if (/^javascript:/i.test(raw)) return null
  if (WEB_PROTOCOL.test(raw)) {
    return {
      address: WEB_PROTOCOL.test(resolvedHref) ? resolvedHref : raw,
      internal: false,
      openable: true,
    }
  }
  if (raw.startsWith('//')) {
    return {
      address: WEB_PROTOCOL.test(resolvedHref) ? resolvedHref : `https:${raw}`,
      internal: false,
      openable: true,
    }
  }
  if (SYSTEM_PROTOCOL.test(raw)) {
    return { address: raw, internal: false, openable: true }
  }
  // Relative or other custom schemes: copy the authored address, but do not
  // hand it to the system browser.
  return { address: raw, internal: false, openable: false }
}
