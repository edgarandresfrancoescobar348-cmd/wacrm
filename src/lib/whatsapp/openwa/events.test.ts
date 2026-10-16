// OpenWA events → the shared ingestion path. The ingestion functions
// are stubbed; these tests pin what each OpenWA event becomes.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  ingestInboundMessage: vi.fn(async () => undefined),
  applyStatusUpdate: vi.fn(async () => undefined),
  applyMessageMutation: vi.fn(async () => undefined),
  recordOutboundEcho: vi.fn(async () => 'recorded'),
  mirrorInboundMedia: vi.fn(async () => 'https://storage/chat-media/x.jpg'),
  updates: [] as { table: string; patch: Record<string, unknown> }[],
  orFilters: [] as string[],
  staleSession: false,
  failMirror: false,
  failSession: false,
  rpcs: [] as { fn: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
}))

vi.mock('@/lib/whatsapp/inbound/ingest', () => ({
  ingestInboundMessage: h.ingestInboundMessage,
  applyStatusUpdate: h.applyStatusUpdate,
  applyMessageMutation: h.applyMessageMutation,
  recordOutboundEcho: h.recordOutboundEcho,
}))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({
  mirrorInboundMedia: h.mirrorInboundMedia,
}))

import {
  handleOpenWaEvent,
  isIgnorableChat,
  phoneFromChatId,
  toIngestType,
  type OpenWaEnvelope,
} from './events'
import type { OpenWaConnectionRow } from './connection'

const admin = {
  storage: {},
  rpc: async (fn: string, args: Record<string, unknown>) => {
    h.rpcs.push({ fn, args })
    return { data: null, error: h.rpcError }
  },
  from: (table: string) => ({
    update: (patch: Record<string, unknown>) => {
      h.updates.push({ table, patch })
      const chain = {
        eq: () => chain,
        or: (f: string) => (h.orFilters.push(f), chain),
        // A stale session event matches no row (status_event_at is newer).
        select: async () =>
          h.failSession
            ? { data: null, error: { message: 'connection reset' } }
            : { data: h.staleSession ? [] : [{ id: 'row' }], error: null },
        then: (r: (v: unknown) => unknown) =>
          r({ error: table === 'whatsapp_config' && h.failMirror ? { message: 'connection reset' } : null }),
      }
      return chain
    },
  }),
} as unknown as SupabaseClient

const row = {
  account_id: 'acct-1',
  user_id: 'user-1',
  session_id: 'sess-1',
  phone: '5511977776666',
  connected_at: null,
} as unknown as OpenWaConnectionRow

function ctx(activeProvider = 'openwa') {
  return { admin, row, creds: { baseUrl: 'http://gw', apiKey: 'k' }, activeProvider, mirrorMedia: true }
}

function env(event: string, data: Record<string, unknown>): OpenWaEnvelope {
  return { event, sessionId: 'sess-1', timestamp: '2026-10-15T22:17:00.250Z', data }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.updates.length = 0
  h.orFilters.length = 0
  h.rpcs.length = 0
  h.rpcError = null
  h.failSession = false
  h.staleSession = false
  h.failMirror = false
})

describe('classification helpers', () => {
  it('phoneFromChatId takes only one-to-one JIDs', () => {
    expect(phoneFromChatId('5511988887777@c.us')).toBe('5511988887777')
    expect(phoneFromChatId('5511988887777@s.whatsapp.net')).toBe('5511988887777')
    expect(phoneFromChatId('120363000000@g.us')).toBeNull()
    expect(phoneFromChatId('123456789@lid')).toBeNull()
  })

  it('isIgnorableChat drops groups, status, channels and broadcast lists', () => {
    expect(isIgnorableChat({ chatId: '1203@g.us', isGroup: true })).toBe(true)
    expect(isIgnorableChat({ chatId: 'status@broadcast' })).toBe(true)
    expect(isIgnorableChat({ chatId: '1203@newsletter', kind: 'channel' })).toBe(true)
    expect(isIgnorableChat({ chatId: '5511@c.us', isStatusBroadcast: true })).toBe(true)
    expect(isIgnorableChat({ chatId: '5511988887777@c.us', kind: 'individual' })).toBe(false)
  })

  it('maps OpenWA types onto the ingestion vocabulary', () => {
    expect(toIngestType({ type: 'voice' })).toBe('audio')
    expect(toIngestType({ type: 'sticker' })).toBe('sticker')
    expect(toIngestType({ type: 'contact' })).toBe('text')
    expect(toIngestType({ type: 'text', button: { id: 'b1' } })).toBe('interactive')
  })
})

