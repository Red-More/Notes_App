//! Resolve `asset:<id>` image references in rendered Markdown.
//!
//! Image bytes never live in the VFS; previews fetch them on demand and cache
//! the resulting data URL. A missing asset renders a visible placeholder
//! instead of a broken image or a crash.

import { assetApi } from './api'

const cache = new Map<number, string>()
const pending = new Map<number, Promise<string | null>>()

/** Numeric id from an `asset:<id>` source, or null for any other URL. */
export function assetIdFromSrc(src: string): number | null {
  const match = /^asset:(\d+)$/.exec(src.trim())
  return match ? Number(match[1]) : null
}

/** True when a Markdown body references an image asset. */
export function hasAssetRefs(markdown: string): boolean {
  return /asset:\d+/.test(markdown)
}

/** Base64 data URL for one asset, memoised; failures resolve to null. */
export function assetDataUrl(id: number): Promise<string | null> {
  const cached = cache.get(id)
  if (cached) return Promise.resolve(cached)
  const inflight = pending.get(id)
  if (inflight) return inflight

  const request = assetApi
    .data(id)
    .then((asset) => {
      const url = `data:${asset.mime};base64,${asset.data}`
      cache.set(id, url)
      return url
    })
    .catch(() => null)
    .finally(() => pending.delete(id))

  pending.set(id, request)
  return request
}

/**
 * Swap every `asset:` image under `root` for its data URL. Stale references
 * become a text placeholder so the surrounding paragraph stays readable.
 */
export function resolveAssetImages(root: HTMLElement): void {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src^="asset:"]'))
  for (const image of images) {
    const id = assetIdFromSrc(image.getAttribute('src') ?? '')
    if (id == null) continue
    void assetDataUrl(id).then((url) => {
      if (!image.isConnected) return
      if (url) {
        image.src = url
        image.classList.add('asset-image')
      } else {
        image.replaceWith(missingPlaceholder(id))
      }
    })
  }
}

function missingPlaceholder(id: number): HTMLElement {
  const span = document.createElement('span')
  span.className = 'asset-missing'
  span.setAttribute('role', 'img')
  span.title = `图片资产缺失：asset:${id}`
  span.textContent = '图片缺失'
  return span
}
