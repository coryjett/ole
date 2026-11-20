import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RecordedCall } from '../../src/main/ole/core/turnRecorder'
import type { ReplayFixture } from '../../src/main/ole/core/replayFormat'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}))
vi.mock('../../src/main/ole/core/mcp', async (orig) => {
  const real = await orig<typeof import('../../src/main/ole/core/mcp')>()
  return { ...real, createMcpClient: () => ({ listTools: async () => [{ name: 'search_docs', inputSchema: { type: 'object' } }], listPrompts: async () => [], getPrompt: async () => '', callTool: async () => 'Rotates daily, see https://docs.example.com/a' }) }
})
const openaiChat = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
  const sys = req.messages[0].content
  if (sys.includes('surfacing short context bullets')) return { role: 'assistant', content: JSON.stringify({ bullets: [{ text: 'Renewal is in March', source: 'opportunity: Renewal' }] }) }
  return { role: 'assistant', content: '## Before you join\n- Dana Reyes owns the renewal' }
})
vi.mock('../../src/main/ole/core/openai', () => ({ openaiChat }))

const ID = '00000000-0000-4000-8000-0000000000aa'
const OLD = '00000000-0000-4000-8000-0000000000bb'

async function setup() {
  const { hookOle } = await import('../../src/main/ole/yogurt/session')
  const { writeSecret } = await import('../../src/main/ole/yogurt/secrets')
  const { setProviders } = await import('../../src/main/ole/yogurt/providers')
  const { setServers } = await import('../../src/main/ole/yogurt/servers')
  const file = join(mkdtempSync(join(tmpdir(), 'ole-export-')), 'settings.json')
  writeSecret(file, 'openai', 'sk-test-123456')
  setProviders(file, { assistant: 'openai' })
  setServers(file, [{ id: 'docs', name: 'Docs', url: 'https://docs.example/mcp' }])
  const saved = new Map<string, RecordedCall>()
  const saveTurns = vi.fn((id: string, c: RecordedCall) => { saved.set(id, JSON.parse(JSON.stringify(c))) })
  const written: Array<{ name: string; content: string }> = []
  let answer: 'saved' | 'cancelled' | 'failed' = 'saved'
  const saveExport = vi.fn(async (name: string, content: string) => { written.push({ name, content }); return answer })
  const meeting = (id: string) => id === ID || id === OLD ? {
    title: 'Copperline Parcel: renewal', startedAt: new Date(2026, 10, 19, 10).getTime(), attendees: [{ name: 'Dana Reyes', email: 'dana@copperline.example' }],
    segments: [{ track: 'them' as const, speaker: 'Dana Reyes', text: 'When is the renewal for Copperline Parcel?', startMs: 0, endMs: 3_000 }],
  } : null
  const ole = hookOle({
    file, send: () => {}, checkEveryMs: 0, autoEveryMs: 0, saveTurns, saveExport, meetingForExport: meeting,
    loadTurns: (id) => id === OLD ? null : saved.get(id) ?? null,
    loadBriefing: (id) => id === OLD ? '## Who\n- Dana Reyes' : '',
  })
  return { ole, saveTurns, written, setAnswer: (a: typeof answer) => { answer = a } }
}
const exportReplay = (id: unknown, o?: unknown) => handlers.get('ole:export-replay')!({}, id, o) as Promise<{ status: string; turns?: number; error?: string }>

describe('a call keeps its bullets turns and exports as a replay fixture (#70)', () => {
  it('records the turns, saves them when the call stops, and exports them anonymised by default', async () => {
    const { ole, saveTurns, written } = await setup()
    ole.meetingStarted({ id: ID, title: 'Copperline Parcel: renewal' })
    ole.segment({ meetingId: ID, track: 'them', speaker: 'Dana Reyes', text: 'When is the renewal for Copperline Parcel?', startMs: 0 })
    await vi.waitFor(() => expect(ole.bulletsOf(ID)).toHaveLength(1), { timeout: 3000 })
    // not while it records
    expect(await exportReplay(ID)).toMatchObject({ status: 'failed', error: expect.stringContaining('still recording') })
    ole.meetingStopped(ID)
    expect(saveTurns).toHaveBeenCalledTimes(1)
    const call = saveTurns.mock.calls[0][1]
    expect(call.version).toBe(1)
    expect(call.turns.length).toBeGreaterThanOrEqual(1)
    expect(call.turns[0].replies.at(-1)?.content).toContain('Renewal is in March')

    expect(await exportReplay(ID)).toEqual({ status: 'saved', turns: call.turns.length })
    expect(written[0].name).toBe('ole-replay-2026-11-19.json')
    const f = JSON.parse(written[0].content) as ReplayFixture
    expect(f.name).toBe('ole-replay-2026-11-19')
    expect(f.transcript).toEqual([{ speaker: 'Speaker 1', text: 'When is the renewal for Account?', startMs: 0 }])
    expect(f.turns).toHaveLength(call.turns.length)
    expect(written[0].content).not.toMatch(/Dana|Reyes|Copperline/)

    // Anonymise off: as said
    await exportReplay(ID, { anonymise: false })
    expect((JSON.parse(written[1].content) as ReplayFixture).transcript[0].speaker).toBe('Dana Reyes')
  })

  it('a call from before turns were kept exports the transcript and briefing only', async () => {
    const { written } = await setup()
    expect(await exportReplay(OLD, { anonymise: false })).toEqual({ status: 'saved', turns: 0 })
    const f = JSON.parse(written[0].content) as ReplayFixture
    expect(f.turns).toEqual([])
    expect(f.briefing).toEqual({ meetingTitle: 'Copperline Parcel: renewal', focus: null, text: '## Who\n- Dana Reyes' })
  })

  it('checks the meeting id and reports a cancelled or failed save', async () => {
    const { written, setAnswer } = await setup()
    expect(await exportReplay('../../etc')).toMatchObject({ status: 'failed' })
    expect(await exportReplay(42)).toMatchObject({ status: 'failed' })
    expect(await exportReplay('00000000-0000-4000-8000-0000000000cc')).toEqual({ status: 'failed', error: "Couldn't find this meeting." })
    expect(written).toHaveLength(0)
    setAnswer('cancelled')
    expect(await exportReplay(OLD)).toEqual({ status: 'cancelled', turns: 0 })
    setAnswer('failed')
    expect(await exportReplay(OLD)).toEqual({ status: 'failed', error: "Couldn't write the file." })
  })
})
