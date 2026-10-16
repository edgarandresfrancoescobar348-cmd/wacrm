// Header params on POST /api/v1/messages: a template whose header has a
// {{1}} needs `template.params.headerText`; without it the call is a 400
// answered before a contact or conversation is created.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const templateRows: unknown[] = []
const ctx = {
  accountId: 'acc',
  supabase: {
    from: () => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: templateRows, error: null }).then(resolve),
      }
      return q
    },
  },
}
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: vi.fn(async () => ctx) }))
const resolveConversationByPhone = vi.fn(async () => ({ conversationId: 'cv', contactId: 'ct', contactCreated: true }))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: (...a: unknown[]) => (resolveConversationByPhone as unknown as (...x: unknown[]) => unknown)(...a),
}))
const sendMessageToConversation = vi.fn(async () => ({ messageId: 'm', whatsappMessageId: 'w' }))
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMessageToConversation: (...a: unknown[]) => (sendMessageToConversation as unknown as (...x: unknown[]) => unknown)(...a),
}))

const { POST } = await import('./route')

const HEADER_ROW = {
  id: 't', user_id: 'u', name: 'pedido', language: 'pt_BR', category: 'Utility', status: 'APPROVED', origin: 'meta',
  header_type: 'text', header_content: 'Pedido {{1}}', body_text: 'Olá {{1}}', created_at: '2026-01-01T00:00:00Z',
}

const post = (body: unknown) =>
  POST(new Request('http://x/api/v1/messages', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))

beforeEach(() => {
  templateRows.length = 0
  resolveConversationByPhone.mockClear()
  sendMessageToConversation.mockClear()
})

describe('POST /api/v1/messages — header params', () => {
  it('400 template_header_param_required, before any contact is created', async () => {
    templateRows.push(HEADER_ROW)
    const res = await post({ to: '+5511966660001', type: 'template', template: { name: 'pedido', language: 'pt_BR', params: ['Ana'] } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('template_header_param_required')
    expect(resolveConversationByPhone).not.toHaveBeenCalled()
    expect(sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('passes { body, headerText } through to the send core', async () => {
    templateRows.push(HEADER_ROW)
    const res = await post({
      to: '+5511966660001', type: 'template',
      template: { name: 'pedido', language: 'pt_BR', params: { body: ['Ana'], headerText: '#101' } },
    })
    expect(res.status).toBe(201)
    expect(sendMessageToConversation).toHaveBeenCalledWith(ctx.supabase, 'acc', expect.objectContaining({
      templateMessageParams: { body: ['Ana'], headerText: '#101' },
    }))
  })

  it('400 bad_request for a structured params object of the wrong shape', async () => {
    const res = await post({ to: '+5511966660001', type: 'template', template: { name: 'pedido', params: { headerText: 5 } } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('bad_request')
    expect(resolveConversationByPhone).not.toHaveBeenCalled()
  })

  it('a template without a header variable keeps working with a plain array', async () => {
    templateRows.push({ ...HEADER_ROW, header_content: 'Pedido' })
    const res = await post({ to: '+5511966660001', type: 'template', template: { name: 'pedido', language: 'pt_BR', params: ['Ana'] } })
    expect(res.status).toBe(201)
  })
})
