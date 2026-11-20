// Ole: the live call companion. Before the call, the model gathers a briefing from the MCP servers' read-only tools
// (prepare.ts); during it, context bullets from the transcript, the briefing and throttled tool lookups (bullets.ts).
import { ipcMain } from 'electron'
import type { McpServerConfig, OleAnswer, OleBullet, OleCallMemory, OleTool, PreparedContext } from './types'
import type { OleLiveState } from '../../shared/types'
import { loadSettings } from '../settings'
import { readSecret } from './secrets'
import { providersOf } from './providers'
import { serversOf } from './servers'
import { openaiChat } from './openaiModel'
import { createMcpClient, McpError } from './mcp'
import { boundedSchema, collectTools, collectWarmupPrompts, createToolRunner, isLiveTool, isReadOnly, type Unavailable } from './tools'
import { prepareContext } from './prepare'
import { genericTitle } from '../titles'
import { createLocalChat, type LocalRun } from './localChat'
import { createBulletsEngine, generalTools, hasMatchedRecord, pinnedNotes, type BulletsEngine, type ChatFn } from './bullets'
import { answerQuestion } from './ask'
import { eventNow, pickAutoPrepare, type Upcoming } from './calendarMatch'
import { feedbackOf, recordRating } from './feedback'
import { createTurnRecorder, type RecordedCall } from './turnRecorder'
import { createCallSummarizer, EMPTY_MEMORY, fromOleNotes, isEmptyMemory } from './callSummary'
import { buildReplayFixture, exportFileName, type ExportSegment } from './replayExport'
import type { OleExportResult } from '../../shared/types'

/** a prepared briefing older than this is gathered again when a meeting starts */
const STALE_MS = 2 * 60 * 60_000

type Deps = {
  file: string; send: (s: OleLiveState) => void; save?: (meetingId: string, bullets: OleBullet[]) => void
  /** a finished meeting's bullets from disk (Ole was restarted since) */
  load?: (meetingId: string) => OleBullet[]
  /** the briefing a meeting had when it ended, saved with it and read back (#35) */
  saveBriefing?: (meetingId: string, text: string) => void
  loadBriefing?: (meetingId: string) => string
  /** the call's summary, open questions and commitments (#82), saved with the meeting and read back */
  saveCall?: (meetingId: string, memory: OleCallMemory) => void
  loadCall?: (meetingId: string) => OleCallMemory | null
  /** a macOS notification, for a server that just stopped working (#33) */
  notify?: (title: string, body: string) => void
  /** how often the servers are checked in the background; 0 turns the background check off (tests) */
  checkEveryMs?: number
  /** adds markdown to the end of a meeting's own notes, so pinned bullets (#54) and Ole's record of the call (#83) reach the summary */
  appendNotes?: (meetingId: string, md: string) => void
  /** a meeting's questions and answers (#53), saved with it and read back */
  saveAnswers?: (meetingId: string, answers: OleAnswer[]) => void
  loadAnswers?: (meetingId: string) => OleAnswer[]
  /** calendar events between two times (#52, #56); without it Ole never reads the calendar */
  upcoming?: (fromMs: number, toMs: number) => Promise<Upcoming[]>
  /** the user's own notes for a meeting, read at each bullets turn and Ask (#77) */
  notes?: (meetingId: string) => string
  /** how much new conversation updates the running summary; default 3 minutes, 0 updates on every line (tests) */
  summaryEveryMs?: number
  /** how often auto-prepare looks at the calendar; 0 turns the timer off (tests) */
  autoEveryMs?: number
  /** the call's bullets turns (#70), saved with it on this Mac and read back for Export for replay */
  saveTurns?: (meetingId: string, call: RecordedCall) => void
  loadTurns?: (meetingId: string) => RecordedCall | null
  /** a saved meeting's title, start, attendees and transcript, for Export for replay (#70); null when it is gone */
  meetingForExport?: (meetingId: string) => { title: string; startedAt: number; attendees: Array<{ name: string; email?: string | null }>; segments: ExportSegment[] } | null
  /** shows the save panel with this file name and writes the content where the person picks */
  saveExport?: (defaultName: string, content: string) => Promise<'saved' | 'cancelled' | 'failed'>
}