describe('message.received', () => {
  const text = {
    id: 'false_5511988887777@c.us_3EB0A1',
    from: '5511988887777@c.us',
    chatId: '5511988887777@c.us',
    body: 'Olá, quero um orçamento',
    type: 'text',
    timestamp: 1792102503,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    contact: { name: 'Maria Silva', pushName: 'Maria' },
    quotedMessage: { id: 'true_5511988887777@c.us_3EB0FF', body: 'Como posso ajudar?' },
  }

  it('becomes an InboundMessage on the shared path, with menu mapping on', async () => {
    expect(await handleOpenWaEvent(env('message.received', text), ctx())).toBe('ingested')
    const [inbound, accountId, owner, options] = h.ingestInboundMessage.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
      string,
      Record<string, unknown>,
    ]
    expect(accountId).toBe('acct-1')
    expect(owner).toBe('user-1')
    expect(inbound).toMatchObject({
      provider: 'openwa',
      messageId: text.id,
      timestamp: '1792102503',
      type: 'text',
      identity: { phone: '5511988887777', name: 'Maria', waUserId: null },
      contextMessageId: 'true_5511988887777@c.us_3EB0FF',
      text: 'Olá, quero um orçamento',
    })
    expect(options).toMatchObject({ runBots: true, mapNumberedMenuReplies: true })
    const content = await (inbound.resolveContent as (c: { accountId: string }) => Promise<unknown>)({ accountId: 'acct-1' })
    expect(content).toEqual({ contentText: text.body, mediaUrl: null, mediaType: null, interactiveReplyId: null })
  })

  it('stores but does not run bots when QR is not the active mode', async () => {
    await handleOpenWaEvent(env('message.received', text), ctx('meta'))
    const options = (h.ingestInboundMessage.mock.calls[0] as unknown as unknown[])[3]
    expect(options).toMatchObject({ runBots: false })
  })

  it('ignores group messages', async () => {
    const group = { ...text, chatId: '120363000000@g.us', from: '120363000000@g.us', isGroup: true, kind: 'group' }
    expect(await handleOpenWaEvent(env('message.received', group), ctx())).toBe('ignored_group')
    expect(h.ingestInboundMessage).not.toHaveBeenCalled()
  })

  it('uses senderPhone for a privacy (@lid) sender', async () => {
    const lid = { ...text, chatId: '987654321@lid', from: '987654321@lid', senderPhone: '+55 11 98888-7777' }
    await handleOpenWaEvent(env('message.received', lid), ctx())
    const inbound = (h.ingestInboundMessage.mock.calls[0] as unknown as [{ identity: { phone: string } }])[0]
    expect(inbound.identity.phone).toBe('5511988887777')
  })

  it('mirrors inline media and keeps the caption; voice notes are audio', async () => {
    const voice = {
      ...text,
      type: 'voice',
      body: '',
      media: { mimetype: 'audio/ogg; codecs=opus', data: Buffer.from('OggS').toString('base64') },
    }
    await handleOpenWaEvent(env('message.received', voice), ctx())
    const inbound = (h.ingestInboundMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(inbound.type).toBe('audio')
    const content = await (inbound.resolveContent as (c: { accountId: string }) => Promise<Record<string, unknown>>)({ accountId: 'acct-1' })
    expect(content).toMatchObject({ mediaUrl: 'https://storage/chat-media/x.jpg', mediaType: 'audio/ogg; codecs=opus' })
    const mirrorArgs = (h.mirrorInboundMedia.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(mirrorArgs).toMatchObject({ accountId: 'acct-1', mimeType: 'audio/ogg; codecs=opus' })
    const downloaded = await (mirrorArgs.download as () => Promise<{ buffer: Buffer }>)()
    expect(downloaded.buffer.toString()).toBe('OggS')
  })

  it('falls back to the authenticated media proxy when mirroring fails', async () => {
    h.mirrorInboundMedia.mockResolvedValueOnce(null as unknown as string)
    const doc = { ...text, type: 'document', body: '', media: { mimetype: 'application/pdf', filename: 'orcamento.pdf', omitted: true, sizeBytes: 3_000_000 } }
    await handleOpenWaEvent(env('message.received', doc), ctx())
    const inbound = (h.ingestInboundMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    const content = await (inbound.resolveContent as (c: { accountId: string }) => Promise<Record<string, unknown>>)({ accountId: 'acct-1' })
    expect(content.contentText).toBe('orcamento.pdf')
    expect(content.mediaUrl).toBe(
      `/api/whatsapp/openwa/media?chat=${encodeURIComponent(text.chatId)}&id=${encodeURIComponent(text.id)}`,
    )
  })

  it('a Baileys tap on a native button carries its id', async () => {
    await handleOpenWaEvent(env('message.received', { ...text, body: 'Suporte', button: { id: 'btn_support', text: 'Suporte' } }), ctx())
    const inbound = (h.ingestInboundMessage.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    const content = await (inbound.resolveContent as (c: { accountId: string }) => Promise<Record<string, unknown>>)({ accountId: 'acct-1' })
    expect(content).toMatchObject({ interactiveReplyId: 'btn_support', contentText: 'Suporte' })
  })
})

describe('acks, failures, reactions, mutations', () => {
  it('message.ack moves the tick, scoped to the account', async () => {
    await handleOpenWaEvent(env('message.ack', { id: 'true_x', messageId: 'true_x', status: 'read', ack: 3 }), ctx())
    expect(h.applyStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'true_x', status: 'read', failure: null }),
      { accountId: 'acct-1', throwOnFailure: true },
    )
  })

  it('a pending ack is not a status we store', async () => {
    await handleOpenWaEvent(env('message.ack', { messageId: 'true_x', status: 'pending', ack: 0 }), ctx())
    expect(h.applyStatusUpdate).not.toHaveBeenCalled()
  })

  it('message.failed marks the message failed with a reason', async () => {
    await handleOpenWaEvent(env('message.failed', { messageId: 'true_x', status: 'failed', ack: -1 }), ctx())
    expect(h.applyStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failure: expect.objectContaining({ title: expect.any(String) }) }),
      { accountId: 'acct-1', throwOnFailure: true },
    )
  })

  it('message.reaction becomes a reaction on the target, without bots', async () => {
    await handleOpenWaEvent(
      env('message.reaction', { messageId: 'true_x', chatId: '5511988887777@c.us', senderId: '5511988887777@c.us', reaction: '❤️' }),
      ctx(),
    )
    const [inbound, , , options] = h.ingestInboundMessage.mock.calls[0] as unknown as [Record<string, unknown>, string, string, Record<string, unknown>]
    expect(inbound).toMatchObject({ type: 'reaction', reaction: { targetMessageId: 'true_x', emoji: '❤️' } })
    expect(options).toEqual({ runBots: false, throwOnFailure: true })
  })

  it('ignores our own reaction echoing back from the phone', async () => {
    await handleOpenWaEvent(
      env('message.reaction', { messageId: 'false_y', chatId: '5511988887777@c.us', senderId: '5511977776666@c.us', reaction: '👍' }),
      ctx(),
    )
    expect(h.ingestInboundMessage).not.toHaveBeenCalled()
  })

  it('revoked and edited messages are marked, not deleted', async () => {
    await handleOpenWaEvent(env('message.revoked', { id: 'notice', revokedId: 'false_z', chatId: 'c', type: 'revoked' }), ctx())
    await handleOpenWaEvent(env('message.edited', { messageId: 'false_z', body: 'texto novo' }), ctx())
    expect(h.applyMessageMutation).toHaveBeenNthCalledWith(1, 'acct-1', 'false_z', expect.objectContaining({ kind: 'revoked' }), { throwOnFailure: true })
    expect(h.applyMessageMutation).toHaveBeenNthCalledWith(2, 'acct-1', 'false_z', expect.objectContaining({ kind: 'edited', text: 'texto novo' }), { throwOnFailure: true })
  })
})

