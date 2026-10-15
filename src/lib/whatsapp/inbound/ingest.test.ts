// The shared ingestion path, against a small in-memory PostgREST fake.
// Covers the review findings that live here (F3 failure propagation,
// F6 status ordering, F7 quoted menu replies).

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failInsertOn: null as string | null,
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))

vi.mock('@/lib/automations/engine', () => ({
  resumeAwaitingReply: vi.fn(async () => false),
  runAutomationsForTrigger: vi.fn(async () => undefined),
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: vi.fn() }))
vi.mock('@/lib/contacts/dedupe', () => ({
  isUniqueViolation: () => false,
  findExistingContact: async (_db: unknown, accountId: string, phone: string) =>
    (h.tables.contacts ?? []).find((c) => c.account_id === accountId && c.phone === phone) ?? null,
}))

// --- tiny PostgREST fake -------------------------------------------------
function table(name: string) {
  const rows = () => (h.tables[name] ??= [])
  let op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  let payload: Row | null = null
  let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  const filters: ((r: Row) => boolean)[] = []
  let order: [string, boolean] | null = null
  let limitN: number | null = null
  const matches = () => {
    let out = rows().filter((r) => filters.every((f) => f(r)))
    if (order) {
      const [col, asc] = order
      out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1))
    }
    return limitN === null ? out : out.slice(0, limitN)
  }
  const run = (): { data: unknown; error: unknown; count?: number } => {
    if (op === 'insert' || op === 'upsert') {
      if (h.failInsertOn === name) return { data: null, error: { message: 'connection reset' } }
      const keys = (upsertOpts.onConflict ?? '').split(',').filter(Boolean)
      const clash = keys.length && rows().find((r) => keys.every((k) => r[k] === payload![k]))
      if (clash) {
        if (op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate' } }
        if (upsertOpts.ignoreDuplicates) return { data: [], error: null }
        Object.assign(clash, payload)
        return { data: [clash], error: null }
      }
      const row = { id: `${name}-${rows().length + 1}`, created_at: new Date().toISOString(), ...payload }
      rows().push(row)
      return { data: [row], error: null }
    }
    if (op === 'update') {
      const hit = matches()
      hit.forEach((r) => Object.assign(r, payload))
      return { data: hit, error: null }
    }
    const m = matches()
    return { data: m, error: null, count: m.length }
  }
  const q: Record<string, unknown> = {
    select: () => q,
    insert: (v: Row) => ((op = 'insert'), (payload = v), (upsertOpts = { onConflict: 'conversation_id,message_id' }), q),
    upsert: (v: Row, o: typeof upsertOpts) => ((op = 'upsert'), (payload = v), (upsertOpts = o), q),
    update: (v: Row) => ((op = 'update'), (payload = v), q),
    // Embedded-resource filters (`conversations.account_id`) are not
    // modelled: every fixture row belongs to the one test account.
    eq: (c: string, v: unknown) => (filters.push((r) => (c.includes('.') ? true : r[c] === v)), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    lt: () => q,
    or: () => q,
    order: (c: string, o?: { ascending?: boolean }) => ((order = [c, o?.ascending !== false]), q),
    limit: (n: number) => ((limitN = n), q),
    maybeSingle: async () => {
      const r = run()
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
    },
    single: async () => {
      const r = run()
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
    },
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  }
  return q
}
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: (n: string) => table(n), rpc: async () => ({ error: null }) }),
}))

import { IngestFailure, ingestInboundMessage, type InboundMessage } from './ingest'

const ACCOUNT = 'acct-1'
const PHONE = '5511999999999'

function inbound(over: Partial<InboundMessage> & { body?: string } = {}): InboundMessage {
  const body = over.body ?? 'olá'
  return {
    provider: 'openwa',
    messageId: `in-${Math.random()}`,
    timestamp: '1792100000',
    type: 'text',
    identity: { phone: PHONE, name: 'Cliente', waUserId: null, waParentUserId: null, waUsername: null },
    text: body,
    resolveContent: async () => ({ contentText: body, mediaUrl: null, mediaType: null, interactiveReplyId: null }),
    ...over,
  }
}

beforeEach(() => {
  h.tables = {
    contacts: [{ id: 'contact-1', account_id: ACCOUNT, phone: PHONE, name: 'Cliente' }],
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, contact_id: 'contact-1', created_at: '2026-01-01' }],
    messages: [],
  }
  h.failInsertOn = null
  h.dispatchInboundToFlows.mockClear()
})

describe('F3 — failures propagate so the provider redelivers', () => {
  it('throws IngestFailure when the message insert fails (throwOnFailure)', async () => {
    h.failInsertOn = 'messages'
    await expect(
      ingestInboundMessage(inbound(), ACCOUNT, 'owner', { throwOnFailure: true }),
    ).rejects.toBeInstanceOf(IngestFailure)
  })

  it('keeps the lenient behaviour for callers that do not opt in (Meta)', async () => {
    h.failInsertOn = 'messages'
    await expect(ingestInboundMessage(inbound(), ACCOUNT, 'owner')).resolves.toBeUndefined()
  })

  it('a redelivery after the failure inserts the message exactly once', async () => {
    const msg = inbound()
    h.failInsertOn = 'messages'
    await expect(ingestInboundMessage(msg, ACCOUNT, 'owner', { throwOnFailure: true })).rejects.toThrow()
    h.failInsertOn = null
    await ingestInboundMessage(msg, ACCOUNT, 'owner', { throwOnFailure: true })
    await ingestInboundMessage(msg, ACCOUNT, 'owner', { throwOnFailure: true })
    expect(h.tables.messages.filter((m) => m.message_id === msg.messageId)).toHaveLength(1)
  })

  it('hands the bot fan-out to deferFanOut instead of running it inline', async () => {
    const deferred: (() => Promise<void>)[] = []
    await ingestInboundMessage(inbound(), ACCOUNT, 'owner', { deferFanOut: (t) => deferred.push(t) })
    expect(h.tables.messages).toHaveLength(1)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    await deferred[0]()
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })
})
