import { describe, expect, it } from 'vitest'

import { splitLinks } from './linkify'

// Phase 5g, real account: "https://climest.reservio.com/" was plain text.
const links = (text: string) => splitLinks(text).filter((p) => 'link' in p)

describe('splitLinks (like WhatsApp)', () => {
  it('a URL is a link, the rest stays text', () => {
    expect(splitLinks('https://climest.reservio.com/')).toEqual([
      { link: 'https://climest.reservio.com/', href: 'https://climest.reservio.com/', kind: 'url' },
    ])
    expect(splitLinks('Veja https://www.instagram.com/reel/DedABtZNx8b/?srtk=Z2Z e me diga')).toEqual([
      { text: 'Veja ' },
      { link: 'https://www.instagram.com/reel/DedABtZNx8b/?srtk=Z2Z', href: 'https://www.instagram.com/reel/DedABtZNx8b/?srtk=Z2Z', kind: 'url' },
      { text: ' e me diga' },
    ])
  })

  it('www. without a scheme opens over https; the sentence punctuation is not part of it', () => {
    expect(links('acesse www.cert.com.br.')).toEqual([{ link: 'www.cert.com.br', href: 'https://www.cert.com.br', kind: 'url' }])
    expect(links('(ver https://a.com/x)')).toEqual([{ link: 'https://a.com/x', href: 'https://a.com/x', kind: 'url' }])
    expect(links('https://pt.wikipedia.org/wiki/Foo_(bar)')[0]).toMatchObject({ link: 'https://pt.wikipedia.org/wiki/Foo_(bar)' })
  })

  it('e-mails and phone numbers', () => {
    expect(links('Drive da conta luciana@certcertificados.com.')).toEqual([
      { link: 'luciana@certcertificados.com', href: 'mailto:luciana@certcertificados.com', kind: 'email' },
    ])
    expect(links('liga no +55 11 98765-4321 ou (62) 99842-3737')).toEqual([
      { link: '+55 11 98765-4321', href: 'tel:+5511987654321', kind: 'phone' },
      { link: '(62) 99842-3737', href: 'tel:+5562998423737', kind: 'phone' },
    ])
  })

  it('document numbers, dates and amounts stay text', () => {
    expect(links('CNPJ: 05.958.742/0001-48 em 08/09/2026, R$ 1.234,56, CEP 74030-040')).toEqual([])
  })

  it('an e-mail inside a URL is part of the URL', () => {
    expect(links('https://docs.google.com/x?u=ana@x.com')).toHaveLength(1)
  })
})
