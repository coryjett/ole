import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBulletsEngine, type ChatFn, type ChatMessage } from '../../src/main/ole/core/bullets'
import { createTurnRecorder, parseRecordedCall, TURNS_MAX, type RecordedTurn } from '../../src/main/ole/core/turnRecorder'
import { accountFromTitle, anonymizer, buildReplayFixture, exportFileName, type ExportSegment } from '../../src/main/ole/core/replayExport'
import { replayCall, virtualClock } from '../../src/main/ole/core/replay'
import { RESULT_CAP } from '../../src/main/ole/core/tools'
import type { OleBullet, OleTool, PreparedContext } from '../../src/main/ole/core/types'
import { exportMessage, OleExportReplayView } from '../../src/renderer/src/ole/OleSavedBullets'

const user = (content = 'Now: …'): ChatMessage[] => [{ role: 'system', content: 'sys' }, { role: 'user', content }]
const tool = (name: string): OleTool => ({ name, serverId: name.split('__')[0], serverName: 'Docs', tool: name.split('__')[1], description: '', parameters: { type: 'object', properties: { query: { type: 'string' } } } })
const offered = [{ type: 'function', function: { name: 'docs__search_docs' } }]

describe('recording bullets turns (#70)', () => {
  it('keeps each turn: when it started, the replies, each lookup result and the latency', async () => {
    let t = 1_000
    const replies = [
      { content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'docs__search_docs', arguments: '{"query":"mtls"}' } }, { id: 'c2', type: 'function' as const, function: { name: 'docs__search_docs', arguments: '{"query":"again"}' } }] },
      { content: '{"bullets":[{"text":"x","source":"docs"}]}' },
    ]
    const rec = createTurnRecorder({
      startedAt: 1_000, now: () => t,
      chat: async () => { t += 250; return replies.shift()! },
      callTool: async () => 'Certs rotate daily',
    })
    t = 46_000
    const r1 = await rec.chat({ messages: user(), tools: offered })
    // the engine makes the first lookup; the second it refused (a repeat, say), so it never reached the server
    expect(await rec.callTool('docs__search_docs', '{"query":"mtls"}')).toBe('Certs rotate daily')
    await rec.chat({ messages: [...user(), { role: 'assistant', content: null, tool_calls: r1.tool_calls }, { role: 'tool', tool_call_id: 'c1', content: 'Certs rotate daily' }] })
    expect(rec.recorded()).toEqual({
      tools: ['docs__search_docs'],
      turns: [{ atMs: 45_000, replies: [
        { toolCalls: [{ name: 'docs__search_docs', arguments: { query: 'mtls' }, result: 'Certs rotate daily' }, { name: 'docs__search_docs', arguments: { query: 'again' } }], latencyMs: 250 },
        { content: '{"bullets":[{"text":"x","source":"docs"}]}', latencyMs: 250 },
      ] }],
    })
  })

  it('a failed reply is kept as its kind, never its text, and still fails', async () => {
    const rec = createTurnRecorder({ chat: async () => { throw new Error('OpenAI said (429): slow down, key sk-abc123') }, callTool: async () => '' })
    await expect(rec.chat({ messages: user() })).rejects.toThrow('429')
    expect(rec.recorded().turns[0].replies).toEqual([{ error: 'http 429', latencyMs: expect.any(Number) }])
    expect(JSON.stringify(rec.recorded())).not.toContain('sk-abc')
  })

  it('a lookup that throws is kept as "lookup failed" and still throws', async () => {
    const rec = createTurnRecorder({
      chat: async () => ({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'docs__search_docs', arguments: '{}' } }] }),
      callTool: async () => { throw new Error('down') },
    })
    await rec.chat({ messages: user() })
    await expect(rec.callTool('docs__search_docs', '{}')).rejects.toThrow('down')
    expect(rec.recorded().turns[0].replies[0].toolCalls?.[0].result).toBe('lookup failed')
  })

  it('stops keeping turns at the cap and cuts long results', async () => {
    const big = 'r'.repeat(RESULT_CAP * 2)
    const rec = createTurnRecorder({ max: 2, chat: async () => ({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'a__get_x', arguments: '{}' } }] }), callTool: async () => big })
    for (let i = 0; i < 4; i++) { await rec.chat({ messages: user() }); await rec.callTool('a__get_x', '{}') }
    const turns = rec.recorded().turns
    expect(turns).toHaveLength(2)
    expect(turns[0].replies[0].toolCalls![0].result!.length).toBeLessThanOrEqual(RESULT_CAP + 20)
    expect(TURNS_MAX).toBe(300)
  })

  it('reads a saved file back, keeping only well-formed parts', () => {
    expect(parseRecordedCall(null)).toBeNull()
    expect(parseRecordedCall({ version: 2, turns: [] })).toBeNull()
    expect(parseRecordedCall({ version: 1, tools: ['a__get_x', 3], turns: [{ atMs: 5, replies: [{ content: 'c', latencyMs: -1, error: 'network' }, 'junk'] }, 7], briefing: { meetingTitle: 'T', focus: 9 } })).toEqual({
      version: 1, tools: ['a__get_x'], briefing: { meetingTitle: 'T', focus: null },
      turns: [{ atMs: 5, replies: [{ content: 'c', error: 'network', latencyMs: 0 }] }],
    })
  })
})

