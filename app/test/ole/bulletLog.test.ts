import { describe, expect, it, vi } from 'vitest'
import { createBulletsEngine } from '../../src/main/ole/bullets'
import type { ChatFn } from '../../src/main/ole/bullets'

const ctx = { meetingTitle: 'Acme', focus: null, text: '## Deals\n- 120k (opportunity: Expansion)', preparedAt: 1 }

async function turn(chat: ChatFn) {
  const log = vi.fn()
  const engine = createBulletsEngine({ chat, tools: () => [], callTool: vi.fn(), context: () => ctx, onBullets: () => {}, minIntervalMs: 60_000, log })
  engine.push({ speaker: 'Them', text: 'secret customer words here', startMs: 0 })
  await vi.waitFor(() => expect(log).toHaveBeenCalled())
  engine.stop()
  return log.mock.calls[0][0] as string
}

describe('every bullet turn is logged (#59)', () => {
  it('says how many came back, were shown and were dropped, and why', async () => {
    const line = await turn(vi.fn<ChatFn>().mockResolvedValue({ content: JSON.stringify({ bullets: [
      { text: 'Deal is 120k', source: 'opportunity: Expansion' },
      { text: 'Vague', source: 'transcript' },
      { text: 'Deal is 120k', source: 'opportunity: Expansion' },
    ] }) }))
    expect(line).toBe('ole bullets: 3 back, 1 shown, 1 without a source, 1 repeated, 0 lookups')
  })
  it('an empty turn is logged too', async () => {
    expect(await turn(vi.fn<ChatFn>().mockResolvedValue({ content: '{"bullets":[]}' }))).toBe('ole bullets: 0 back, 0 shown, 0 without a source, 0 repeated, 0 lookups')
  })
  it('a failed turn logs the error, never the transcript', async () => {
    const line = await turn(vi.fn<ChatFn>().mockRejectedValue(new Error('429 rate limited')))
    expect(line).toBe('ole bullets: turn failed: 429 rate limited')
    expect(line).not.toContain('secret')
  })
})
