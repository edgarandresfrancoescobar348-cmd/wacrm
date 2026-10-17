// ============================================================
// What the inbox says about the account's WhatsApp numbers (phase 6).
//
// Each number has its own health (`whatsapp_connections.status`: the
// official number's credentials, a QR number's session). The notice
// looks only at the numbers the viewer sees — business ones and their own
// personal ones — and says what is down and what keeps working, like the
// owner's reference: "Os WhatsApps Web estão desconectados. O
// atendimento oficial continua."
// ============================================================

import type { ConnectionProvider, ConnectionScope } from './connections'

/** The slice of a number (PublicConnection) the notice and the chips need. */
export interface NumberState {
  id: string
  provider: ConnectionProvider
  scope: ConnectionScope
  status: 'connected' | 'disconnected'
  /** Does the viewer see its conversations? */
  visible: boolean
}

export type ConnectionNoticeKind =
  /** Every number is up (or still loading). */
  | null
  /** The viewer sees no number at all. */
  | 'not_configured'
  /** Every number the viewer sees is down. */
  | 'all_down'
  /** Only personal numbers are down: "O WhatsApp pessoal está desconectado. O atendimento da empresa continua." */
  | 'personal_down'
  /** Business QR numbers are down, the official one is up: "Os WhatsApps Web estão desconectados. O atendimento oficial continua." */
  | 'web_down_official_up'
  /** The official number is down, a QR number is up. */
  | 'official_down'
  /** Any other mix: the down numbers by name, "the others keep working". */
  | 'some_down'

export interface ConnectionNotice {
  kind: ConnectionNoticeKind
  /** The visible numbers that are down. */
  down: NumberState[]
}

/** `numbers` undefined = still loading. */
export function connectionNotice<T extends NumberState>(numbers: readonly T[] | undefined): ConnectionNotice & { down: T[] } {
  if (numbers === undefined) return { kind: null, down: [] }
  const mine = numbers.filter((n) => n.visible)
  if (!mine.length) return { kind: 'not_configured', down: [] }
  const down = mine.filter((n) => n.status !== 'connected')
  if (!down.length) return { kind: null, down }
  if (down.length === mine.length) return { kind: 'all_down', down }
  const up = mine.filter((n) => n.status === 'connected')
  if (down.every((n) => n.scope === 'personal')) return { kind: 'personal_down', down }
  const officialUp = up.some((n) => n.provider === 'meta')
  if (officialUp && down.every((n) => n.scope === 'business' && n.provider === 'openwa')) {
    return { kind: 'web_down_official_up', down }
  }
  if (down.every((n) => n.provider === 'meta')) return { kind: 'official_down', down }
  return { kind: 'some_down', down }
}

/** Is any number of this scope that the viewer sees down? (the chip's ⚠) */
export function scopeHasDown(numbers: readonly NumberState[] | undefined, scope: ConnectionScope): boolean {
  return (numbers ?? []).some((n) => n.visible && n.scope === scope && n.status !== 'connected')
}

/** How often the inbox re-reads the numbers while open. */
export const CONNECTION_POLL_MS = 15_000
