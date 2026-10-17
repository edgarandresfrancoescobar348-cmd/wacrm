// The inbox's "Pessoal / Empresa / Todos" chips (phase 6): which numbers
// the viewer can filter by, and which conversations each choice keeps.

export type ScopeFilter =
  | { scope: 'all' }
  /** One scope; `connectionId` narrows it to one of its numbers. */
  | { scope: 'personal' | 'business'; connectionId?: string | null }

export interface ScopeNumber {
  id: string
  scope: 'personal' | 'business'
  /** Does the viewer see its conversations? */
  visible: boolean
  removed_at?: string | null
}

export interface ScopeChoices<T extends ScopeNumber> {
  /** The live numbers the viewer sees, per scope (a chip each when not empty). */
  personal: T[]
  business: T[]
  /** Chips only when there is something to choose between. */
  showChips: boolean
}

export function scopeChoices<T extends ScopeNumber>(numbers: readonly T[] | undefined): ScopeChoices<T> {
  const live = (numbers ?? []).filter((n) => n.visible && !n.removed_at)
  const personal = live.filter((n) => n.scope === 'personal')
  const business = live.filter((n) => n.scope === 'business')
  return { personal, business, showChips: live.length > 1 }
}

/** Does the conversation pass the chip? `scopeOf` maps a number id to its scope. */
export function matchesScope(
  conversation: { connection_id?: string | null },
  filter: ScopeFilter,
  scopeOf: ReadonlyMap<string, 'personal' | 'business'>,
): boolean {
  if (filter.scope === 'all') return true
  const id = conversation.connection_id ?? ''
  if (filter.connectionId) return id === filter.connectionId
  return scopeOf.get(id) === filter.scope
}

/** A saved choice that no longer applies (number removed, scope gone) falls back to "Todos". */
export function validScopeFilter(filter: ScopeFilter, choices: ScopeChoices<ScopeNumber>): ScopeFilter {
  if (filter.scope === 'all') return filter
  const pool = filter.scope === 'personal' ? choices.personal : choices.business
  if (!pool.length) return { scope: 'all' }
  if (filter.connectionId && !pool.some((n) => n.id === filter.connectionId)) return { scope: filter.scope }
  return filter
}
