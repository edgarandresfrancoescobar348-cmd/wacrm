import { describe, expect, it } from 'vitest'

import { scopeChoices } from './connection-access'
import { publicMediaObject } from './connection-scope'

describe('who may move a number between Pessoal and Empresa (phase 6b)', () => {
  const qr = { provider: 'openwa' as const, removedAt: null }
  const ana = 'u-ana'
  const as = (role: 'owner' | 'admin' | 'agent' | 'viewer', userId = 'u-other') => ({ role, userId })

  it('Empresa → Pessoal: an admin or the account owner; not an agent', () => {
    const shop = { ...qr, scope: 'business' as const, ownerUserId: null }
    expect(scopeChoices(shop, as('admin')).can_make_personal).toBe(true)
    expect(scopeChoices(shop, as('owner')).can_make_personal).toBe(true)
    expect(scopeChoices(shop, as('agent')).can_make_personal).toBe(false)
    expect(scopeChoices(shop, as('admin')).can_make_business).toBe(false)
  })

  it('Pessoal → Empresa: only that number’s owner — never an admin', () => {
    const mine = { ...qr, scope: 'personal' as const, ownerUserId: ana }
    expect(scopeChoices(mine, as('agent', ana)).can_make_business).toBe(true)
    expect(scopeChoices(mine, as('admin')).can_make_business).toBe(false)
    expect(scopeChoices(mine, as('owner')).can_make_business).toBe(false)
    expect(scopeChoices(mine, as('admin')).can_make_personal).toBe(false)
  })

  it('never the official number, nor a removed one', () => {
    expect(scopeChoices({ provider: 'meta', removedAt: null, scope: 'business', ownerUserId: null }, as('owner')))
      .toEqual({ can_make_personal: false, can_make_business: false })
    expect(scopeChoices({ ...qr, removedAt: '2026-10-01T00:00:00Z', scope: 'business', ownerUserId: null }, as('owner')))
      .toEqual({ can_make_personal: false, can_make_business: false })
  })
})

describe('publicMediaObject', () => {
  it('reads the object name of a chat-media public URL', () => {
    expect(publicMediaObject('http://127.0.0.1:54321/storage/v1/object/public/chat-media/account-1/inbound/a%20b.jpg?t=1'))
      .toBe('account-1/inbound/a b.jpg')
  })
  it('ignores anything else', () => {
    expect(publicMediaObject('/api/whatsapp/media/private?path=connection-1%2Fx.jpg')).toBeNull()
    expect(publicMediaObject('/api/whatsapp/openwa/media?chat=1@c.us&id=2')).toBeNull()
    expect(publicMediaObject('http://x/storage/v1/object/public/avatars/a.jpg')).toBeNull()
    expect(publicMediaObject(null)).toBeNull()
  })
})