const segs: ExportSegment[] = [
  { track: 'me', speaker: null, text: 'Thanks for joining, Sam.', startMs: 0, endMs: 2_000 },
  { track: 'them', speaker: 'Sam Okafor', text: 'Copperline Parcel wants daily rotation. See https://wiki.example.com/rotation or mail sam@copperline.example', startMs: 20_000, endMs: 24_000 },
  { track: 'them', speaker: 'Priya Nair', text: 'And Sam asked about rate limits.', startMs: 40_000, endMs: 43_000 },
  { track: 'them', speaker: 'Priya Nair', text: '   ', startMs: 50_000, endMs: 51_000 },
]
const briefingText = '## Who\n- Sam Okafor at Copperline Parcel, security review (https://crm.example.com/acct/1)\n## Deals\n- copperline parcel pilot'
const turns: RecordedTurn[] = [{ atMs: 45_000, replies: [
  { toolCalls: [{ name: 'docs__search_docs', arguments: { query: 'Copperline Parcel rotation' }, result: 'Rotates every 24h (https://docs.example.com/mtls). Owner: Priya Nair' }], latencyMs: 900 },
  { content: '{"bullets":[{"text":"Sam wants daily rotation","source":"docs","url":"https://docs.example.com/mtls"}]}', latencyMs: 1200 },
] }]

