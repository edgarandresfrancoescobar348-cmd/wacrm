// The shared ingestion path, against a small in-memory PostgREST fake.
// Covers the review findings that live here (F3 failure propagation,
// F6 status ordering, F7 quoted menu replies).

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  loseCompletionAnswer: false,
  completionFails: 0,
  dispatchWebhookEvent: vi.fn(async () => ({ effect: 'ok', failedEndpointIds: [], deliveryId: 'd-1', occurredAt: '2026-10-16T00:00:00Z' })),
  tables: {} as Record<string, Row[]>,
  failInsertOn: null as string | null,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
  bumps: 0,
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}))

vi.mock('@/lib/automations/engine', () => ({
  resumeAwaitingReply: vi.fn(async () => false),
  resumeAwaitingReplyOutcome: vi.fn(async () => ({ consumed: false, effect: 'noop' })),
  runAutomationsForTrigger: vi.fn(async () => 'noop'),
}))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: h.dispatchInboundToFlows }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatchWebhookEvent }))
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
    // The unique index each insert can hit (migrations 037, 072, 022).
    insert: (v: Row) => (
      (op = 'insert'),
      (payload = v),
      (upsertOpts = {
        onConflict:
          name === 'messages' ? 'conversation_id,message_id' : name === 'conversations' ? 'connection_id,contact_id' : name === 'contacts' ? 'account_id,phone' : '',
      }),
      q
    ),
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
  supabaseAdmin: () => ({
    from: (n: string) => table(n),
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      if (h.rpcError) return { data: null, error: h.rpcError }
      // Migration 057's completion (over 053): mark + bump only if not
      // complete yet, and enqueue the fan-out task in the same step.
      if (name === 'complete_inbound_message' && args.p_message_id && h.completionFails) {
        h.completionFails--
        return { data: null, error: { message: 'connection reset' } }
      }
      if (name === 'complete_inbound_message' && args.p_message_id) {
        const msg = (h.tables.messages ?? []).find((m) => m.id === args.p_message_id)
        if (!msg || msg.ingest_completed_at) return { data: false, error: null }
        msg.ingest_completed_at = new Date().toISOString()
        h.bumps += 1
        const tasks = (h.tables.inbound_fanout_tasks ??= [])
        if (!tasks.some((t) => t.message_id === args.p_message_id)) {
          tasks.push({ id: `task-${tasks.length + 1}`, message_id: args.p_message_id, payload: args.p_fanout,
            status: 'pending', attempts: 0, progress: {} })
        }
        // The transaction committed, but its answer is lost (K5).
        if (h.loseCompletionAnswer) {
          h.loseCompletionAnswer = false
          return { data: null, error: { message: 'socket hang up' } }
        }
        return { data: true, error: null }
      }
      if (name === 'claim_inbound_fanout') {
        const task = (h.tables.inbound_fanout_tasks ?? []).find(
          (t) => t.message_id === args.p_message_id && (t.status === 'pending' || t.status === 'failed'),
        )
        if (!task) return { data: [], error: null }
        task.status = 'running'
        task.attempts = Number(task.attempts) + 1
        return { data: [{ ...task }], error: null }
      }
      return { data: null, error: null }
    },
  }),
}))

import {
  applyStatusUpdate,
  IngestFailure,
  ingestInboundMessage,
  recordOutboundEcho,
  type InboundMessage,
} from './ingest'
import { persistOutboundMessage } from '@/lib/whatsapp/outbound-persist'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const ACCOUNT = 'acct-1'
const PHONE = '5511999999999'
/** The number deliveries come in on (phase 6): the account's business QR number. */
const NUMBER = { id: 'num-1', accountId: ACCOUNT, scope: 'business' as const, userId: 'owner' }

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
    conversations: [{ id: 'conv-1', account_id: ACCOUNT, connection_id: 'num-1', contact_id: 'contact-1', created_at: '2026-01-01' }],
    messages: [],
  }
  h.failInsertOn = null
  h.rpcCalls = []
  h.loseCompletionAnswer = false
  h.completionFails = 0
  h.rpcError = null
  h.bumps = 0
  h.dispatchInboundToFlows.mockClear()
})

