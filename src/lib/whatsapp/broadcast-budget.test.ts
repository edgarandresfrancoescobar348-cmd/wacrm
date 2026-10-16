// G7 + F8 (second review): a broadcast pass never outlives its handler,
// checkpoints before each external effect, and a pass paused by the
// budget continues automatically through the cron continuation.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { deliverBroadcast, type BroadcastPlan } from './broadcast-core'
import { resetBroadcastPacing } from './transport/pacing'
import { SendBudgetExceededError, type SendTemplateArgs } from './transport'

type Row = Record<string, unknown>

/** broadcast_recipients / broadcasts fake recording every write in order. */
function fakeDb(log: string[], recipients: Map<string, Row>, broadcasts: Map<string, Row>) {
  return {
    from(table: string) {
      let patch: Row | null = null
      const filters: Record<string, unknown> = {}
      const q: Record<string, unknown> = {
        update: (v: Row) => ((patch = v), q),
        select: () => q,
        eq: (c: string, v: unknown) => {
          filters[c] = v
          if (patch && c === 'id') {
            log.push(`${table}:${Object.keys(patch).join(',')}`)
            const target = table === 'broadcasts' ? broadcasts.get(String(v)) : recipients.get(String(v))
            if (target) Object.assign(target, patch)
          }
          return q
        },
        then: (resolve: (r: unknown) => unknown) => {
          const want = filters.status
          const count = [...recipients.values()].filter((r) => want === undefined || r.status === want).length
          return Promise.resolve({ count, error: null }).then(resolve)
        },
      }
      return q
    },
  } as unknown as SupabaseClient
}

function plan(transport: Partial<BroadcastPlan['transport']>, n = 3): BroadcastPlan {
  return {
    accountId: `acct-${Math.random()}`,
    broadcastId: 'bc-1',
    templateName: 't',
    templateLanguage: 'pt_BR',
    templateRow: null,
    rejected: 0,
    planned: Array.from({ length: n }, (_, i) => ({ recipientRowId: `r${i + 1}`, phone: `55119999900${i + 1}`, params: [] })),
    transport: {
      provider: 'openwa',
      capabilities: { templates: 'local', serviceWindow: false, interactive: 'numbered_text', broadcastDelayMs: 0, idempotentSends: true },
      recipientVariants: (p: string) => [p],
      isRecipientRetryable: () => false,
      ...transport,
    } as BroadcastPlan['transport'],
  }
}

let log: string[]
let recipients: Map<string, Row>
let broadcasts: Map<string, Row>
beforeEach(() => {
  resetBroadcastPacing()
  log = []
  recipients = new Map(['r1', 'r2', 'r3'].map((id) => [id, { id, status: 'pending' }]))
  broadcasts = new Map([['bc-1', { id: 'bc-1', status: 'sending' }]])
})

describe('deliverBroadcast — order of work (G7)', () => {
  it('prepares media before the slot, checkpoints before the send, passes sendBy + idempotency key', async () => {
    const sends: Row[] = []
    const p = plan({
      prepareTemplate: vi.fn(async () => void log.push('prepare')),
      sendTemplate: vi.fn(async (args: SendTemplateArgs) => (log.push('send'), sends.push(args as unknown as Row), { messageId: `id-${String(args.to)}` })),
    }, 1)
    await deliverBroadcast(fakeDb(log, recipients, broadcasts), p, { deadline: Date.now() + 60_000, sendBy: Date.now() + 100_000 })
    expect(log.slice(0, 3)).toEqual(['prepare', 'broadcast_recipients:send_started_at', 'send'])
    expect(sends[0]).toMatchObject({ idempotencyKey: 'broadcast-recipient:r1' })
    expect(typeof sends[0].sendBy).toBe('number')
  })

  it('a send cut off by the budget stays pending (checkpointed) and schedules the continuation', async () => {
    const p = plan({
      sendTemplate: vi.fn(async (args: SendTemplateArgs) => {
        if (args.to === '551199999002') throw new SendBudgetExceededError()
        return { messageId: 'ok' }
      }),
    })
    const result = await deliverBroadcast(fakeDb(log, recipients, broadcasts), p, { deadline: Date.now() + 60_000, sendBy: Date.now() + 100_000 })
    expect(result).toEqual({ attempted: 2, deferred: 2, interrupted: true })
    expect(recipients.get('r1')!.status).toBe('sent')
    expect(recipients.get('r2')).toMatchObject({ status: 'pending' })
    expect(recipients.get('r2')!.send_started_at).toBeTruthy()
    expect(recipients.get('r3')).toEqual({ id: 'r3', status: 'pending' })
    expect(broadcasts.get('bc-1')!.auto_resume_at).toBeTruthy()
  })

  it('clears the continuation flag when the pass finished everything', async () => {
    broadcasts.get('bc-1')!.auto_resume_at = 'x'
    await deliverBroadcast(fakeDb(log, recipients, broadcasts), plan({ sendTemplate: vi.fn(async () => ({ messageId: 'ok' })) }), {
      deadline: Date.now() + 60_000,
      sendBy: Date.now() + 100_000,
    })
    expect(broadcasts.get('bc-1')!.auto_resume_at).toBeNull()
  })
})
