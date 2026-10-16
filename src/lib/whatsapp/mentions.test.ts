import { describe, expect, it } from 'vitest'

import { mentionIds, splitMentions } from './mentions'

// Phase 5d: "@154112083632297" (a LID mention) showed raw.
describe('mentions', () => {
  it('finds phone and LID mentions, once each', () => {
    expect(mentionIds('Oi @154112083632297, fala com @5511933739259 e @154112083632297')).toEqual([
      '154112083632297',
      '5511933739259',
    ])
  })

  it('ignores e-mails, short numbers and digits glued to words', () => {
    expect(mentionIds('ana@5511933739259.com, @123, abc@1234567, R$@99')).toEqual([])
  })

  it('splits the text around the mentions', () => {
    expect(splitMentions('@154112083632297 bom dia, @5511933739259!')).toEqual([
      { mention: '154112083632297' },
      { text: ' bom dia, ' },
      { mention: '5511933739259' },
      { text: '!' },
    ])
    expect(splitMentions('sem menção')).toEqual([{ text: 'sem menção' }])
  })
})
