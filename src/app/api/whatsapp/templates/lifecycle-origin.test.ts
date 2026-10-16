// G8 (second review): only the version Meta actually approved is usable
// on the official API. A failed submission keeps the local content
// unusable; a sync that restores Meta's approved content makes it usable
// again.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ row: {} as Record<string, unknown>, submitFails: true }))

vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: class extends Error {},
  ForbiddenError: class extends Error {},
  toErrorResponse: () => new Response('', { status: 500 }),
  requireRole: async () => ({
    accountId: 'acct',
    userId: 'admin',
    supabase: {
      from: (table: string) => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          upsert: (row: Record<string, unknown>) => (Object.assign(h.row, row), q),
          update: (row: Record<string, unknown>) => (Object.assign(h.row, row), q),
          insert: () => q,
          single: async () => ({
            data: table === 'whatsapp_config' ? { provider: 'meta', waba_id: '123', access_token: 'dummy' } : h.row,
            error: null,
          }),
          maybeSingle: async () => ({ data: { id: 'template-id' }, error: null }),
          then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
        }
        return q
      },
    },
  }),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'dummy' }))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: async () => {
    if (h.submitFails) throw new Error('Meta rejected submission')
    return { id: 'meta-new', status: 'PENDING' }
  },
}))
vi.mock('@/lib/whatsapp/transport', () => ({ loadAccountProvider: async () => 'meta' }))
vi.mock('@/lib/whatsapp/template-header-handle', () => ({ ensureMediaHeaderHandle: async () => {} }))

import { POST as submit } from './submit/route'
import { POST as sync } from './sync/route'
import { templateUsableOn } from '@/lib/whatsapp/template-usable'

const submitReq = () =>
  new Request('http://app/api/whatsapp/templates/submit', {
    method: 'POST',
    body: JSON.stringify({ name: 'pedido', category: 'Marketing', language: 'pt_BR', body_text: 'desconto 50%' }),
  })

beforeEach(() => {
  h.submitFails = true
  h.row = { id: 'template-id', origin: 'local', status: 'APPROVED', name: 'pedido', body_text: 'desconto 50%', meta_template_id: null }
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN
})

describe('template origin lifecycle (G8)', () => {
  it('a failed submission keeps the local content unusable on Meta', async () => {
    const res = await submit(submitReq())
    expect(res.status).toBe(502)
    expect(h.row).toMatchObject({ origin: 'local', status: 'DRAFT', body_text: 'desconto 50%' })
    expect(templateUsableOn('meta_approved', h.row)).toBe(false)
  })

  it('a successful submission is Meta content (pending its review)', async () => {
    h.submitFails = false
    const res = await submit(submitReq())
    expect(res.status).toBe(200)
    expect(h.row).toMatchObject({ origin: 'meta', meta_template_id: 'meta-new', status: 'PENDING' })
  })

  it('sync restores Meta’s approved content AND its usability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ id: '123', name: 'pedido', category: 'MARKETING', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'desconto 10%' }] }] }),
          { status: 200 },
        ),
      ),
    )
    try {
      const res = await sync()
      expect(res.status).toBe(200)
      expect(h.row).toMatchObject({ origin: 'meta', status: 'APPROVED', meta_template_id: '123', body_text: 'desconto 10%' })
      expect(templateUsableOn('meta_approved', h.row)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('templateUsableOn — the currently approved version only (G8)', () => {
  it.each([
    [{ origin: 'meta', status: 'APPROVED' }, true],
    [{ origin: 'meta', status: 'PENDING' }, false],
    [{ origin: 'meta', status: 'REJECTED' }, false],
    [{ origin: 'meta', status: 'DRAFT' }, false],
    [{ origin: 'local', status: 'APPROVED' }, false],
  ] as const)('%o on Meta → %s', (row, usable) => {
    expect(templateUsableOn('meta_approved', row)).toBe(usable)
  })
  it('everything local is usable in QR mode', () => {
    expect(templateUsableOn('local', { origin: 'local', status: 'APPROVED' })).toBe(true)
  })
})