describe('session events', () => {
  // The active-connection flag is derived from this row by the database
  // (migration 058; sql/openwa-status-mirror.pg.test.ts) — ONE write.
  it('session.authenticated stores phone + push name in one write (the flag follows in SQL)', async () => {
    await handleOpenWaEvent(env('session.authenticated', { sessionId: 'sess-1', phone: '5511977776666', pushName: 'Loja' }), ctx())
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({
      table: 'whatsapp_openwa_config',
      patch: { status: 'ready', phone: '5511977776666', push_name: 'Loja' },
    })
  })

  it('session.status disconnected is one write of the session row', async () => {
    await handleOpenWaEvent(env('session.status', { sessionId: 'sess-1', status: 'disconnected' }), ctx())
    expect(h.updates.map((u) => u.table)).toEqual(['whatsapp_openwa_config'])
  })

  it('session.restriction stores and clears the restriction', async () => {
    await handleOpenWaEvent(env('session.restriction', { active: true, kind: 'reachout_timelock', code: '463', expiresAt: null }), ctx())
    await handleOpenWaEvent(env('session.restriction', { active: false }), ctx())
    expect(h.updates[0].patch.restriction).toEqual({ kind: 'reachout_timelock', code: '463', expiresAt: null })
    expect(h.updates[1].patch.restriction).toBeNull()
  })

  it('ignores an unknown status value', async () => {
    await handleOpenWaEvent(env('session.status', { status: 'banned' }), ctx())
    expect(h.updates).toHaveLength(0)
  })
})

