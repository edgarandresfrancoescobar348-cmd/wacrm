// Test helper (phase 6): the account's official business number, for
// unit tests whose fakes don't model `whatsapp_connections`. Use it from a
// `vi.mock` factory:
//
//   vi.mock('@/lib/whatsapp/connections', async (orig) =>
//     (await import('@/test/business-number')).connectionsMock(await orig()))
//   vi.mock('@/lib/whatsapp/transport', async (orig) =>
//     (await import('@/test/business-number')).transportMock(await orig()))

import type { WaConnection } from '@/lib/whatsapp/connections'

export const OFFICIAL_NUMBER: WaConnection = {
  id: 'num-official',
  accountId: 'acc',
  provider: 'meta',
  scope: 'business',
  ownerUserId: null,
  label: null,
  status: 'connected',
  phone: null,
  connectedAt: null,
  mirrorInboundMedia: true,
  createdBy: 'user',
  removedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
}

/** Every business-number lookup answers the official number. */
export function connectionsMock(real: Record<string, unknown>) {
  return {
    ...real,
    pickBusinessConnection: async () => OFFICIAL_NUMBER,
    loadConnection: async () => OFFICIAL_NUMBER,
  }
}

/** A number's transport is a Meta transport with fixed credentials. */
export async function transportMock(real: typeof import('@/lib/whatsapp/transport')) {
  const { createMetaTransport } = await import('@/lib/whatsapp/transport/meta')
  return {
    ...real,
    loadConnectionTransport: async (connection: WaConnection | string | undefined) => ({
      connection: connection && typeof connection === 'object' ? connection : OFFICIAL_NUMBER,
      transport: createMetaTransport({ phoneNumberId: 'pn-1', accessToken: 'plain-access-token' }),
    }),
  }
}
