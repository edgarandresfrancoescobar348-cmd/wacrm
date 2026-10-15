import { describe, expect, it } from 'vitest'

import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { matchNumberedMenuReply, renderNumberedMenu } from './numbered-menu'

const BUTTONS: InteractiveMessagePayload = {
  kind: 'buttons',
  header: 'Atendimento',
  body: 'Como podemos ajudar?',
  footer: 'Loja Exemplo',
  buttons: [
    { id: 'btn_sales', title: 'Comprar' },
    { id: 'btn_support', title: 'Suporte técnico' },
    { id: 'btn_human', title: 'Falar com atendente' },
  ],
}

const LIST: InteractiveMessagePayload = {
  kind: 'list',
  body: 'Escolha um horário',
  button_label: 'Horários',
  sections: [
    { title: 'Manhã', rows: [{ id: 'm9', title: '09:00' }, { id: 'm10', title: '10:00', description: 'Últimas vagas' }] },
    { title: 'Tarde', rows: [{ id: 't14', title: '14:00' }] },
  ],
}

describe('renderNumberedMenu', () => {
  it('numbers buttons and keeps header, body, footer and the hint', () => {
    expect(renderNumberedMenu(BUTTONS, 'Responda com o número.')).toBe(
      '*Atendimento*\nComo podemos ajudar?\n\n1. Comprar\n2. Suporte técnico\n3. Falar com atendente\n\n_Loja Exemplo_\nResponda com o número.',
    )
  })

  it('numbers list rows continuously across sections, with section titles and descriptions', () => {
    const text = renderNumberedMenu(LIST, 'hint')
    expect(text).toContain('_Manhã_\n1. 09:00\n2. 10:00 — Últimas vagas\n_Tarde_\n3. 14:00')
  })
})

describe('matchNumberedMenuReply', () => {
  it.each([
    ['2', 'btn_support'],
    [' 2 ', 'btn_support'],
    ['2.', 'btn_support'],
    ['2)', 'btn_support'],
    ['#3', 'btn_human'],
    ['1️⃣', 'btn_sales'],
  ])('maps the option number %j', (reply, id) => {
    expect(matchNumberedMenuReply(BUTTONS, reply)?.id).toBe(id)
  })

  it.each([
    ['suporte tecnico', 'btn_support'],
    ['SUPORTE TÉCNICO', 'btn_support'],
    ['Comprar!', 'btn_sales'],
    ['  falar com atendente. ', 'btn_human'],
  ])('maps the option title %j case- and accent-insensitively', (reply, id) => {
    expect(matchNumberedMenuReply(BUTTONS, reply)?.id).toBe(id)
  })

  it('maps list rows by their global number and title', () => {
    expect(matchNumberedMenuReply(LIST, '3')).toEqual({ id: 't14', title: '14:00' })
    expect(matchNumberedMenuReply(LIST, '10:00')).toEqual({ id: 'm10', title: '10:00' })
  })

  it('returns the option title with the id (what a native tap carries)', () => {
    expect(matchNumberedMenuReply(BUTTONS, '1')).toEqual({ id: 'btn_sales', title: 'Comprar' })
  })

  it.each(['0', '4', '12', 'quero comprar um sofá', 'sim', '', '2 e 3'])(
    'leaves %j alone (out of range or free text)',
    (reply) => {
      expect(matchNumberedMenuReply(BUTTONS, reply)).toBeNull()
    },
  )

  it('does not guess between two options with the same title', () => {
    const dup: InteractiveMessagePayload = {
      kind: 'buttons',
      body: 'x',
      buttons: [
        { id: 'a', title: 'Sim' },
        { id: 'b', title: 'sim' },
      ],
    }
    expect(matchNumberedMenuReply(dup, 'sim')).toBeNull()
    expect(matchNumberedMenuReply(dup, '2')?.id).toBe('b')
  })
})