/** a question is cut to this */
const QUESTION_MAX = 500
const ID = /^[0-9a-f-]{36}$/i

export function hookOle(d: Deps): {
  meetingStarted(m: { id: string; title: string }): void
  /** the recording was renamed (calendar match or the person): a briefing from a default title is prepared again once (#44) */
  meetingRenamed(m: { id: string; title: string }): void
  meetingStopped(id: string): void
  segment(seg: { meetingId: string; track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number }): void
  bulletsOf(id: string): OleBullet[]
  /** hands over the Mac's own model for Prepare once Yogurt's notes queue exists (#5) */
  setLocal(run: LocalRun): void
  /** check the MCP servers now (at startup, on a timer, on wake), so a broken one is found before the call (#33) */
  checkServers(): Promise<void>
  /** prepare for a calendar meeting about to start, once per event (#52) */
  autoPrepare(): Promise<void>
} {
  let prepared: PreparedContext | null = null
  let preparing = false
  let error: string | null = null
  let meetingId: string | null = null
  let engine: BulletsEngine | null = null
  let summarizer: ReturnType<typeof createCallSummarizer> | null = null
  /** the user's notes, empty on any failure: a notes read never breaks a turn (#77) */
  const notesNow = (id: string) => { try { return d.notes?.(id) ?? '' } catch { return '' } }
  let bullets: OleBullet[] = []
  let tools: OleTool[] = []
  /** enabled servers that failed the last time tools were loaded (#33) */
  let unavailable: Unavailable[] = []
  let call: (name: string, argsJson: string) => Promise<string> = async () => 'No MCP tools are available'
  let prepareSeq = 0
  /** the call's briefing came from a default title, so a real title prepares it once more (#44) */
  let preparedFromDefault = false
  /** the briefing came from auto-prepare for this calendar title (#52) */
  let autoTitle: string | null = null
  /** live bullets and Ask get the lookup-style tools only (#15), and no single-record lookups on a call with no matching record (#57) */
  const liveTools = () => { const live = tools.filter(isLiveTool); return hasMatchedRecord(prepared) ? live : generalTools(live) }
  /** calendar events already auto-prepared */
  const autoDone = new Set<string>()
  let answers: OleAnswer[] = []
  let answerSeq = 0
  const finishedAnswers = new Map<string, OleAnswer[]>()
  const finished = new Map<string, OleBullet[]>()
  const finishedBriefings = new Map<string, string>()
  const finishedCalls = new Map<string, OleCallMemory>()
  /** the call's bullets turns as they happen (#70); kept in memory, saved with the meeting when it stops */
  let recorder: ReturnType<typeof createTurnRecorder> | null = null
  const finishedTurns = new Map<string, RecordedCall>()

  /** the Mac's own model for Prepare (#5), handed over once Yogurt's notes queue exists */
  let local: LocalRun | null = null
  /** why live context is off, or null when it can run: it needs the Assistant on OpenAI with a key, or a Custom server (#11, #17) */
  const liveBlocked = (): string | null => {
    const p = providersOf(loadSettings(d.file))
    if (p.assistant === 'local') return 'Prepare and live context use OpenAI or your own server, with your MCP servers. Set Assistant to OpenAI or Custom server in Settings > Ole.'
    if (p.assistant === 'openai' && !openaiKey()) return 'Add an OpenAI key in Settings > Ole to prepare for calls.'
    if (p.assistant === 'custom' && !p.customBaseUrl) return 'Add the Custom server address in Settings > Ole to prepare for calls.'
    return null
  }
  /** why Prepare is off: on the local model only before a call and once it is ready (#5), otherwise as live context */
  const blocked = (): string | null => {
    if (providersOf(loadSettings(d.file)).prepareOn !== 'local') return liveBlocked()
    if (!local) return 'The local model is still starting.'
    if (meetingId) return 'Prepare on this Mac runs before a call, not during one.'
    return null
  }
  const state = (): OleLiveState => {
    // open questions and commitments of the call on now (#82)
    const memory = summarizer?.memory() ?? EMPTY_MEMORY
    return {
    meetingId, preparing, error, bullets, answers, blocked: blocked(), unavailable,
    openQuestions: memory.openQuestions, commitments: memory.commitments,
    prepared: prepared ? { meetingTitle: prepared.meetingTitle, focus: prepared.focus, preparedAt: prepared.preparedAt, text: prepared.text } : null,
    }
  }
  const send = () => d.send(state())

  const openaiKey = () => readSecret(d.file, 'openai')
  /** where chat goes: OpenAI, or the person's OpenAI-compatible server (#17); read per request so Settings apply at once */
  const endpoint = (role: 'live' | 'prepare') => {
    const p = providersOf(loadSettings(d.file))
    if (p.assistant === 'custom') return { key: readSecret(d.file, 'custom') ?? '', baseUrl: p.customBaseUrl, model: p.customModel || 'default' }
    return { key: openaiKey(), model: role === 'prepare' ? p.openaiPrepareModel : p.openaiChatModel }
  }
  const chat: ChatFn = (req) => openaiChat({ ...endpoint('live'), ...req })
  // the briefing picks tools and writes, so on OpenAI it gets its own (larger) model
  const prepareChat: ChatFn = (req) => openaiChat({ ...endpoint('prepare'), ...req })
  const clientOf = (s: McpServerConfig) => createMcpClient({ key: readSecret(d.file, `mcp:${s.id}`) ?? undefined, url: s.url })

  /** the enabled servers' read-only tools, gathered again on each prepare and meeting start */
  const enabledServers = () => serversOf(loadSettings(d.file)).filter(s => s.enabled).map(config => ({ config, client: clientOf(config) }))
  async function loadTools(): Promise<void> {
    const servers = enabledServers()
    const failed: Unavailable[] = []
    tools = servers.length ? await collectTools(servers, u => failed.push(u)) : []
    unavailable = failed
    const runner = createToolRunner(servers, tools)
    call = (name, argsJson) => runner.call(name, argsJson)
  }

  async function prepare(o: { focus?: string | null; meetingTitle?: string | null; forMeeting?: string }): Promise<OleLiveState> {
    // enforced here, not only in the panel: Assistant = Local (without local Prepare) never reaches OpenAI or an MCP server
    if (blocked()) { error = null; send(); return state() }
    if (!serversOf(loadSettings(d.file)).some(s => s.enabled)) { error = 'Add an MCP server in Settings'; send(); return state() }
    const seq = ++prepareSeq
    preparing = true; error = null; send()
    try {
      await loadTools()
      const instructions = providersOf(loadSettings(d.file)).warmupInstructions
      // every enabled server failed: say so rather than write a briefing from nothing (#33)
      if (!tools.length && unavailable.length) throw new Error(`Couldn't use any MCP server: ${unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}.`)
      const meetingTitle = o.meetingTitle ?? null, focus = o.focus ?? null
      // each server's own warm-up prompt (MCP prompts, prepare_for_meeting) comes first; the person's instructions refine it
      const serverPrompts = await collectWarmupPrompts(enabledServers(), { meetingTitle, focus })
      // on this Mac (#5) the notes queue runs it, so it never overlaps a summary
      const onMac = providersOf(loadSettings(d.file)).prepareOn === 'local' && local
      const result = await prepareContext({ chat: onMac ? createLocalChat(onMac) : prepareChat, tools, call, meetingTitle, focus, instructions, serverPrompts })
      if (seq !== prepareSeq) return state()
      // the meeting ended while this was loading: the next call prepares fresh
      if (o.forMeeting !== undefined && o.forMeeting !== meetingId) { preparing = false; send(); return state() }
      // the saved briefing records which servers it lacks
      prepared = unavailable.length ? { ...result, text: `${result.text}\n\n_Not included: ${unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}._` } : result
    } catch (e) {
      if (seq !== prepareSeq) return state()
      error = e instanceof Error ? e.message : String(e)
    }
    preparing = false
    send()
    return state()
  }

  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
  /** servers already reported as failing: one notification when one stops working, none again until it recovers (#33) */
  const reported = new Set<string>()
  async function checkServers(): Promise<void> {
    // with Assistant on Local and Prepare not on this Mac, Ole never contacts the servers (#11)
    if (liveBlocked() && providersOf(loadSettings(d.file)).prepareOn !== 'local') return
    if (!serversOf(loadSettings(d.file)).some(s => s.enabled) || preparing) return
    try { await loadTools() } catch (e) { console.warn('checking the MCP servers failed', e); return }
    const failing = new Set(unavailable.map(u => u.name))
    for (const u of unavailable) if (!reported.has(u.name)) d.notify?.(`Ole can't use ${u.name}`, `The MCP server ${u.reason === "couldn't be reached" ? "couldn't be reached" : `failed: ${u.reason}`}. Fix it in Settings › Ole before your next call.`)
    reported.clear(); for (const n of failing) reported.add(n)
    send()
  }
  const every = d.checkEveryMs ?? 10 * 60_000
  if (every > 0) { setTimeout(() => void checkServers(), 5_000).unref?.(); setInterval(() => void checkServers(), every).unref?.() }

  /** the calendar event on now, for a call with a default title (#56) */
  async function calendarTitle(): Promise<string | null> {
    if (!d.upcoming) return null
    try { const now = Date.now(); return eventNow(await d.upcoming(now - 12 * 60 * 60_000, now + 60 * 60_000), now)?.title ?? null }
    catch (e) { console.warn('reading the calendar failed', e); return null }
  }

  async function autoPrepare(): Promise<void> {
    const p = providersOf(loadSettings(d.file))
    if (!p.autoPrepare || !d.upcoming || meetingId || preparing || blocked()) return
    if (!serversOf(loadSettings(d.file)).some(s => s.enabled)) return
    const now = Date.now(), lead = p.autoPrepareLead * 60_000
    let next: Upcoming | null
    try { next = pickAutoPrepare(await d.upcoming(now, now + lead), now, lead, autoDone) } catch (e) { console.warn('reading the calendar failed', e); return }
    if (!next) return
    autoDone.add(next.id)
    await prepare({ meetingTitle: next.title })
    if (prepared?.meetingTitle === next.title && !error) {
      autoTitle = next.title
      d.notify?.('Your briefing is ready', next.title)
    }
  }
  const autoEvery = d.autoEveryMs ?? 2 * 60_000
  if (autoEvery > 0) setInterval(() => void autoPrepare().catch(e => console.warn('auto-prepare failed', e)), autoEvery).unref?.()

  ipcMain.handle('ole:state', () => state())
  ipcMain.handle('ole:briefing', (_e, id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return ''
    if (id === meetingId) return prepared?.text ?? ''
    const found = finishedBriefings.get(id)
    if (found !== undefined) return found
    try { return d.loadBriefing?.(id) ?? '' } catch { return '' }
  })
  ipcMain.handle('ole:retry-servers', async () => { try { await loadTools() } catch (e) { console.warn('loading the MCP tools failed', e) } send(); return state() })
  // a saved meeting's context bullets, newest first; ids are Yogurt's meeting UUIDs
  ipcMain.handle('ole:bullets', (_e, id: unknown) => {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return []
    const found = finished.get(id) ?? (id === meetingId ? bullets : null)
    if (found) return found
    try { return d.load?.(id) ?? [] } catch { return [] }
  })
  // pin (#54) and rate (#55) a bullet of the call on now
  ipcMain.handle('ole:bullet:pin', (_e, id: unknown, on: unknown) => {
    if (typeof id === 'string' && typeof on === 'boolean') engine?.update(id, { pinned: on })
    return state()
  })
  ipcMain.handle('ole:bullet:rate', (_e, id: unknown, rating: unknown) => {
    if (typeof id !== 'string' || !(rating === 'up' || rating === 'down' || rating === null) || !engine) return state()
    const b = engine.update(id, { rating })
    if (b) try { recordRating(d.file, b.text, rating) } catch (e) { console.warn('saving the rating failed', e) }
    return state()
  })
  // a question during the call (#53)
  ipcMain.handle('ole:ask', async (_e, q: unknown) => {
    const question = typeof q === 'string' ? q.trim().slice(0, QUESTION_MAX) : ''
    const forMeeting = meetingId
    if (!question || !forMeeting || liveBlocked()) return state()
    const id = `a${++answerSeq}`
    answers = [{ id, question, text: '', at: Date.now(), pending: true }, ...answers]
    send()
    let got: Omit<OleAnswer, 'id' | 'question' | 'at'>
    try {
      // the call's memory: running summary (#75), the user's notes (#77), earlier questions oldest first (#76)
      const earlier = answers.filter(a => !a.pending && a.id !== id).slice(0, 3).reverse().map(a => ({ question: a.question, text: a.text }))
      got = await answerQuestion({ chat, question, context: prepared, lines: engine?.recent() ?? [], tools: liveTools(), call: (n, a) => call(n, a),
        summary: summarizer?.summary(), notes: notesNow(forMeeting), earlier })
    } catch (e) { got = { text: `Couldn't answer: ${e instanceof Error ? e.message : String(e)}` } }
    // the call ended while answering: the answer belongs to it, not to the next call
    const done = (a: OleAnswer): OleAnswer => a.id === id ? { id, question, at: a.at, ...got } : a
    if (forMeeting === meetingId) answers = answers.map(done)
    else { const kept = (finishedAnswers.get(forMeeting) ?? []).map(done); finishedAnswers.set(forMeeting, kept); try { d.saveAnswers?.(forMeeting, kept) } catch { /* kept in memory */ } }
    send()
    return state()
  })
  // a saved meeting's summary, open questions and commitments (#82); null when Ole kept none
  ipcMain.handle('ole:call', (_e, id: unknown) => {
    if (typeof id !== 'string' || !ID.test(id)) return null
    if (id === meetingId) return summarizer?.memory() ?? null
    const found = finishedCalls.get(id)
    if (found) return found
    try { return d.loadCall?.(id) ?? null } catch { return null }
  })
  ipcMain.handle('ole:answers', (_e, id: unknown) => {
    if (typeof id !== 'string' || !ID.test(id)) return []
    if (id === meetingId) return answers
    const found = finishedAnswers.get(id)
    if (found) return found
    try { return d.loadAnswers?.(id) ?? [] } catch { return [] }
  })
  // a saved call as a replay fixture (#70), written where the person picks; anonymised unless asked otherwise
  ipcMain.handle('ole:export-replay', async (_e, id: unknown, o: unknown): Promise<OleExportResult> => {
    const failed = (error: string): OleExportResult => ({ status: 'failed', error })
    if (typeof id !== 'string' || !ID.test(id) || !d.meetingForExport || !d.saveExport) return failed("Couldn't export this meeting.")
    if (id === meetingId) return failed('The call is still recording. Export it once it ends.')
    const anonymise = !(o && typeof o === 'object' && (o as Record<string, unknown>).anonymise === false)
    let m: ReturnType<NonNullable<Deps['meetingForExport']>> = null
    try { m = d.meetingForExport(id) } catch (e) { console.warn('reading the meeting for export failed', e) }
    if (!m) return failed("Couldn't find this meeting.")
    if (!m.segments.some(s => s.text.trim())) return failed('This meeting has no transcript to export.')
    let kept = finishedTurns.get(id) ?? null
    if (!kept) try { kept = d.loadTurns?.(id) ?? null } catch { kept = null }
    let briefing = finishedBriefings.get(id)
    if (briefing === undefined) try { briefing = d.loadBriefing?.(id) ?? '' } catch { briefing = '' }
    const name = exportFileName(m.startedAt)
    const fixture = buildReplayFixture({
      name: name.replace(/\.json$/, ''), meetingTitle: m.title, attendees: m.attendees, segments: m.segments, anonymise,
      briefing: { text: briefing, meetingTitle: kept?.briefing ? kept.briefing.meetingTitle : m.title, focus: kept?.briefing?.focus ?? null },
      // a call from before turns were kept: the tools the servers offer now, as the app would offer them live
      tools: kept ? kept.tools : tools.filter(isLiveTool).map(t => t.name),
      turns: kept?.turns,
    })
    let status: OleExportResult['status']
    try { status = await d.saveExport(name, `${JSON.stringify(fixture, null, 2)}\n`) } catch (e) { console.warn('writing the replay file failed', e); status = 'failed' }
    return status === 'failed' ? failed("Couldn't write the file.") : { status, turns: fixture.turns.length }
  })
  ipcMain.handle('ole:prepare', (_e, o: unknown) => {
    const input = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
    return prepare({ focus: text(input.focus, 200), meetingTitle: text(input.meetingTitle, 300) })
  })

  return {
    meetingStarted(m) {
      meetingId = m.id
      bullets = []
      answers = []
      const local = providersOf(loadSettings(d.file)).prepareOn === 'local'
      const named = genericTitle(m.title) ? null : m.title
      // an auto-prepared briefing for another meeting is not this call's (#52)
      const otherMeeting = !!autoTitle && !!named && autoTitle !== named
      autoTitle = null
      // a local Prepare never runs during a call (#5): the bullets just get the tools
      const prepareNow = (!prepared || Date.now() - prepared.preparedAt > STALE_MS || otherMeeting) && !local
      if (prepareNow) {
        // "Meeting", "Zoom call", "Untitled": a default title says nothing, so the calendar event on now names it (#44, #56)
        void (async () => {
          const title = named ?? await calendarTitle()
          preparedFromDefault = !title
          await prepare({ meetingTitle: title, forMeeting: m.id })
        })()
      } else {
        preparedFromDefault = false
        void loadTools().then(send, e => console.warn('loading the MCP tools failed', e))
      }
      // each bullets turn is kept with the call, on this Mac, for Export for replay (#70)
      recorder = !liveBlocked() ? createTurnRecorder({ chat, callTool: (name, argsJson) => call(name, argsJson) }) : null
      // bullets need the OpenAI key; without it the meeting records as Yogurt does
      engine = recorder ? createBulletsEngine({
        chat: recorder.chat,
        // live bullets get the lookup-style tools only (#15)
        // a call with no matching record never looks up single records (#57)
        tools: () => liveTools(),
        callTool: recorder.callTool,
        context: () => prepared,
        onBullets: all => { bullets = all; send() },
        feedback: () => { try { return feedbackOf(d.file) } catch { return { useful: [], notUseful: [] } } },
        summary: () => summarizer?.summary() ?? '',
        notes: () => notesNow(m.id),
      }) : null
      // the running summary updates in the background from the live model (#75)
      // open questions and commitments show in the panel as they change (#82)
      summarizer = engine ? createCallSummarizer({ chat, everyMs: d.summaryEveryMs, onChange: () => { if (meetingId === m.id) send() } }) : null
      send()
    },
    meetingRenamed(m) {
      if (m.id !== meetingId || !preparedFromDefault || genericTitle(m.title)) return
      preparedFromDefault = false
      if (providersOf(loadSettings(d.file)).prepareOn !== 'local') void prepare({ meetingTitle: m.title, forMeeting: m.id })
    },
    segment(seg) {
      if (seg.meetingId !== meetingId || !engine || !seg.text.trim()) return
      const line = { speaker: seg.speaker || (seg.track === 'me' ? 'Me' : 'Them'), text: seg.text, startMs: seg.startMs }
      engine.push(line)
      summarizer?.push(line)
    },
    meetingStopped(id) {
      if (id !== meetingId) return
      engine?.stop()
      summarizer?.stop()
      const memory = summarizer?.memory() ?? EMPTY_MEMORY
      summarizer = null
      // the call's open questions and commitments stay with the meeting (#82)
      if (!isEmptyMemory(memory)) { finishedCalls.set(id, memory); try { d.saveCall?.(id, memory) } catch (e) { console.warn('saving the call summary failed', e) } }
      finished.set(id, bullets)
      try { d.save?.(id, bullets) } catch (e) { console.warn('saving the context bullets failed', e) }
      // pinned bullets join the person's own notes, so the summary and the notes keep them (#54); then what Ole kept of
      // the call: summary, open questions, commitments and the questions asked (#83). One append, so one notes write.
      const md = [pinnedNotes(bullets), fromOleNotes(memory, answers)].filter(Boolean).join('\n\n')
      if (md) try { d.appendNotes?.(id, md) } catch (e) { console.warn('adding Ole\'s notes to the meeting failed', e) }
      if (answers.length) { finishedAnswers.set(id, answers); try { d.saveAnswers?.(id, answers) } catch (e) { console.warn('saving the answers failed', e) } }
      answers = []
      if (recorder) {
        const turns: RecordedCall = { version: 1, ...(prepared ? { briefing: { meetingTitle: prepared.meetingTitle, focus: prepared.focus } } : {}), ...recorder.recorded() }
        finishedTurns.set(id, turns)
        try { d.saveTurns?.(id, turns) } catch (e) { console.warn('saving the bullets turns failed', e) }
        recorder = null
      }
      if (prepared?.text) { finishedBriefings.set(id, prepared.text); try { d.saveBriefing?.(id, prepared.text) } catch (e) { console.warn('saving the briefing failed', e) } }
      engine = null
      meetingId = null
      prepared = null
      // the call's bullets now live with the meeting (its note page); Home starts clean for the next call
      bullets = []
      send()
    },
    setLocal(run) { local = run; send() },
    checkServers,
    autoPrepare,
    bulletsOf: (id) => finished.get(id) ?? (id === meetingId ? bullets : []),
  }
}

