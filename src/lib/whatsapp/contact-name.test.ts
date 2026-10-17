import { describe, expect, it } from 'vitest'

import { contactNamePatch, isUnofficialBusinessName, nameFromWhatsApp } from './contact-name'

// Phase 5e: WhatsApp shows "Ana Carla - SELO" (saved in the phone); wacrm
// showed "Ana Carla" — the import stored the chat-list name, then live
// messages overwrote it with the sender's push name.
describe('nameFromWhatsApp', () => {
  it('saved > chat title > verified > push; numbers never count', () => {
    expect(nameFromWhatsApp({ savedName: 'Ana Carla - SELO', pushName: 'Ana Carla' })).toEqual({ name: 'Ana Carla - SELO', source: 'saved' })
    expect(nameFromWhatsApp({ chatTitle: 'Isabella AGR', pushName: 'Isabella' })).toEqual({ name: 'Isabella AGR', source: 'saved' })
    expect(nameFromWhatsApp({ chatTitle: '+55 11 91234-5604', verifiedName: 'PicPay', verifiedLevel: 2, pushName: 'pp' })).toEqual({ name: 'PicPay', source: 'verified' })
    expect(nameFromWhatsApp({ verifiedName: 'PicPay', isEnterprise: true })).toEqual({ name: 'PicPay', source: 'verified' })
    expect(nameFromWhatsApp({ chatTitle: '+55 62 99842-3737', pushName: 'Pedro' })).toEqual({ name: 'Pedro', source: 'push' })
    expect(nameFromWhatsApp({ savedName: 'Ana', isMyContact: false, pushName: 'Aninha' })).toEqual({ name: 'Aninha', source: 'push' })
    expect(nameFromWhatsApp({ chatTitle: '5562998423737' })).toBeNull()
  })
})

// Phase 5f, real account round 3: "Sara Ferreira" was the title of
// 556298423737 (name_source 'verified'); WhatsApp lists "+55 62
// 99842-3737" and "~Sara Ferreira". Every WhatsApp Business account sends
// a business name (verifiedName); only an official one (level 2 /
// enterprise) titles the chat.
describe('a business name that is not an official account', () => {
  it('is a profile name (~), not the title', () => {
    const sara = { chatTitle: '+55 62 99842-3737', verifiedName: 'Sara Ferreira', verifiedLevel: 0, isEnterprise: false }
    expect(nameFromWhatsApp(sara)).toEqual({ name: 'Sara Ferreira', source: 'push' })
    expect(nameFromWhatsApp({ ...sara, pushName: 'Sarinha' })).toEqual({ name: 'Sarinha', source: 'push' })
    expect(nameFromWhatsApp({ ...sara, verifiedLevel: 1 })).toEqual({ name: 'Sara Ferreira', source: 'push' })
    // No level at all (contact details off): not proven official.
    expect(nameFromWhatsApp({ verifiedName: 'Sara Ferreira' })).toEqual({ name: 'Sara Ferreira', source: 'push' })
    // A saved name still wins.
    expect(nameFromWhatsApp({ ...sara, savedName: 'Sara (fornecedora)', isMyContact: true })).toEqual({ name: 'Sara (fornecedora)', source: 'saved' })
    expect(isUnofficialBusinessName(sara)).toBe(true)
    expect(isUnofficialBusinessName({ verifiedName: 'PicPay', verifiedLevel: 2 })).toBe(false)
    expect(isUnofficialBusinessName({ pushName: 'x' } as never)).toBe(false)
  })

  it('a stored one becomes the profile name; saved, typed and official names stay', () => {
    expect(contactNamePatch({ name: 'Sara Ferreira', name_source: 'verified', push_name: null }, null, undefined, { unofficialBusiness: true })).toEqual({
      name_source: 'push',
      push_name: 'Sara Ferreira',
    })
    expect(contactNamePatch({ name: 'Sara Ferreira', name_source: 'verified', push_name: 'Sara' }, null, undefined, { unofficialBusiness: true })).toEqual({
      name_source: 'push',
    })
    for (const source of ['saved', 'manual', 'push']) {
      expect(contactNamePatch({ name: 'Sara', name_source: source, push_name: 'Sara' }, null, undefined, { unofficialBusiness: true })).toBeNull()
    }
    expect(contactNamePatch({ name: 'PicPay', name_source: 'verified' }, { name: 'PicPay', source: 'verified' })).toBeNull()
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
