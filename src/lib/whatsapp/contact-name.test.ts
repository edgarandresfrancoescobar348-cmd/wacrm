import { describe, expect, it } from 'vitest'

import { contactNamePatch, nameFromWhatsApp } from './contact-name'

// Phase 5e: WhatsApp shows "Ana Carla - SELO" (saved in the phone); wacrm
// showed "Ana Carla" — the import stored the chat-list name, then live
// messages overwrote it with the sender's push name.
describe('nameFromWhatsApp', () => {
  it('saved > chat title > verified > push; numbers never count', () => {
    expect(nameFromWhatsApp({ savedName: 'Ana Carla - SELO', pushName: 'Ana Carla' })).toEqual({ name: 'Ana Carla - SELO', source: 'saved' })
    expect(nameFromWhatsApp({ chatTitle: 'Isabella AGR', pushName: 'Isabella' })).toEqual({ name: 'Isabella AGR', source: 'saved' })
    expect(nameFromWhatsApp({ chatTitle: '+55 62 99842-3737', verifiedName: 'PicPay', pushName: 'pp' })).toEqual({ name: 'PicPay', source: 'verified' })
    expect(nameFromWhatsApp({ chatTitle: '+55 62 99842-3737', pushName: 'Pedro' })).toEqual({ name: 'Pedro', source: 'push' })
    expect(nameFromWhatsApp({ savedName: 'Ana', isMyContact: false, pushName: 'Aninha' })).toEqual({ name: 'Aninha', source: 'push' })
    expect(nameFromWhatsApp({ chatTitle: '5562998423737' })).toBeNull()
  })
})

describe('contactNamePatch', () => {
  const saved = { name: 'Ana Carla - SELO', source: 'saved' as const }
  const push = { name: 'Ana Carla', source: 'push' as const }

  it('a push name never replaces a saved one; a saved one replaces a push one', () => {
    expect(contactNamePatch({ name: 'Ana Carla - SELO', name_source: 'saved' }, push, 'Ana Carla')).toEqual({ push_name: 'Ana Carla' })
    expect(contactNamePatch({ name: 'Ana Carla', name_source: 'push' }, saved)).toEqual({ name: 'Ana Carla - SELO', name_source: 'saved' })
  })

  it('a name a CRM user edited is never overwritten (only the push name is kept apart)', () => {
    expect(contactNamePatch({ name: 'Ana (cliente VIP)', name_source: 'manual' }, saved, 'Ana Carla')).toEqual({ push_name: 'Ana Carla' })
    expect(contactNamePatch({ name: 'Ana (cliente VIP)', name_source: 'manual' }, saved)).toBeNull()
  })

  it('a contact from before the source existed: a real name counts as push, a number as nothing', () => {
    expect(contactNamePatch({ name: 'Ana Carla', name_source: null }, saved)).toEqual({ name: 'Ana Carla - SELO', name_source: 'saved' })
    expect(contactNamePatch({ name: 'Ana Carla', name_source: null }, { name: 'Outra', source: 'push' })).toBeNull()
    expect(contactNamePatch({ name: '5511978550324', name_source: null }, push)).toEqual({ name: 'Ana Carla', name_source: 'push' })
  })

  it('a renamed address-book entry follows the phone', () => {
    expect(contactNamePatch({ name: 'Ana Carla - SELO', name_source: 'saved' }, { name: 'Ana Carla SELO', source: 'saved' })).toEqual({
      name: 'Ana Carla SELO',
      name_source: 'saved',
    })
  })
})
