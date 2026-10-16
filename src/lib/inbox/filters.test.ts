import { describe, expect, it } from 'vitest'

import { filterOptionsFor } from './filters'

const values = (qrMode: boolean, hasGroups: boolean) => filterOptionsFor({ qrMode, hasGroups }, (k) => k).map((o) => o.value)

describe('inbox filters (phase 5f: WhatsApp order)', () => {
  it('QR mode: Todas, Não lidas, Grupos — always — then the CRM filters', () => {
    expect(values(true, false)).toEqual(['all', 'unread', 'groups', 'open', 'pending', 'closed'])
    expect(values(true, true)).toEqual(['all', 'unread', 'groups', 'open', 'pending', 'closed'])
  })
  it('official API: Grupos only once there is a group', () => {
    expect(values(false, false)).toEqual(['all', 'unread', 'open', 'pending', 'closed'])
    expect(values(false, true)).toEqual(['all', 'unread', 'groups', 'open', 'pending', 'closed'])
  })
})
