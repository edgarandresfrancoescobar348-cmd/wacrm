import { describe, expect, it } from 'vitest'

import { contactDisplayName, contactHandleDisplay, formatPhoneDisplay, contactProfileName } from './phone-display'

// Phase 5c: contacts without a saved name showed the raw "5511933739259".
describe('formatPhoneDisplay (like WhatsApp Web)', () => {
  it.each([
    ['5511933739259', '+55 11 93373-9259'], // BR mobile
    ['551133739259', '+55 11 3373-9259'], // BR landline
    ['+5521987654321', '+55 21 98765-4321'],
    ['16502530000', '+1 650-253-0000'],
    ['351912345678', '+351 912 345 678'],
    ['447911123456', '+447911123456'], // other countries: + and the digits
    ['', ''],
    ['abc', 'abc'],
  ])('%s → %s', (input, out) => {
    expect(formatPhoneDisplay(input)).toBe(out)
  })
})

describe('contactDisplayName', () => {
  it('prefers the saved name, then the formatted number, then the handle', () => {
    expect(contactDisplayName({ name: 'Ana', phone: '5511933739259' })).toBe('Ana')
    expect(contactDisplayName({ name: '  ', phone: '5511933739259' })).toBe('+55 11 93373-9259')
    expect(contactDisplayName({ name: null, phone: null, wa_username: 'loja' })).toBe('@loja')
    expect(contactHandleDisplay({ phone: '5511933739259' })).toBe('+55 11 93373-9259')
  })

  it('a "name" that is only the number (how a nameless contact is stored) shows formatted', () => {
    expect(contactDisplayName({ name: '5511933739259', phone: '5511933739259' })).toBe('+55 11 93373-9259')
    expect(contactDisplayName({ name: '+55 11 93373-9259', phone: null })).toBe('+55 11 93373-9259')
    expect(contactDisplayName({ name: 'Loja 24h', phone: '5511933739259' })).toBe('Loja 24h')
  })

  it('only a profile name: the title is the number, "~Name" is a detail, like WhatsApp (phase 5f)', () => {
    expect(contactDisplayName({ name: 'Sara Ferreira', name_source: 'push', phone: '5562998423737' })).toBe('+55 62 99842-3737')
    expect(contactProfileName({ name: 'Sara Ferreira', name_source: 'push', phone: '5562998423737' })).toBe('~Sara Ferreira')
    // no number to show: the profile name stands in, marked
    expect(contactDisplayName({ name: 'Sara', name_source: 'push', phone: null })).toBe('~Sara')
    // a number-only contact whose profile name is known
    expect(contactProfileName({ name: '5562998423737', name_source: 'phone', push_name: 'Sara', phone: '5562998423737' })).toBe('~Sara')
  })

  it('a saved, verified or typed name is the title, with no profile detail', () => {
    expect(contactDisplayName({ name: 'Pedro Henrique', name_source: 'saved', phone: '5511933739259' })).toBe('Pedro Henrique')
    expect(contactDisplayName({ name: 'PicPay', name_source: 'verified', phone: '5511933739259' })).toBe('PicPay')
    expect(contactDisplayName({ name: 'Ana', name_source: 'manual' })).toBe('Ana')
    expect(contactProfileName({ name: 'Pedro Henrique', name_source: 'saved', push_name: 'Pedro', phone: '5511933739259' })).toBeNull()
    expect(contactProfileName({ name: null, phone: '5511933739259' })).toBeNull()
  })
})
