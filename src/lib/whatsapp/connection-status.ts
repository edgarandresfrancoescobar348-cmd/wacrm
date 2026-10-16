// ============================================================
// What the inbox says about the account's WhatsApp connection.
//
// `whatsapp_config.status` is the ACTIVE connection's health in both
// modes (Meta Cloud API, or QR code — derived from the OpenWA session by
// migration 058). The notice must name the mode that is active: a QR
// account is not "not connected to WhatsApp", its paired session is.
// ============================================================

export type WhatsAppProviderMode = 'meta' | 'openwa'

export interface WhatsAppStatusRow {
  provider?: string | null
  status?: string | null
}

export interface ConnectionNotice {
  /** null: connected (or still loading) — no notice. */
  kind: null | 'not_configured' | 'meta_disconnected' | 'qr_disconnected'
  provider: WhatsAppProviderMode | null
}

/** `row` undefined = still loading; null = no config row. */
export function connectionNotice(row: WhatsAppStatusRow | null | undefined): ConnectionNotice {
  if (row === undefined) return { kind: null, provider: null }
  if (row === null) return { kind: 'not_configured', provider: null }
  const provider: WhatsAppProviderMode = row.provider === 'openwa' ? 'openwa' : 'meta'
  if (row.status === 'connected') return { kind: null, provider }
  return { kind: provider === 'openwa' ? 'qr_disconnected' : 'meta_disconnected', provider }
}

/** How often the inbox re-reads the connection while open. */
export const CONNECTION_POLL_MS = 15_000