describe('a saved call as a replay fixture (#70)', () => {
  it('is in the harness format: transcript lines, briefing, tools, turns, end', () => {
    const f = buildReplayFixture({ name: 'ole-replay-2026-11-20', meetingTitle: 'Copperline Parcel: security review', segments: segs, briefing: { text: briefingText, meetingTitle: 'Copperline Parcel: security review', focus: 'mTLS' }, tools: ['docs__search_docs'], turns })
    expect(f).toEqual({
      name: 'ole-replay-2026-11-20',
      briefing: { meetingTitle: 'Copperline Parcel: security review', focus: 'mTLS', text: briefingText },
      tools: ['docs__search_docs'],
      transcript: [
        { speaker: 'Me', text: 'Thanks for joining, Sam.', startMs: 0 },
        { speaker: 'Sam Okafor', text: segs[1].text, startMs: 20_000 },
        { speaker: 'Priya Nair', text: 'And Sam asked about rate limits.', startMs: 40_000 },
      ],
      turns: [{ replies: [
        { toolCalls: [{ name: 'docs__search_docs', arguments: { query: 'Copperline Parcel rotation' }, result: turns[0].replies[0].toolCalls![0].result }], latencyMs: 900 },
        { content: turns[0].replies[1].content, latencyMs: 1200 },
      ] }],
      endMs: 43_000,
    })
  })

  it('without recorded turns (a call from before they were kept) it has the transcript and briefing only, for --live', () => {
    const f = buildReplayFixture({ name: 'x', meetingTitle: 'Weekly sync', segments: segs, briefing: { text: '' }, tools: [] })
    expect(f.turns).toEqual([])
    expect(f.transcript).toHaveLength(3)
  })

  it('anonymized: speakers become Speaker 1, 2…, the account and title become Account, links and addresses are replaced', () => {
    const f = buildReplayFixture({ name: 'x', meetingTitle: 'Copperline Parcel: security review', attendees: [{ name: 'Sam Okafor', email: 'sam@copperline.example' }, { name: 'Lee Grant' }], segments: segs, briefing: { text: briefingText, meetingTitle: 'Copperline Parcel: security review', focus: 'Copperline Parcel renewal' }, tools: ['docs__search_docs'], turns, anonymize: true })
    expect(f.transcript.map(l => l.speaker)).toEqual(['Me', 'Speaker 1', 'Speaker 2'])
    expect(f.transcript.map(l => l.text)).toEqual(['Thanks for joining, Speaker 1.', 'Account wants daily rotation. See https://example.com/link-2 or mail [email]', 'And Speaker 1 asked about rate limits.'])
    expect(f.briefing).toEqual({ meetingTitle: 'Account', focus: 'Account renewal', text: '## Who\n- Speaker 1 at Account, security review (https://example.com/link-1)\n## Deals\n- Account pilot' })
    const call = f.turns[0].replies[0].toolCalls![0]
    expect(call.arguments).toEqual({ query: 'Account rotation' })
    expect(call.result).toBe('Rotates every 24h (https://example.com/link-3). Owner: Speaker 2')
    expect(f.turns[0].replies[1].content).toBe('{"bullets":[{"text":"Speaker 1 wants daily rotation","source":"docs","url":"https://example.com/link-3"}]}')
    const all = JSON.stringify(f)
    for (const gone of ['Sam', 'Okafor', 'Priya', 'Copperline', 'wiki.', 'docs.', 'crm.', '@']) expect(all).not.toContain(gone)
  })

  it('a default title ("Meeting", "Zoom call") is not treated as a name; only a title with a separator gives an account', () => {
    const a = anonymizer({ meetingTitle: 'Zoom call', speakers: [], attendees: [] })
    expect(a.text('This meeting is a Zoom call')).toBe('This meeting is a Zoom call')
    expect(accountFromTitle('Copperline Parcel: security review')).toBe('Copperline Parcel')
    expect(accountFromTitle('Copperline <> Us')).toBe('Copperline')
    expect(accountFromTitle('Copperline - weekly')).toBe('Copperline')
    expect(accountFromTitle('Weekly sync')).toBeNull()
    expect(exportFileName(new Date(2026, 10, 20, 9).getTime())).toBe('ole-replay-2026-11-20.json')
  })
})

