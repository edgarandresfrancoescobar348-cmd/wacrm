import { describe, expect, it } from 'vitest'

import { matchesScope, scopeChoices, validScopeFilter, type ScopeNumber } from './scope-filter'

const numbers: ScopeNumber[] = [
  { id: 'meta', scope: 'business', visible: true },
  { id: 'loja', scope: 'business', visible: true },
  { id: 'meu', scope: 'personal', visible: true },
  { id: 'colega', scope: 'personal', visible: false },
  { id: 'velho', scope: 'business', visible: true, removed_at: '2026-10-01T00:00:00Z' },
]
const scopeOf = new Map(numbers.map((n) => [n.id, n.scope] as const))

describe('the inbox scope chips (phase 6)', () => {
  it('offer the live numbers the viewer sees, per scope', () => {
    const c = scopeChoices(numbers)
    expect(c.personal.map((n) => n.id)).toEqual(['meu'])
    expect(c.business.map((n) => n.id)).toEqual(['meta', 'loja'])
    expect(c.showChips).toBe(true)
  })

  it('no chips with a single number to see', () => {
    expect(scopeChoices([{ id: 'meta', scope: 'business', visible: true }]).showChips).toBe(false)
    expect(scopeChoices(undefined).showChips).toBe(false)
  })

  it('Pessoal keeps my personal number’s chats; Empresa the business ones, removed numbers’ history too', () => {
    const conv = (connection_id: string) => ({ connection_id })
    expect(matchesScope(conv('meu'), { scope: 'personal' }, scopeOf)).toBe(true)
    expect(matchesScope(conv('meta'), { scope: 'personal' }, scopeOf)).toBe(false)
    expect(matchesScope(conv('velho'), { scope: 'business' }, scopeOf)).toBe(true)
    expect(matchesScope(conv('meu'), { scope: 'all' }, scopeOf)).toBe(true)
  })

  it('one number of a scope', () => {
    expect(matchesScope({ connection_id: 'loja' }, { scope: 'business', connectionId: 'loja' }, scopeOf)).toBe(true)
    expect(matchesScope({ connection_id: 'meta' }, { scope: 'business', connectionId: 'loja' }, scopeOf)).toBe(false)
  })

  it('a saved choice that no longer applies falls back', () => {
    const c = scopeChoices(numbers)
    expect(validScopeFilter({ scope: 'business', connectionId: 'velho' }, c)).toEqual({ scope: 'business' })
    expect(validScopeFilter({ scope: 'personal' }, scopeChoices(numbers.filter((n) => n.scope === 'business')))).toEqual({ scope: 'all' })
  })
})
