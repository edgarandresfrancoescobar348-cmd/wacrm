import { describe, expect, it } from 'vitest'

import { filterOptionsFor } from './filters'

const values = (qrMode: boolean, hasGroups: boolean) => filterOptionsFor({ qrMode, hasGroups }, (k) => k).map((o) => o.value)

describe('inbox filters (phase 5f: WhatsApp order)', () => {
  it('QR mode: Todas, Não lidas, Grupos — always — then the CRM filters (upstream\'s waiting / unassigned / expiring first)', () => {
    expect(values(true, false)).toEqual(['all', 'unread', 'groups', 'waiting', 'unassigned', 'expiring', 'open', 'pending', 'closed'])
    expect(values(true, true)).toEqual(['all', 'unread', 'groups', 'waiting', 'unassigned', 'expiring', 'open', 'pending', 'closed'])
  })
  it('official API: Grupos only once there is a group', () => {
    expect(values(false, false)).toEqual(['all', 'unread', 'waiting', 'unassigned', 'expiring', 'open', 'pending', 'closed'])
    expect(values(false, true)).toEqual(['all', 'unread', 'groups', 'waiting', 'unassigned', 'expiring', 'open', 'pending', 'closed'])
  })
})
