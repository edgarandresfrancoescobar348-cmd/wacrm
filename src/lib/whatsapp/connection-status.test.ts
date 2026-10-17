import { describe, expect, it } from 'vitest'

import { connectionNotice, scopeHasDown, type NumberState } from './connection-status'

const n = (
  id: string,
  provider: 'meta' | 'openwa',
  scope: 'personal' | 'business',
  status: 'connected' | 'disconnected',
  visible = true,
): NumberState => ({ id, provider, scope, status, visible })

// Phase 6: the notice speaks about the numbers the viewer sees, and says
// what keeps working (the owner's reference print: "Os WhatsApps Web estão
// desconectados. O atendimento oficial continua.").
describe('connectionNotice', () => {
  it('still loading → nothing; no number → not configured', () => {
    expect(connectionNotice(undefined).kind).toBeNull()
    expect(connectionNotice([]).kind).toBe('not_configured')
    // Someone else's personal number doesn't count.
    expect(connectionNotice([n('p', 'openwa', 'personal', 'connected', false)]).kind).toBe('not_configured')
  })

  it('everything up → no notice', () => {
    expect(connectionNotice([n('m', 'meta', 'business', 'connected'), n('q', 'openwa', 'business', 'connected')]).kind).toBeNull()
  })

  it('the business QR numbers down, the official one up — the reference print', () => {
    const r = connectionNotice([
      n('m', 'meta', 'business', 'connected'),
      n('q1', 'openwa', 'business', 'disconnected'),
      n('q2', 'openwa', 'business', 'disconnected'),
    ])
    expect(r.kind).toBe('web_down_official_up')
    expect(r.down.map((d) => d.id)).toEqual(['q1', 'q2'])
  })

  it('only my personal number down: the business keeps working', () => {
    expect(
      connectionNotice([n('m', 'meta', 'business', 'connected'), n('p', 'openwa', 'personal', 'disconnected')]).kind,
    ).toBe('personal_down')
  })

  it('a colleague’s personal number down is not my notice', () => {
    expect(
      connectionNotice([n('m', 'meta', 'business', 'connected'), n('p', 'openwa', 'personal', 'disconnected', false)]).kind,
    ).toBeNull()
  })

  it('the official number down while a QR number works', () => {
    expect(
      connectionNotice([n('m', 'meta', 'business', 'disconnected'), n('q', 'openwa', 'business', 'connected')]).kind,
    ).toBe('official_down')
  })

  it('every number I see down', () => {
    expect(
      connectionNotice([n('m', 'meta', 'business', 'disconnected'), n('p', 'openwa', 'personal', 'disconnected')]).kind,
    ).toBe('all_down')
  })

  it('a mix: the down ones by name', () => {
    const r = connectionNotice([
      n('m', 'meta', 'business', 'connected'),
      n('q', 'openwa', 'business', 'disconnected'),
      n('p', 'openwa', 'personal', 'disconnected'),
    ])
    expect(r.kind).toBe('some_down')
    expect(r.down.map((d) => d.id)).toEqual(['q', 'p'])
  })
})

describe('scopeHasDown (the chip’s ⚠)', () => {
  const all = [
    n('m', 'meta', 'business', 'connected'),
    n('q', 'openwa', 'business', 'disconnected'),
    n('p', 'openwa', 'personal', 'connected'),
    n('x', 'openwa', 'personal', 'disconnected', false),
  ]
  it('per scope, only numbers I see', () => {
    expect(scopeHasDown(all, 'business')).toBe(true)
    expect(scopeHasDown(all, 'personal')).toBe(false)
  })
})
