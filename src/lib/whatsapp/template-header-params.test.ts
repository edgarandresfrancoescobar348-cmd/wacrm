// Header params on the public API: the shared parser/check, and what each
// transport does with the value (Meta: a header component; QR: rendered).
import { describe, expect, it } from 'vitest'

import { parseApiTemplateParams, templateHeaderTextMissing } from './template-body'
import { buildSendComponents } from './template-send-builder'
import { renderLocalTemplate } from './template-local-render'
import type { MessageTemplate } from '@/types'

const ROW = {
  id: 't', user_id: 'u', name: 'pedido', category: 'Utility', language: 'pt_BR',
  header_type: 'text', header_content: 'Pedido {{1}}',
  body_text: 'Olá {{1}}', created_at: '2026-01-01T00:00:00Z',
} as unknown as MessageTemplate

describe('parseApiTemplateParams', () => {
  it('accepts the two shapes the API documents', () => {
    expect(parseApiTemplateParams(undefined)).toEqual({ body: [] })
    expect(parseApiTemplateParams(['a', 'b'])).toEqual({ body: ['a', 'b'] })
    expect(parseApiTemplateParams({ body: ['a'], headerText: '#1' })).toEqual({ body: ['a'], headerText: '#1' })
    expect(parseApiTemplateParams({ headerText: '#1' })).toEqual({ body: [], headerText: '#1' })
  })
  it('rejects anything else', () => {
    expect(parseApiTemplateParams('a')).toBeNull()
    expect(parseApiTemplateParams([1])).toBeNull()
    expect(parseApiTemplateParams({ body: 'a' })).toBeNull()
    expect(parseApiTemplateParams({ headerText: 5 })).toBeNull()
  })
  it('treats a blank headerText as absent', () => {
    expect(parseApiTemplateParams({ body: [], headerText: '  ' })).toEqual({ body: [] })
  })
})

describe('templateHeaderTextMissing', () => {
  it('only for a TEXT header with a variable and no value', () => {
    expect(templateHeaderTextMissing(ROW, {})).toBe(true)
    expect(templateHeaderTextMissing(ROW, { headerText: ' ' })).toBe(true)
    expect(templateHeaderTextMissing(ROW, { headerText: '#1' })).toBe(false)
    expect(templateHeaderTextMissing({ ...ROW, header_content: 'Pedido' }, {})).toBe(false)
    expect(templateHeaderTextMissing({ ...ROW, header_type: 'image' } as MessageTemplate, {})).toBe(false)
    expect(templateHeaderTextMissing(null, {})).toBe(false)
  })
})

describe('the header value on each transport', () => {
  it('Meta: a header component with the text parameter', () => {
    expect(buildSendComponents(ROW, { body: ['Ana'], headerText: '#101' })).toContainEqual({
      type: 'header',
      parameters: [{ type: 'text', text: '#101' }],
    })
  })
  it('QR: rendered into the header line, no literal {{1}}', () => {
    const { text } = renderLocalTemplate(ROW, { headerText: '#101', legacyBody: ['Ana'] })
    expect(text).toContain('*Pedido #101*')
    expect(text).not.toContain('{{1}}')
  })
})