/** Settings' Test button waits at most this long: a server that can't be reached never answers */
export const TEST_TIMEOUT_MS = 10_000

/** Settings' Test button: how many read-only tools the server offers Ole, or why it can't be reached. */
export async function testServer(server: McpServerConfig, key: string | null, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ ok: boolean; tools: number; error?: string; toolList?: Array<{ name: string; description: string }> }> {
  try {
    const listed = await createMcpClient({ key: key ?? undefined, url: server.url, ...(o.fetch ? { fetch: o.fetch } : {}) }).listTools({ timeoutMs: o.timeoutMs ?? TEST_TIMEOUT_MS })
    // only what Ole will use: read-only and a schema within bounds (#1)
    const usable = listed.filter(t => isReadOnly(t) && boundedSchema(t.inputSchema))
    return { ok: true, tools: usable.length, toolList: usable.map(t => ({ name: t.name, description: (t.description ?? '').trim() })).sort((a, b) => a.name.localeCompare(b.name)) }
  } catch (e) {
    const kind = e instanceof McpError ? e.kind : null
    if (kind === 'auth') return { ok: false, tools: 0, error: key ? 'The server rejected the key' : 'The server needs a key: paste it and Save, then Test' }
    if (kind === 'timeout' || kind === 'unreachable') return { ok: false, tools: 0, error: `Couldn't reach the server in ${TEST_TIMEOUT_MS / 1000} s. Check its address.` }
    return { ok: false, tools: 0, error: e instanceof Error ? e.message : String(e) }
  }
}
