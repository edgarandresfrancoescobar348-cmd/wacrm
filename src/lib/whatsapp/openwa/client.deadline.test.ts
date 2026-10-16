// H2 (third review): a send's absolute deadline covers the SSRF/DNS
// guard too. Before, the timeout was computed BEFORE the guard and the
// fetch got a fresh window afterwards — 45 s budget + 20 s of DNS + 44 s
// of fetch was not a 45 s call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let guardDelayMs = 0
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: () => new Promise<boolean>((r) => setTimeout(() => r(true), guardDelayMs)),
}))

const { openWaSend } = await import('./client')
const { SendBudgetExceededError } = await import('@/lib/whatsapp/transport/types')

const creds = { baseUrl: 'http://gw.example.com', apiKey: 'k' }
let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})
afterEach(() => {
  fetchSpy.mockRestore()
  guardDelayMs = 0
})

describe('openWaSend — one absolute deadline (H2)', () => {
  it('a guard slower than the budget aborts before any fetch', async () => {
    guardDelayMs = 300
    fetchSpy.mockResolvedValue(new Response('{"messageId":"m"}', { status: 201 }))
    await expect(
      openWaSend(creds, 's', 'send-text', { chatId: '1@c.us', text: 'x' }, { sendBy: Date.now() + 100 }),
    ).rejects.toBeInstanceOf(SendBudgetExceededError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the fetch only gets what the guard left of the deadline', async () => {
    guardDelayMs = 200
    fetchSpy.mockImplementation(
      (_url: unknown, init: unknown) =>
        new Promise((_, reject) => {
          const signal = (init as RequestInit).signal!
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    )
    const started = Date.now()
    await expect(
      openWaSend(creds, 's', 'send-text', { chatId: '1@c.us', text: 'x' }, { sendBy: started + 400 }),
    ).rejects.toThrow()
    // Aborted at the absolute deadline (≈400 ms), not 200 + 400.
    expect(Date.now() - started).toBeLessThan(550)
  })
})
