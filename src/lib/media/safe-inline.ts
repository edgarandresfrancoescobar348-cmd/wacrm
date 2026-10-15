// ============================================================
// Response headers for media we proxy from a third party (the OpenWA
// gateway) on the app's own, authenticated origin.
//
// The bytes and their declared type come from a server a tenant admin
// chose, so neither can be trusted: an `text/html` or `image/svg+xml`
// "document" rendered inline would run script with a teammate's
// session. Only types the browser renders inertly (raster images, audio,
// video) are served inline under their real type; everything else is
// forced to a download as `application/octet-stream`. Every response
// also gets `nosniff` and a sandboxing CSP, so even a mislabelled body
// opened directly can't execute.
// ============================================================

const INERT_INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/3gpp',
  'video/quicktime',
  'video/webm',
])

/** Lower-cased MIME type without parameters, or null. */
function baseType(value: string | null | undefined): string | null {
  if (!value) return null
  const t = value.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : null
}

export function isInertInlineType(value: string | null | undefined): boolean {
  const t = baseType(value)
  return t !== null && INERT_INLINE_TYPES.has(t)
}

/** Headers for proxying untrusted media bytes. */
export function untrustedMediaHeaders(
  declaredType: string | null | undefined,
  fileName = 'attachment',
): Record<string, string> {
  const common = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=3600',
  }
  if (isInertInlineType(declaredType)) {
    return { ...common, 'Content-Type': baseType(declaredType)!, 'Content-Disposition': 'inline' }
  }
  const safeName = fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'attachment'
  return {
    ...common,
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${safeName}"`,
  }
}