describe('F3 — failures propagate so the provider redelivers', () => {
  it('throws IngestFailure when the message insert fails (throwOnFailure)', async () => {
    h.failInsertOn = 'messages'
    await expect(
      ingestInboundMessage(inbound(), NUMBER, { throwOnFailure: true }),
    ).rejects.toBeInstanceOf(IngestFailure)
  })

  it('keeps the lenient behaviour for callers that do not opt in (Meta)', async () => {
    h.failInsertOn = 'messages'
    await expect(ingestInboundMessage(inbound(), NUMBER)).resolves.toBeUndefined()
  })

  it('a redelivery after the failure inserts the message exactly once', async () => {
    const msg = inbound()
    h.failInsertOn = 'messages'
    await expect(ingestInboundMessage(msg, NUMBER, { throwOnFailure: true })).rejects.toThrow()
    h.failInsertOn = null
    await ingestInboundMessage(msg, NUMBER, { throwOnFailure: true })
    await ingestInboundMessage(msg, NUMBER, { throwOnFailure: true })
    expect(h.tables.messages.filter((m) => m.message_id === msg.messageId)).toHaveLength(1)
  })

  it('hands the bot fan-out to deferFanOut instead of running it inline', async () => {
    const deferred: (() => Promise<void>)[] = []
    await ingestInboundMessage(inbound(), NUMBER, { deferFanOut: (t) => deferred.push(t) })
    expect(h.tables.messages).toHaveLength(1)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    await deferred[0]()
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })
})

// F5 (review): the provider's echo of our own send (message.sent) and the
// sender's persistence race for the same (conversation_id, message_id).
describe('F5 — echo vs sender reconcile, the sender never fails', () => {
  const MENU = { kind: 'buttons', body: 'Escolha', buttons: [{ id: 'a', title: 'A' }] }
  const sender = {
    conversation_id: 'conv-1',
    message_id: 'true_5511999999999@c.us_X1',
    sender_type: 'bot' as const,
    content_type: 'interactive',
    content_text: 'Escolha',
    interactive_payload: MENU,
    status: 'sent',
    ai_generated: false,
  }
  const echo = () =>
    recordOutboundEcho(
      {
        provider: 'openwa',
        messageId: sender.message_id,
        timestamp: '1792100000',
        type: 'text',
        identity: { phone: PHONE, name: '', waUserId: null, waParentUserId: null, waUsername: null },
        text: 'Escolha\n\n1. A',
        resolveContent: async () => ({ contentText: 'Escolha\n\n1. A', mediaUrl: null, mediaType: null, interactiveReplyId: null }),
      },
      NUMBER,
      { throwOnFailure: true },
    )

  it('the race is real: a plain insert after the echo hits the unique index', async () => {
    await echo()
    const { error } = await supabaseAdmin().from('messages').insert(sender).select().single()
    expect(error).toMatchObject({ code: '23505' })
  })

  it('echo first, then the sender: one row carrying the sender metadata', async () => {
    expect(await echo()).toBe('recorded')
    // an ack already moved it on
    h.tables.messages[0].status = 'read'
    await expect(persistOutboundMessage(supabaseAdmin(), sender)).resolves.toBeTruthy()
    const rows = h.tables.messages.filter((m) => m.message_id === sender.message_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sender_type: 'bot', content_type: 'interactive', interactive_payload: MENU })
    expect(rows[0].status).toBe('read')
  })

  it('sender first, then the echo: the echo is a no-op', async () => {
    await persistOutboundMessage(supabaseAdmin(), sender)
    expect(await echo()).toBe('duplicate')
    const rows = h.tables.messages.filter((m) => m.message_id === sender.message_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sender_type: 'bot', content_type: 'interactive' })
  })
})

// F6 / G2–G4: receipts go through ONE atomic SQL operation
// (apply_message_receipt, migration 052). Its ladder, retention and
// concurrency behaviour are tested on a real PostgreSQL in
// sql/receipts.pg.test.ts; here, the app hands it the right receipt.
describe('F6/G2–G4 — receipts are applied by apply_message_receipt', () => {
  it.each([
    ['openwa (account scope)', { accountId: ACCOUNT }, ACCOUNT],
    ['meta (global)', {}, null],
  ])('%s', async (_name, scope, account) => {
    await applyStatusUpdate({ id: 'wamid.A', status: 'read', timestamp: '1792100000' }, scope)
    expect(h.rpcCalls).toContainEqual({
      name: 'apply_message_receipt',
      args: {
        p_account: account,
        p_provider_message_id: 'wamid.A',
        p_status: 'read',
        p_failure: null,
        p_status_at: new Date(1792100000 * 1000).toISOString(),
      },
    })
  })

  it('propagates a database failure when asked to (redelivery)', async () => {
    h.rpcError = { message: 'connection reset' }
    await expect(
      applyStatusUpdate({ id: 'x', status: 'read', timestamp: '1792100000' }, { accountId: ACCOUNT, throwOnFailure: true }),
    ).rejects.toBeInstanceOf(IngestFailure)
  })
})