describe('record a call, export it, replay it (#70 with #66)', () => {
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r)) }
  const lines = [
    { speaker: 'Sam Okafor', text: 'How often do you rotate the mutual TLS certificates?', startMs: 0 },
    { speaker: 'Me', text: 'Let me check that.', startMs: 20_000 },
    { speaker: 'Sam Okafor', text: 'We need daily rotation for our auditors at Copperline Parcel.', startMs: 50_000 },
    { speaker: 'Me', text: 'Understood.', startMs: 100_000 },
    { speaker: 'Sam Okafor', text: 'Next, rate limits.', startMs: 140_000 },
  ]
  const context: PreparedContext = { meetingTitle: 'Copperline Parcel: security review', focus: null, text: '## Who\n- Sam Okafor at Copperline Parcel', preparedAt: 0 }

  async function recordLive() {
    const clock = virtualClock()
    let turn = 0
    // a scripted model: turn 1 looks up and answers with a link from the result, turn 2 answers, turn 3 fails, then nothing new
    const model: ChatFn = async (req) => {
      const afterLookup = req.messages.some(m => m.role === 'tool')
      if (!afterLookup) turn++
      if (turn === 1 && !afterLookup) return { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'docs__search_docs', arguments: '{"query":"mtls rotation"}' } }] }
      if (turn === 1) return { content: JSON.stringify({ bullets: [{ text: 'Certs rotate every 24h by default', source: 'docs: rotation', heard: 'rotate the mutual TLS certificates', quote: 'rotate every 24 hours by default', url: 'https://docs.example.com/mtls' }] }) }
      if (turn === 2) return { content: JSON.stringify({ bullets: [{ text: 'Daily rotation meets their audit need', source: 'docs: rotation' }] }) }
      if (turn === 3) throw new Error('request failed (503)')
      return { content: '{"bullets":[]}' }
    }
    const rec = createTurnRecorder({ chat: model, callTool: async () => 'Certificates rotate every 24 hours by default (https://docs.example.com/mtls)', now: clock.now, startedAt: 0 })
    let shown: OleBullet[] = []
    const engine = createBulletsEngine({ chat: rec.chat, callTool: rec.callTool, tools: () => [tool('docs__search_docs')], context: () => context, onBullets: all => { shown = all }, log: () => {}, now: clock.now, timers: clock.timers })
    for (const l of lines) { await clock.advanceTo(l.startMs, settle); engine.push(l); await settle() }
    await clock.advanceTo(150_000, settle)
    engine.stop()
    await settle()
    return { shown, recorded: rec.recorded() }
  }

  it('the replay shows what the call showed', async () => {
    const live = await recordLive()
    expect(live.shown.map(b => b.text)).toEqual(['Daily rotation meets their audit need', 'Certs rotate every 24h by default'])
    expect(live.recorded.turns.map(t => t.atMs)).toEqual([0, 45_000, 90_000, 135_000])
    const segments = lines.map(l => ({ track: l.speaker === 'Me' ? 'me' as const : 'them' as const, speaker: l.speaker === 'Me' ? null : l.speaker, text: l.text, startMs: l.startMs, endMs: l.startMs + 3_000 }))
    const input = { name: 'round-trip', meetingTitle: context.meetingTitle!, segments, briefing: { text: context.text, meetingTitle: context.meetingTitle }, tools: live.recorded.tools, turns: live.recorded.turns }

    const report = await replayCall(buildReplayFixture(input))
    expect(report.turns).toEqual({ total: 4, failed: 1, unrecorded: 0, fast: 0 })
    expect(report.timeline.find(t => t.failed)?.failed).toBe('http 503')
    expect(report.shown.map(s => s.text)).toEqual(['Certs rotate every 24h by default', 'Daily rotation meets their audit need'])
    expect(report.lookups).toEqual({ asked: 1, made: 1, refused: 0, unrecorded: 0 })
    expect(report.excerpts).toEqual({ heard: { given: 1, verified: 1 }, quote: { given: 1, verified: 1 }, url: { given: 1, kept: 1 } })

    // anonymized, the same replacements run everywhere, so the excerpts and the link still check out
    const anon = await replayCall(buildReplayFixture({ ...input, anonymize: true }))
    expect(anon.bullets).toEqual(report.bullets)
    expect(anon.excerpts).toEqual(report.excerpts)
    expect(anon.turns).toEqual(report.turns)
  })
})

describe('Export for replay on a saved meeting (#70)', () => {
  const view = (p: Partial<Parameters<typeof OleExportReplayView>[0]> = {}) => renderToStaticMarkup(createElement(OleExportReplayView, { anonymize: true, busy: false, result: null, onAnonymize: () => {}, onExport: () => {}, ...p }))
  it('has the button, Anonymize checked by default, and the note', () => {
    const html = view()
    expect(html).toContain('Export for replay')
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
    expect(html).toContain('Anonymize')
    expect(html).toContain('Saves the call&#x27;s transcript and Ole&#x27;s turns to a file for the replay tool. Anonymize replaces names and removes links.')
    expect(html).not.toContain('ole-export-replay-result')
  })
  it('says how it went', () => {
    expect(view({ busy: true })).toContain('Exporting…')
    expect(view({ result: { status: 'saved', turns: 12 } })).toContain('Saved, with 12 of Ole&#x27;s turns.')
    expect(view({ result: { status: 'saved', turns: 0 } })).toContain('replay it with --live')
    expect(view({ result: { status: 'failed', error: "Couldn't write the file." } })).toContain('Couldn&#x27;t export: Couldn&#x27;t write the file.')
    expect(view({ result: { status: 'cancelled', turns: 3 } })).not.toContain('ole-export-replay-result')
    expect(exportMessage({ status: 'cancelled', turns: 0 })).toBe('')
  })
})
