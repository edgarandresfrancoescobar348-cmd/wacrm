// Header params on POST /api/v1/broadcasts: a recipient may carry the
// structured params { body, headerText }; a template whose header has a
// {{1}} without a value is a 400 before anything is persisted, and a
// stale frozen row is failed instead of sending a literal {{1}}.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { createBroadcast, deliverBroadcast, type BroadcastPlan } from './broadcast-core'
import { resetBroadcastPacing } from './transport/pacing'
import type { SendTemplateArgs } from './transport'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'plain-access-token' }))
const findOrCreateContact = vi.fn(async (_db: unknown, _a: string, _u: string, { phone }: { phone: string }) => ({ id: `c-${phone}` }))
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: (...args: unknown[]) => (findOrCreateContact as unknown as (...a: unknown[]) => unknown)(...args),
}))

type Row = Record<string, unknown>

const TEMPLATE = {
  id: 't1', user_id: 'u', name: 'pedido', category: 'Utility', language: 'pt_BR', status: 'APPROVED', origin: 'meta',
  header_type: 'text', header_content: 'Pedido {{1}}', body_text: 'Olá {{1}}', created_at: '2026-01-01T00:00:00Z',
}

/** Meta config + one template row + the create RPC echoing its contacts. */
function createDb(template: Row = TEMPLATE) {
  const rpc: { name: string; args: Record<string, unknown> }[] = []
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { phone_number_id: 'pn', access_token: 'enc' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (r: unknown) => unknown) =>
          Promise.resolve({ data: table === 'message_templates' ? [template] : [], error: null }).then(resolve),
      }
      return q
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpc.push({ name, args })
      const ids = args.p_contact_ids as string[]
      return Promise.resolve({
        data: ids.map((cid, i) => ({ broadcast_id: 'b1', recipient_id: `r${i + 1}`, contact_id: cid })),
        error: null,
      })
    },
  } as unknown as SupabaseClient
  return { db, rpc }
}

beforeEach(() => {
  findOrCreateContact.mockClear()
  resetBroadcastPacing()
})

describe('createBroadcast — header params', () => {
  it('answers 400 when the header has {{1}} and a recipient passes no value — nothing persisted', async () => {
    const { db, rpc } = createDb()
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'pedido',
        templateLanguage: 'pt_BR',
        recipients: [
          { to: '+5511966660001', params: { body: ['Ana'], headerText: '#101' } },
          { to: '+5511966660002', params: ['Bia'] },
        ],
      })
    ).rejects.toMatchObject({ code: 'template_header_param_required', status: 400, message: expect.stringContaining('recipients[1]') })
    expect(rpc).toHaveLength(0)
    expect(findOrCreateContact).not.toHaveBeenCalled()
  })

  it('answers 400 for a params value of the wrong shape', async () => {
    const { db, rpc } = createDb()
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'pedido',
        recipients: [{ to: '+5511966660001', params: { body: 'Ana' } }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 })
    expect(rpc).toHaveLength(0)
  })

  it('freezes { body, headerText } and plans the header value', async () => {
    const { db, rpc } = createDb()
    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'pedido',
      templateLanguage: 'pt_BR',
      recipients: [
        { to: '+5511966660001', params: { body: ['Ana'], headerText: '#101' } },
        { to: '+5511966660002', params: { body: ['Bia'], headerText: '#102' } },
      ],
    })
    expect(rpc[0].args.p_template_params).toEqual([
      { body: ['Ana'], headerText: '#101' },
      { body: ['Bia'], headerText: '#102' },
    ])
    expect(plan.planned.map((p) => [p.params, p.headerText])).toEqual([[['Ana'], '#101'], [['Bia'], '#102']])
  })

  it('stays backward compatible: plain arrays for a template without a header variable', async () => {
    const { db, rpc } = createDb({ ...TEMPLATE, header_content: 'Pedido' })
    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'pedido',
      recipients: [{ to: '+5511966660001', params: ['Ana'] }, { to: '+5511966660002' }],
    })
    expect(rpc[0].args.p_template_params).toEqual([['Ana'], []])
    expect(plan.planned.every((p) => p.headerText === undefined)).toBe(true)
  })
})

/** broadcast_recipients / broadcasts fake recording writes. */
function deliverDb(recipients: Map<string, Row>) {
  return {
    from() {
      let patch: Row | null = null
      const q: Record<string, unknown> = {
        update: (v: Row) => ((patch = v), q),
        select: () => q,
        eq: (c: string, v: unknown) => {
          if (patch && c === 'id') Object.assign(recipients.get(String(v)) ?? {}, patch)
          return q
        },
        then: (resolve: (r: unknown) => unknown) => Promise.resolve({ count: 0, error: null }).then(resolve),
      }
      return q
    },
  } as unknown as SupabaseClient
}

function plan(sendTemplate: (a: SendTemplateArgs) => Promise<{ messageId: string }>, planned: BroadcastPlan['planned']): BroadcastPlan {
  return {
    accountId: `acct-${Math.random()}`,
    broadcastId: 'b1',
    templateName: 'pedido',
    templateLanguage: 'pt_BR',
    templateRow: TEMPLATE as unknown as BroadcastPlan['templateRow'],
    rejected: 0,
    planned,
    transport: {
      provider: 'openwa',
      capabilities: { templates: 'local', serviceWindow: false, interactive: 'numbered_text', broadcastDelayMs: 0, idempotentSends: true },
      recipientVariants: (p: string) => [p],
      isRecipientRetryable: () => false,
      sendTemplate,
    } as unknown as BroadcastPlan['transport'],
  }
}

describe('deliverBroadcast — header params', () => {
  it('hands the header value to the transport as messageParams.headerText', async () => {
    const recipients = new Map([['r1', { status: 'pending' } as Row]])
    const sends: SendTemplateArgs[] = []
    await deliverBroadcast(
      deliverDb(recipients),
      plan(async (a) => (sends.push(a), { messageId: 'm1' }), [{ recipientRowId: 'r1', phone: '5511966660001', params: ['Ana'], headerText: '#101' }]),
    )
    expect(sends[0]).toMatchObject({ params: ['Ana'], messageParams: { headerText: '#101' } })
    expect(recipients.get('r1')!.status).toBe('sent')
  })

  it('fails a recipient frozen without the header value instead of sending {{1}}', async () => {
    const recipients = new Map([['r1', { status: 'pending' } as Row]])
    const send = vi.fn(async () => ({ messageId: 'm1' }))
    await deliverBroadcast(
      deliverDb(recipients),
      plan(send, [{ recipientRowId: 'r1', phone: '5511966660001', params: ['Ana'] }]),
    )
    expect(send).not.toHaveBeenCalled()
    expect(recipients.get('r1')).toMatchObject({ status: 'failed', error_message: expect.stringContaining('headerText') })
  })
})
