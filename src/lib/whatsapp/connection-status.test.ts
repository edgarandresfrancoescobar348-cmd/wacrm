import { describe, expect, it } from 'vitest'

import { connectionNotice } from './connection-status'

// Teste real 1, item 3: the inbox notice names the ACTIVE mode.
describe('connectionNotice', () => {
  it('QR mode connected → no notice (was: "WhatsApp not connected")', () => {
    expect(connectionNotice({ provider: 'openwa', status: 'connected' })).toEqual({ kind: null, provider: 'openwa' })
  })
  it('QR mode disconnected → the QR session notice, not the Meta one', () => {
    expect(connectionNotice({ provider: 'openwa', status: 'disconnected' }).kind).toBe('qr_disconnected')
  })
  it('Meta mode', () => {
    expect(connectionNotice({ provider: 'meta', status: 'connected' }).kind).toBeNull()
    expect(connectionNotice({ provider: 'meta', status: 'disconnected' }).kind).toBe('meta_disconnected')
    expect(connectionNotice({ provider: null, status: 'disconnected' }).kind).toBe('meta_disconnected')
  })
  it('no config row → not configured; still loading → nothing', () => {
    expect(connectionNotice(null).kind).toBe('not_configured')
    expect(connectionNotice(undefined).kind).toBeNull()
  })
})
