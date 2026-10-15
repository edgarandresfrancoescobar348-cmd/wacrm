import { describe, expect, it } from 'vitest'

import { sessionPatch } from './session'

// F4 (review, follow-up): state read live from the gateway is newer than
// any webhook event dated before the read — it must advance the
// newest-wins watermark, or an older replayed/late event overwrites it.
describe('sessionPatch', () => {
  it('advances status_event_at to the time of the live read', () => {
    const before = Date.now()
    const patch = sessionPatch(
      { id: 's', name: 'n', status: 'ready', phone: '5511977776666', pushName: 'Loja', connectedAt: null, lastError: null, restriction: null },
      null,
    )
    expect(Date.parse(patch.status_event_at)).toBeGreaterThanOrEqual(before)
    expect(patch.status).toBe('ready')
  })
})