describe('message.sent (phone echo)', () => {
  // Third review (H5/H6): an echo is evidence. A broadcast send whose
  // outcome was unknown is reconciled from it — never resent.
  it('offers the echo to the broadcast attempt reconciliation first', async () => {
    await handleOpenWaEvent(
      env('message.sent', { id: 'true_5511988887777@c.us_AB', chatId: '5511988887777@c.us', body: 'Olá Ana', type: 'text', fromMe: true }),
      ctx(),
    )
    expect(h.rpcs).toEqual([
      {
        fn: 'broadcast_attempt_reconcile_echo',
        args: {
          p_account_id: 'acct-1',
          p_to_phone: '5511988887777',
          p_body: 'Olá Ana',
          p_message_id: 'true_5511988887777@c.us_AB',
          p_sent_at: '2026-10-15T22:17:00.250Z',
        },
      },
    ])
  })

  it('a failed reconciliation fails the delivery (OpenWA redelivers)', async () => {
    h.rpcError = { message: 'connection reset' }
    await expect(
      handleOpenWaEvent(
        env('message.sent', { id: 'x', chatId: '5511988887777@c.us', body: 'Olá', type: 'text', fromMe: true }),
        ctx(),
      ),
    ).rejects.toThrow(/reconcile/)
  })

  it('records the echo straight away (no fixed settle delay)', async () => {
    const outcome = await handleOpenWaEvent(
      env('message.sent', { id: 'true_5511988887777@c.us_AB', chatId: '5511988887777@c.us', to: '5511988887777@c.us', body: 'enviado do celular', type: 'text', fromMe: true }),
      ctx(),
    )
    expect(outcome).toBe('echo')
    expect(h.recordOutboundEcho).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'true_5511988887777@c.us_AB', identity: expect.objectContaining({ phone: '5511988887777', name: '' }) }),
      'acct-1',
      'user-1',
      { throwOnFailure: true },
    )
  })
})

