import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  // a server with no meetings list (#98): the host calendar supplies the meetings
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'get_account', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => '[]' }) }
})
const openaiChat = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [{ text: 'Renewal is in March', source: 'opportunity: Renewal' }] }) }
  if (sys.includes('question the user typed')) return { role: 'assistant', content: JSON.stringify({ answer: 'March.', source: 'opportunity: Renewal' }) }
  return { role: 'assistant', content: '## Before you join\n- x' }
})
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-000000000001'

async function setup(extra: Record<string, unknown> = {}) {
  const { hookOle } = await import('../../src/main/ole/yogurt/session')
  const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
  const { setProviders } = await import('../../src/main/ole/yogurt/providers')
  const { setServers } = await import('../../src/main/ole/yogurt/servers')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-live-')), 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: 'openai' })
  setServers(file, [{ id: 'crm', name: 'CRM', url: 'https://crm.example/mcp' }])
  const appendNotes = vi.fn()
  const notify = vi.fn()
  const ole = hookOle({ file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, appendNotes, notify, ...extra })
  return { ole, file, appendNotes, notify }
}

beforeEach(() => { openaiChat.mockClear() })


import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildBulletsPrompt } from '../../src/main/ole/core/bullets'
import { EMPTY_MEMORY, fromOleNotes, savedCallMemory } from '../../src/main/ole/core/callSummary'
import { loudBullets, spotlight } from '../../src/main/ole/core/spotlight'
import { DIRECTIONS_MAX, DIRECTION_MAX } from '../../src/main/ole/core/steer'
import { quickNoteTarget } from '../../src/renderer/src/ole/oleTabs'
import { OleBullets } from '../../src/renderer/src/ole/OleBullets'

const live = () => handlers.get('ole:state')!() as { bullets: Array<{ id: string; note?: string; rating?: string }>; directions: string[] }

describe('steering a call (#174, #175, #176)', () => {
  it('the bullets prompt carries notes on bullets, muted topics and the directions given', () => {
    const p = buildBulletsPrompt({ context: null, lines: [], previous: [
      { id: 'b1', text: 'SSO is enterprise only', source: 'docs', at: 1, note: 'they have this' },
      { id: 'b2', text: 'Pricing tiers changed', source: 'docs', at: 2, rating: 'down' },
    ], directions: ["they're on AWS, not GCP"] })[1].content ?? ''
    expect(p).toContain('Direction from the user for this call (follow it):\n- they\'re on AWS, not GCP')
    expect(p).toContain('SSO is enterprise only (the user noted: "they have this")')
    expect(p).toContain('Pricing tiers changed (the user marked this not useful: give nothing more on its topic this call)')
  })

  it('note, mute and steer through the app, reach the next bullets turn, and reset for the next call', async () => {
    const { ole } = await setup()
    ole.meetingStarted({ id: ID, title: 'Acme renewal' })
    ole.segment({ meetingId: ID, track: 'them', text: 'when is the renewal again', startMs: 0 })
    await vi.waitFor(() => expect(live().bullets).toHaveLength(1), { timeout: 3000 })
    const id = live().bullets[0].id
    await handlers.get('ole:bullet:note')!({}, id, '  they have this  ')
    await handlers.get('ole:bullet:rate')!({}, id, 'down')
    await handlers.get('ole:steer')!({}, "  they're on AWS  ")
    await handlers.get('ole:steer')!({}, '   ')
    expect(live().bullets[0]).toMatchObject({ note: 'they have this', rating: 'down' })
    expect(handlers.has('ole:bullet:mute')).toBe(false)
    expect(live().directions).toEqual(["they're on AWS"])
    // Ask follows the directions at once (bullet turns are spaced out in time; their prompt is checked above)
    await handlers.get('ole:ask')!({}, 'what region are they in?')
    const askPrompt = openaiChat.mock.calls.map(c => (c[0] as { messages: Array<{ role: string; content: string }> }).messages).filter(m => m[0].content.includes('question the user typed')).at(-1)!.map(m => m.content).join('\n')
    expect(askPrompt).toContain("Direction from the user for this call (follow it):\n- they're on AWS")
    ole.meetingStopped(ID)
    expect(ole.notesInput(ID)).toContain("**Direction given during the call**\n- they're on AWS")
    ole.meetingStarted({ id: '00000000-0000-4000-8000-000000000002', title: 'Next' })
    expect(live().directions).toEqual([])
  })

  it('bad input is ignored and everything is capped', async () => {
    const { ole } = await setup()
    ole.meetingStarted({ id: ID, title: 'Acme renewal' })
    await handlers.get('ole:steer')!({}, 42)
    for (let i = 0; i < DIRECTIONS_MAX + 3; i++) await handlers.get('ole:steer')!({}, `d${i} ${'x'.repeat(DIRECTION_MAX)}`)
    expect(live().directions).toHaveLength(DIRECTIONS_MAX)
    expect(live().directions.every(d => d.length <= DIRECTION_MAX)).toBe(true)
    // the newest are kept
    expect(live().directions.at(-1)).toMatch(new RegExp(`^d${DIRECTIONS_MAX + 2} `))
    await handlers.get('ole:bullet:note')!({}, 'nope', 'x')
  })

  it('a thumbs-down bullet is never loud: it waits under Earlier, where the thumb can be taken back (#175)', () => {
    const bs = [{ id: 'a', text: 'A', source: 's', at: 2, act: true as const, rating: 'down' as const }, { id: 'b', text: 'B', source: 's', at: 1, act: true as const }]
    expect(spotlight(bs).now.map(b => b.id)).toEqual(['b'])
    expect(spotlight(bs).earlier.map(b => b.id)).toEqual(['a'])
    expect(loudBullets(bs).map(b => b.id)).toEqual(['b'])
  })

  it('directions are saved with the call and read back', () => {
    const m = savedCallMemory({ summary: 's', openQuestions: [], commitments: [], directions: ['focus on pricing', 7, ''] })!
    expect(m.directions).toEqual(['focus on pricing'])
    expect(fromOleNotes({ ...EMPTY_MEMORY, directions: ['focus on pricing'] })).toContain('**Direction given during the call**\n- focus on pricing')
  })

  it('a quick-note line starting with > goes to Ole, anything else to My notes', () => {
    expect(quickNoteTarget('> focus on pricing')).toEqual({ steer: 'focus on pricing' })
    expect(quickNoteTarget('>focus')).toEqual({ steer: 'focus' })
    expect(quickNoteTarget('>   ')).toBeNull()
    expect(quickNoteTarget('send the deck')).toEqual({ note: 'send the deck' })
  })

  it('a live bullet offers a note; there is no separate Not this, thumbs down is it', () => {
    const html = renderToStaticMarkup(createElement(OleBullets, { bullets: [{ id: 'a', text: 'A', source: 's', at: 1, note: 'they have this' }], prepared: null,
      onPin: () => {}, onRate: () => {}, onNote: () => {} }))
    expect(html).toContain('data-testid="ole-bullet-note"')
    expect(html).not.toContain('ole-bullet-mute')
    expect(html).toContain('nothing more on this topic this call')
    expect(html).toContain('they have this')
  })
})