// F7 (review): a swipe-reply to menu A must be mapped against menu A,
// even when a later menu B is the conversation's latest prompt.
describe('F7 — a quoted reply maps only against the quoted menu', () => {
  const menuA = { kind: 'buttons', body: 'A', buttons: [{ id: 'A_buy', title: 'Comprar' }] }
  const menuB = { kind: 'buttons', body: 'B', buttons: [{ id: 'B_cancel', title: 'Cancelar' }] }
  beforeEach(() => {
    h.tables.messages.push(
      { id: 'menu-a', conversation_id: 'conv-1', message_id: 'prov-menu-A', sender_type: 'bot', content_type: 'interactive', interactive_payload: menuA, created_at: '2026-10-15T10:00:00Z' },
      { id: 'menu-b', conversation_id: 'conv-1', message_id: 'prov-menu-B', sender_type: 'bot', content_type: 'interactive', interactive_payload: menuB, created_at: '2026-10-15T10:05:00Z' },
      { id: 'plain', conversation_id: 'conv-1', message_id: 'prov-plain', sender_type: 'agent', content_type: 'text', content_text: 'oi', created_at: '2026-10-15T10:06:00Z' },
    )
  })
  const inserted = (id: string) => h.tables.messages.find((m) => m.message_id === id)!

  it('quote of menu A + "1" → A_buy (not B_cancel)', async () => {
    // Menu B is the latest outbound message — the reviewer's scenario.
    h.tables.messages = h.tables.messages.filter((m) => m.id !== 'plain')
    const msg = inbound({ body: '1', contextMessageId: 'prov-menu-A' })
    await ingestInboundMessage(msg, NUMBER, { mapNumberedMenuReplies: true, runBots: false })
    expect(inserted(msg.messageId)).toMatchObject({ reply_to_message_id: 'menu-a', interactive_reply_id: 'A_buy', content_type: 'interactive' })
  })

  it('a quote of a plain message leaves the text alone', async () => {
    const msg = inbound({ body: '1', contextMessageId: 'prov-plain' })
    await ingestInboundMessage(msg, NUMBER, { mapNumberedMenuReplies: true, runBots: false })
    expect(inserted(msg.messageId)).toMatchObject({ content_type: 'text', interactive_reply_id: null })
  })

  it('a quote of an unknown message leaves the text alone', async () => {
    const msg = inbound({ body: '1', contextMessageId: 'prov-unknown' })
    await ingestInboundMessage(msg, NUMBER, { mapNumberedMenuReplies: true, runBots: false })
    expect(inserted(msg.messageId)).toMatchObject({ content_type: 'text', interactive_reply_id: null })
  })
})

// G5 (second review): the delivery is only done once the essential
// writes after the insert succeeded; a redelivery repairs what failed.
describe('G5 — essential post-insert writes, repaired on redelivery', () => {
  it('a failed conversation update throws, and the redelivery completes it exactly once', async () => {
    const msg = inbound()
    h.rpcError = { message: 'connection reset' }
    await expect(ingestInboundMessage(msg, NUMBER, { throwOnFailure: true })).rejects.toBeInstanceOf(IngestFailure)
    expect(h.tables.messages).toHaveLength(1)
    expect(h.tables.messages[0].ingest_completed_at).toBeUndefined()

    h.rpcError = null
    const deferred: (() => Promise<void>)[] = []
    await ingestInboundMessage(msg, NUMBER, { throwOnFailure: true, deferFanOut: (t) => deferred.push(t) })
    expect(h.bumps).toBe(1)
    expect(h.tables.messages[0].ingest_completed_at).toBeTruthy()
    // the repaired delivery also gets its bot fan-out
    expect(deferred).toHaveLength(1)

    await deferred[0]()

    // a third delivery of the now complete message enqueues nothing and
    // re-runs nothing: its fan-out task is already done (H1)
    await ingestInboundMessage(msg, NUMBER, { throwOnFailure: true, deferFanOut: (t) => deferred.push(t) })
    for (const run of deferred.slice(1)) await run()
    expect(h.bumps).toBe(1)
    expect(h.tables.inbound_fanout_tasks).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
  })

  // H1 (third review): the fan-out is a durable outbox row written WITH
  // the completion. A delivery whose request never ran it (failed ledger
  // finish, a worker that died) still gets it from the redelivery.
  it('a completed message whose fan-out never ran gets it from the redelivery, once', async () => {
    const msg = inbound()
    const lost: (() => Promise<void>)[] = []
    await ingestInboundMessage(msg, NUMBER, { throwOnFailure: true, deferFanOut: (t) => lost.push(t) })
    // the first request's after() never ran its task (dropped)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()

    const redelivery: (() => Promise<void>)[] = []
    await ingestInboundMessage(msg, NUMBER, { throwOnFailure: true, deferFanOut: (t) => redelivery.push(t) })
    for (const run of redelivery) await run()
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'message.received', expect.anything(), expect.anything())

    // a late run of the first request's task does not repeat it
    for (const run of lost) await run()
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.bumps).toBe(1)
  })

  it('a reaction write failure propagates instead of being acknowledged', async () => {
    h.tables.messages.push({ id: 'target', conversation_id: 'conv-1', message_id: 'prov-target', sender_type: 'agent' })
    h.failInsertOn = 'message_reactions'
    await expect(
      ingestInboundMessage(
        inbound({ type: 'reaction', reaction: { targetMessageId: 'prov-target', emoji: '❤️' } }),
        NUMBER,
        { throwOnFailure: true, runBots: false },
      ),
    ).rejects.toBeInstanceOf(IngestFailure)
  })
})