// F4 (review): a captured old session event replayed later (or a late
// at-least-once redelivery) must not overwrite newer session state.
describe('session events are newest-wins (F4)', () => {
  it('applies only when not older than the last applied event', async () => {
    await handleOpenWaEvent(env('session.status', { sessionId: 'sess-1', status: 'disconnected' }), ctx())
    expect(h.updates[0].patch.status_event_at).toBe('2026-10-15T22:17:00.250Z')
    expect(h.orFilters[0]).toBe('status_event_at.is.null,status_event_at.lte.2026-10-15T22:17:00.250Z')
  })

  it('an older event changes nothing — not even the active-connection flag', async () => {
    h.staleSession = true
    await handleOpenWaEvent(env('session.status', { sessionId: 'sess-1', status: 'disconnected' }), ctx())
    expect(h.updates.filter((u) => u.table === 'whatsapp_config')).toHaveLength(0)
  })
})

// G5 (second review): a failed session write fails the delivery. The
// mirror is part of that same write now (migration 058).
describe('session write failure (G5)', () => {
  it('fails the delivery so OpenWA redelivers', async () => {
    h.failSession = true
    await expect(
      handleOpenWaEvent(env('session.status', { sessionId: 'sess-1', status: 'disconnected' }), ctx()),
    ).rejects.toThrow(/session state update failed/)
  })
})

// G6 (second review): watermarks keep milliseconds. A fake that EVALUATES
// the newest-wins filter against a stored watermark, like PostgreSQL.
describe('session / edit watermark precision (G6)', () => {
  function watermarkAdmin(state: { watermark: string; status: string }) {
    return {
      from: (table: string) => ({
        update: (patch: Record<string, unknown>) => {
          let bound = ''
          const q = {
            eq: () => q,
            or: (f: string) => ((bound = f.split('.lte.')[1] ?? ''), q),
            select: async () => {
              if (table !== 'whatsapp_openwa_config') return { data: [], error: null }
              if (Date.parse(state.watermark) > Date.parse(bound)) return { data: [], error: null }
              state.status = String(patch.status)
              state.watermark = String(patch.status_event_at)
              return { data: [{ id: 'row' }], error: null }
            },
            then: (r: (v: unknown) => unknown) => r({ error: null }),
          }
          return q
        },
      }),
    } as unknown as SupabaseClient
  }

  it('a disconnect 800 ms after a live refresh (same second) is applied', async () => {
    const state = { watermark: '2026-10-15T10:00:00.100Z', status: 'ready' }
    await handleOpenWaEvent(
      { event: 'session.disconnected', sessionId: 'sess-1', timestamp: '2026-10-15T10:00:00.900Z', data: { reason: 'actual disconnect' } },
      { ...ctx(), admin: watermarkAdmin(state) },
    )
    expect(state.status).toBe('disconnected')
    expect(state.watermark).toBe('2026-10-15T10:00:00.900Z')
  })

  it('an event 1 ms older than the watermark is still ignored', async () => {
    const state = { watermark: '2026-10-15T10:00:00.900Z', status: 'disconnected' }
    await handleOpenWaEvent(
      { event: 'session.status', sessionId: 'sess-1', timestamp: '2026-10-15T10:00:00.899Z', data: { status: 'ready' } },
      { ...ctx(), admin: watermarkAdmin(state) },
    )
    expect(state.status).toBe('disconnected')
  })

  it('edits carry the millisecond instant (two edits in one second keep their order)', async () => {
    await handleOpenWaEvent(env('message.edited', { messageId: 'm', body: 'v2' }), ctx())
    expect(h.applyMessageMutation).toHaveBeenLastCalledWith('acct-1', 'm', expect.objectContaining({ at: '2026-10-15T22:17:00.250Z' }), { throwOnFailure: true })
  })
})
