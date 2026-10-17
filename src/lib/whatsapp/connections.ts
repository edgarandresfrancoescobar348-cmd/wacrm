// ============================================================
// The account's WhatsApp numbers (`whatsapp_connections`, phase 6).
//
// An account has at most one official number (Meta Cloud API) and any
// number of numbers paired by QR code (OpenWA). Each is
//
//   business  the team's ("Empresa"): everyone in the account sees its
//             conversations; bots, automations, flows, AI and broadcasts
//             run on it;
//   personal  one member's ("Pessoal"): only its owner sees its
//             conversations (enforced by RLS, migration 073) and nothing
//             automated ever runs on it.
//
// A reply always goes out from the conversation's own number. Anything
// the business starts (a template from the contact page, a broadcast, an
// automation, a flow, the public API) goes out from a business number:
// the one named, else the account's default — the official number when
// there is one, else the oldest business QR number.
//
// Service role only: the table has no client policies. What a browser
// sees comes through /api/whatsapp/connections (toPublicConnection).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

export type ConnectionProvider = 'meta' | 'openwa'
export type ConnectionScope = 'personal' | 'business'

export interface WhatsAppConnectionRow {
  id: string
  account_id: string
  provider: ConnectionProvider
  scope: ConnectionScope
  owner_user_id: string | null
  label: string | null
  status: 'connected' | 'disconnected'
  phone: string | null
  connected_at: string | null
  mirror_inbound_media: boolean
  created_by: string | null
  removed_at: string | null
  created_at: string
}

export interface WaConnection {
  id: string
  accountId: string
  provider: ConnectionProvider
  scope: ConnectionScope
  /** The member a personal number belongs to. */
  ownerUserId: string | null
  label: string | null
  status: 'connected' | 'disconnected'
  phone: string | null
  connectedAt: string | null
  mirrorInboundMedia: boolean
  createdBy: string | null
  removedAt: string | null
  createdAt: string
}

export const CONNECTION_COLUMNS =
  'id, account_id, provider, scope, owner_user_id, label, status, phone, connected_at, mirror_inbound_media, created_by, removed_at, created_at'

export function toConnection(row: WhatsAppConnectionRow): WaConnection {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    label: row.label,
    status: row.status === 'connected' ? 'connected' : 'disconnected',
    phone: row.phone,
    connectedAt: row.connected_at,
    mirrorInboundMedia: row.mirror_inbound_media !== false,
    createdBy: row.created_by,
    removedAt: row.removed_at,
    createdAt: row.created_at,
  }
}

export const isBusiness = (c: Pick<WaConnection, 'scope'>) => c.scope === 'business'
export const isPersonal = (c: Pick<WaConnection, 'scope'>) => c.scope === 'personal'

/** Can `userId` see this number's conversations? (073's rule, for server code on the service role.) */
export function canSeeConnection(c: Pick<WaConnection, 'scope' | 'ownerUserId'>, userId: string): boolean {
  return c.scope === 'business' || c.ownerUserId === userId
}

/** No business number to send from (none, or the one named isn't one). */
export class NoBusinessConnectionError extends Error {
  constructor(message = 'No business WhatsApp number connected') {
    super(message)
    this.name = 'NoBusinessConnectionError'
  }
}