// K5 (fourth review): Meta's path (acknowledged up front, no redelivery)
// never runs the fan-out outside its outbox task.
describe('K5 — completion errors on the Meta path', () => {
  it('a lost answer to a completion that committed runs the fan-out once, through its task', async () => {
    const msg = inbound()
    h.loseCompletionAnswer = true
    await ingestInboundMessage(msg, NUMBER)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    // the cron later tries the same task: nothing runs twice
    const { runFanoutForMessage } = await import('./fanout')
    await runFanoutForMessage(supabaseAdmin(), h.tables.messages[0].id as string)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.bumps).toBe(1)
  })

  it('a completion that really failed runs nothing now; the inputs are stored for the cron', async () => {
    const msg = inbound()
    h.completionFails = 2
    await ingestInboundMessage(msg, NUMBER)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.tables.messages[0].ingest_completed_at).toBeUndefined()
    expect(h.tables.messages[0].ingest_fanout).toMatchObject({ providerMessageId: msg.messageId, lastMessageText: 'olá' })
  })
})

// Phase 6: a personal number's delivery is its owner's — nothing
// automated runs, the contact it brings in stays hidden from the team
// (personal_only, migration 073) and the owner's address-book name stays
// on the conversation, never on the shared CRM contact.
describe('phase 6 — a personal number', () => {
  const PERSONAL = { id: 'num-p', accountId: ACCOUNT, scope: 'personal' as const, userId: 'agent-1' }
  const STRANGER = '5511988880000'

  it('runs nothing: no bots, no public webhook, the fan-out task says personal', async () => {
    h.dispatchWebhookEvent.mockClear()
    await ingestInboundMessage(inbound({ identity: { phone: STRANGER, name: 'Fulano', waUserId: null, waParentUserId: null, waUsername: null } }), PERSONAL)
    const task = (h.tables.inbound_fanout_tasks ?? [])[0]
    expect(task.payload).toMatchObject({ botsEnabled: false, personal: true, connectionId: 'num-p' })
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    // No `conversation.created` to the account's endpoints either.
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('a contact it brings in is personal-only, attributed to the owner', async () => {
    await ingestInboundMessage(inbound({ identity: { phone: STRANGER, name: 'Fulano', waUserId: null, waParentUserId: null, waUsername: null } }), PERSONAL)
    const contact = h.tables.contacts.find((c) => c.phone === STRANGER)!
    expect(contact).toMatchObject({ personal_only: true, user_id: 'agent-1' })
    const conv = h.tables.conversations.find((c) => c.contact_id === contact.id)!
    expect(conv).toMatchObject({ connection_id: 'num-p', user_id: 'agent-1' })
  })

  it('the owner’s address-book name stays on the conversation; the contact gets the public profile name', async () => {
    await ingestInboundMessage(
      inbound({
        identity: { phone: STRANGER, name: 'Mãe', nameSource: 'saved', pushName: 'Maria Souza', waUserId: null, waParentUserId: null, waUsername: null },
      }),
      PERSONAL,
    )
    const contact = h.tables.contacts.find((c) => c.phone === STRANGER)!
    expect(contact.name).toBe('Maria Souza')
    expect(contact.name_source).toBe('push')
    expect(h.tables.conversations.find((c) => c.contact_id === contact.id)!.saved_name).toBe('Mãe')
  })

  it('a business number keeps writing the saved name onto the contact (unchanged)', async () => {
    await ingestInboundMessage(
      inbound({
        identity: { phone: STRANGER, name: 'Cliente VIP', nameSource: 'saved', pushName: 'Maria Souza', waUserId: null, waParentUserId: null, waUsername: null },
      }),
      NUMBER,
    )
    const contact = h.tables.contacts.find((c) => c.phone === STRANGER)!
    expect(contact).toMatchObject({ name: 'Cliente VIP', name_source: 'saved', personal_only: false })
  })

  it('the same person on two numbers: two conversations, one contact', async () => {
    await ingestInboundMessage(inbound(), PERSONAL)
    expect(h.tables.contacts.filter((c) => c.phone === PHONE)).toHaveLength(1)
    expect(h.tables.conversations.filter((c) => c.contact_id === 'contact-1').map((c) => c.connection_id).sort()).toEqual([
      'num-1',
      'num-p',
    ])
  })
})
