// A2: one structure per message kind, the same in both connection modes,
// and list previews like WhatsApp's — never "[text]" or empty.
import { describe, expect, it } from 'vitest'

import { contentTypeForKind, mapsUrl, parsePreviewToken, parseVcards, previewFor } from './message-content'
import { mapOpenWaMessage } from './openwa/events'
import { previewParts } from '@/components/inbox/message-preview'

const VCARD = 'BEGIN:VCARD\nVERSION:3.0\nN:Silva;Maria;;;\nFN:Maria Silva\nitem1.TEL;waid=5511912345678:+55 11 91234-5678\nitem1.X-ABLabel:Celular\nEND:VCARD'

describe('parseVcards', () => {
  it('reads name and phones (WhatsApp vCard)', () => {
    expect(parseVcards(VCARD)).toEqual([{ name: 'Maria Silva', phones: ['+55 11 91234-5678'] }])
  })
  it('several cards, N fallback, waid fallback', () => {
    const two = VCARD + '\nBEGIN:VCARD\nN:Souza;João\nTEL;waid=5521999990000:\nEND:VCARD'
    expect(parseVcards(two)[1]).toEqual({ name: 'João Souza', phones: ['5521999990000'] })
  })
  it('not a vCard → nothing', () => {
    expect(parseVcards('oi')).toEqual([])
  })
})

// Every OpenWA neutral type (engine interface MessageType) → stored shape.
describe('mapOpenWaMessage — every OpenWA type (A2)', () => {
  const media = { mimetype: 'image/jpeg', omitted: true }
  it.each([
    ['text', { body: 'oi' }, 'text', null],
    ['image', { body: 'legenda', media }, 'image', null],
    ['video', { media: { mimetype: 'video/mp4' } }, 'video', null],
    ['audio', { media: { mimetype: 'audio/mpeg' } }, 'audio', null],
    ['voice', { media: { mimetype: 'audio/ogg; codecs=opus' } }, 'audio', 'voice'],
    ['document', { media: { mimetype: 'application/pdf', filename: 'nota.pdf', sizeBytes: 2048 } }, 'document', 'document'],
    ['sticker', { media: { mimetype: 'image/webp' } }, 'image', 'sticker'],
    ['location', { location: { latitude: -23.5, longitude: -46.6, description: 'Escritório', address: 'Av. Paulista' } }, 'location', 'location'],
    ['contact', { body: VCARD }, 'text', 'contact'],
    ['poll', { poll: { name: 'Qual horário?', options: ['9h', '14h'], allowMultipleAnswers: false } }, 'text', 'poll'],
    ['call', { call: { video: true, missed: true } }, 'text', 'call'],
    ['order', { order: { orderId: 'o1' }, body: '2 itens' }, 'text', 'order'],
    ['product', { product: { productId: 'p1', title: 'Camiseta' } }, 'text', 'product'],
    ['masked', {}, 'text', 'masked'],
  ])('%s', (type, extra, contentType, kind) => {
    const m = mapOpenWaMessage({ type, ...(extra as object) })
    expect(m.contentType).toBe(contentType)
    expect(m.meta?.kind ?? null).toBe(kind)
    if (m.meta) expect(contentTypeForKind(m.meta.kind)).toBe(contentType)
  })
  it('revoked → a deleted message', () => {
    expect(mapOpenWaMessage({ type: 'revoked' }).revoked).toBe(true)
  })
  it('structures carry what the bubbles show', () => {
    expect(mapOpenWaMessage({ type: 'contact', body: VCARD }).meta).toEqual({
      kind: 'contact',
      contacts: [{ name: 'Maria Silva', phones: ['+55 11 91234-5678'] }],
    })
    expect(mapOpenWaMessage({ type: 'poll', poll: { name: 'Q?', options: ['a', 'b'], allowMultipleAnswers: true } }).meta).toEqual({
      kind: 'poll', question: 'Q?', options: ['a', 'b'], multiple: true,
    })
    expect(mapOpenWaMessage({ type: 'call', call: { video: false, missed: false } }).meta).toEqual({
      kind: 'call', video: false, missed: false,
    })
  })
})

describe('previewFor / previewParts — like WhatsApp, never "[text]" or empty', () => {
  const t = (k: string) => `<${k}>`
  it.each([
    ['image', null, null, 'image', '<photo>'],
    ['image', null, 'legenda', 'image', 'legenda'],
    ['audio', { kind: 'voice' }, null, 'voice', '<voice>'],
    ['document', { kind: 'document', filename: 'nota.pdf' }, 'nota.pdf', 'document', 'nota.pdf'],
    ['image', { kind: 'sticker' }, null, 'sticker', '<sticker>'],
    ['text', { kind: 'contact', contacts: [{ name: 'Maria', phones: [] }] }, 'Maria', 'contact', 'Maria'],
    ['text', { kind: 'poll', question: 'Qual?', options: [], multiple: false }, 'Qual?', 'poll', 'Qual?'],
    ['text', { kind: 'call', video: false, missed: true }, null, 'call', '<voiceCallMissed>'],
    ['text', { kind: 'masked' }, null, 'masked', '<masked>'],
    ['location', { kind: 'location', latitude: 1, longitude: 2, name: 'Loja' }, 'Loja', 'location', 'Loja'],
  ] as const)('%s %j', (ct, meta, text, kind, label) => {
    const token = previewFor(ct, meta as never, text)
    expect(parsePreviewToken(token)?.kind).toBe(kind)
    const parts = previewParts(token, '<empty>', t)
    expect(parts.label).toBe(label)
    expect(parts.icon).not.toBeNull()
  })
  it('text stays text; an empty text message is never blank', () => {
    expect(previewFor('text', null, 'Olá')).toBe('Olá')
    expect(previewParts(previewFor('text', null, ''), '<empty>', t).label).toBe('<message>')
  })
  it('older bare tokens keep working', () => {
    expect(previewParts('[image]', '', t).label).toBe('<photo>')
  })
  // Phase 5e: the phone's preview lines.
  it('voice with its length, document with its pages, deleted, albums', () => {
    const tt = (k: string, v?: Record<string, string | number>) => (v ? `<${k} ${JSON.stringify(v)}>` : `<${k}>`)
    expect(previewFor('audio', { kind: 'voice' }, null, { durationSeconds: 9 })).toBe('[voice:0:09]')
    expect(previewParts('[voice:0:09]', '', tt).label).toBe('<voiceWithDuration {"duration":"0:09"}>')
    expect(previewFor('document', { kind: 'document', filename: '3 ANTECEDENTES.pdf' }, '3 ANTECEDENTES.pdf', { pageCount: 1 })).toBe('[document:3 ANTECEDENTES.pdf|1]')
    expect(previewParts('[document:3 ANTECEDENTES.pdf|1]', '', tt).label).toBe('3 ANTECEDENTES.pdf · <pages {"count":1}>')
    expect(previewFor('document', { kind: 'document', filename: 'a|b.pdf' }, null)).toBe('[document:a b.pdf]')
    expect(previewFor('text', null, null, { revoked: true })).toBe('[revoked]')
    expect(previewParts('[revoked]', '', tt).label).toBe('<revoked>')
    expect(previewFor('image', null, null, { albumCount: 4 })).toBe('[album:4]')
    expect(previewParts('[album:4]', '', tt).label).toBe('<album {"count":4}>')
    expect(previewFor('image', null, null, { albumCount: 1 })).toBe('[image]')
  })
  it('maps link', () => {
    expect(mapsUrl({ latitude: -23.5, longitude: -46.6 })).toBe('https://www.google.com/maps/search/?api=1&query=-23.5,-46.6')
  })
})