export async function loadConnection(admin: SupabaseClient, id: string): Promise<WaConnection | null> {
  const { data, error } = await admin.from('whatsapp_connections').select(CONNECTION_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw new Error(`WhatsApp number lookup failed: ${error.message}`)
  return data ? toConnection(data as WhatsAppConnectionRow) : null
}

/** The account's numbers, oldest first (removed ones only when asked). */
export async function loadAccountConnections(
  admin: SupabaseClient,
  accountId: string,
  opts: { includeRemoved?: boolean } = {},
): Promise<WaConnection[]> {
  let q = admin.from('whatsapp_connections').select(CONNECTION_COLUMNS).eq('account_id', accountId)
  if (!opts.includeRemoved) q = q.is('removed_at', null)
  const { data, error } = await q.order('created_at', { ascending: true })
  if (error) throw new Error(`WhatsApp numbers lookup failed: ${error.message}`)
  return ((data ?? []) as WhatsAppConnectionRow[]).map(toConnection)
}

/** The account's default business number: the official one, else the oldest business QR number. */
export function defaultBusinessConnection(connections: WaConnection[]): WaConnection | null {
  const business = connections.filter((c) => c.scope === 'business' && !c.removedAt)
  return business.find((c) => c.provider === 'meta') ?? business[0] ?? null
}

/**
 * The business number something the business starts goes out from:
 * `hint` when given (it must be one of the account's live business
 * numbers), else the default. Throws NoBusinessConnectionError.
 */
export async function pickBusinessConnection(
  admin: SupabaseClient,
  accountId: string,
  hint?: string | null,
): Promise<WaConnection> {
  const all = await loadAccountConnections(admin, accountId)
  if (hint) {
    const named = all.find((c) => c.id === hint)
    if (!named || named.scope !== 'business') {
      throw new NoBusinessConnectionError('That WhatsApp number is not one of the business numbers of this account')
    }
    return named
  }
  const fallback = defaultBusinessConnection(all)
  if (!fallback) throw new NoBusinessConnectionError()
  return fallback
}

/**
 * The user rows created for this number are attributed to (the NOT NULL
 * `user_id` audit column of contacts / conversations): a personal
 * number's owner, else who added the number, else the account's owner.
 */
export async function connectionActorId(admin: SupabaseClient, c: WaConnection): Promise<string> {
  if (c.ownerUserId) return c.ownerUserId
  if (c.createdBy) return c.createdBy
  const { data } = await admin
    .from('profiles')
    .select('user_id, account_role')
    .eq('account_id', c.accountId)
    .order('created_at', { ascending: true })
  const rows = (data ?? []) as { user_id: string; account_role: string }[]
  const owner = rows.find((r) => r.account_role === 'owner') ?? rows[0]
  if (!owner) throw new Error('The account has no members')
  return owner.user_id
}

/** The number a delivery came in on, as ingestion needs it. */
export interface IngestConnection {
  /** whatsapp_connections.id */
  id: string
  accountId: string
  scope: ConnectionScope
  /** The NOT NULL `user_id` audit column of the rows created for it (connectionActorId). */
  userId: string
}

export async function ingestConnectionFor(admin: SupabaseClient, c: WaConnection): Promise<IngestConnection> {
  return { id: c.id, accountId: c.accountId, scope: c.scope, userId: await connectionActorId(admin, c) }
}

/** What the browser may see of a number. A personal number's phone only to its owner. */
export interface PublicConnection {
  id: string
  provider: ConnectionProvider
  scope: ConnectionScope
  owner_user_id: string | null
  /** The owner's name, for "Pessoal · Ana" in Settings. */
  owner_name: string | null
  label: string | null
  status: 'connected' | 'disconnected'
  phone: string | null
  connected_at: string | null
  mirror_inbound_media: boolean
  /** Is it the account's default business number? */
  is_default: boolean
  /** Does the viewer see its conversations (business, or their own)? */
  visible: boolean
  /** Can the viewer manage it (connect, disconnect, remove)? */
  manageable: boolean
  /** Removed: out of the lists, its conversations stay as history. */
  removed_at: string | null
}

export function toPublicConnection(
  c: WaConnection,
  viewer: { userId: string; isAdmin: boolean },
  extra: { ownerName?: string | null; defaultId?: string | null } = {},
): PublicConnection {
  const mine = c.ownerUserId === viewer.userId
  const visible = c.scope === 'business' || mine
  return {
    id: c.id,
    provider: c.provider,
    scope: c.scope,
    owner_user_id: c.ownerUserId,
    owner_name: extra.ownerName ?? null,
    label: c.label,
    status: c.status,
    phone: visible ? c.phone : null,
    connected_at: c.connectedAt,
    mirror_inbound_media: c.mirrorInboundMedia,
    is_default: extra.defaultId === c.id,
    visible,
    // A personal number: its owner — and an admin may disconnect or
    // remove it (a member leaving) without ever seeing its chats.
    manageable: c.scope === 'business' ? viewer.isAdmin : mine || viewer.isAdmin,
    removed_at: c.removedAt,
  }
}

/**
 * The account's business numbers, removed ones included (their history
 * stays the team's) — what the public API and other account-level
 * readers on the service role may show. A personal number's
 * conversations are never in it.
 */
export async function businessConnectionIds(admin: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('whatsapp_connections')
    .select('id')
    .eq('account_id', accountId)
    .eq('scope', 'business')
  if (error) throw new Error(`WhatsApp numbers lookup failed: ${error.message}`)
  return ((data ?? []) as { id: string }[]).map((r) => r.id)
}

/** A UUID no row has: `.in(col, [NONE])` matches nothing (an empty `in` is not valid PostgREST). */
export const NO_CONNECTION = '00000000-0000-0000-0000-000000000000'

/**
 * Does the account have its official number set up (Meta credentials)?
 * Templates are submitted to Meta only then; without it they are local
 * (sent as text from QR numbers). `db` may be the member's own client.
 */
export async function hasOfficialNumber(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data, error } = await db.from('whatsapp_config').select('id').eq('account_id', accountId).maybeSingle()
  if (error) throw new Error(`WhatsApp config lookup failed: ${error.message}`)
  return Boolean(data)
}
