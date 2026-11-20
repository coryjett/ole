// Ole: the live call companion. Before the call, the model gathers a briefing from the MCP servers' read-only tools
// (prepare.ts); during it, context bullets from the transcript, the briefing and throttled tool lookups (bullets.ts).
import type { McpServerConfig, OleAnswer, OleBullet, OleCallMemory, OleExportResult, OleLiveState, OleTool, PreparedContext } from './types'
import type { OleHost } from './host'
import { providersOf } from './providers'
import { serversOf } from './servers'
import { openaiChat } from './openai'
import { createMcpClient } from './mcp'
import { collectTools, collectWarmupPrompts, createToolRunner, isLiveTool, type Unavailable } from './tools'
import { prepareContext } from './prepare'
import { createLocalChat, type LocalRun } from './localChat'
import { createBulletsEngine, generalTools, hasMatchedRecord, pinnedNotes, stripMentioned, type BulletsEngine, type ChatFn } from './bullets'
import { answerQuestion } from './ask'
import { createEnricher, type Enricher } from './enrich'
import { eventNow, pickAutoPrepare } from './calendarMatch'
import { createMeetingSource, type Meeting, type SourceCall } from './meetingSource'
import { feedbackOf, recordRating } from './feedback'
import { createTurnRecorder, type RecordedCall } from './turnRecorder'
import { createCallSummarizer, EMPTY_MEMORY, fromOleNotes, isEmptyMemory } from './callSummary'
import { buildReplayFixture, exportFileName } from './replayExport'

/** tools older than this are gathered again before the meeting source uses them (#98) */
const TOOLS_FRESH_MS = 10 * 60_000
/** a prepared briefing older than this is gathered again when a meeting starts */
const STALE_MS = 2 * 60 * 60_000

export type OleSessionOptions = {
  /** how often the servers are checked in the background; 0 turns the background check off (tests) */
  checkEveryMs?: number
  /** how much new conversation updates the running summary; default 3 minutes, 0 updates on every line (tests) */
  summaryEveryMs?: number
  /** how often auto-prepare looks at the calendar; 0 turns the timer off (tests) */
  autoEveryMs?: number
}

/** a question is cut to this */
const QUESTION_MAX = 500
const ID = /^[0-9a-f-]{36}$/i

/**
 * The live call companion, host-agnostic: the host tells it about meetings and transcript lines and maps its own
 * requests (IPC in Yogurt) to `handlers`; everything else it needs comes through OleHost.
 */
export type OleSession = {
  meetingStarted(m: { id: string; title: string }): void
  /** the recording was renamed (calendar match or the person): a briefing from a default title is prepared again once (#44) */
  meetingRenamed(m: { id: string; title: string }): void
  meetingStopped(id: string): void
  segment(seg: { meetingId: string; track: 'me' | 'them'; speaker?: string | null; text: string; startMs: number }): void
  bulletsOf(id: string): OleBullet[]
  /** hands over the host's own model for Prepare once it exists (#5; Yogurt: its notes queue) */
  setLocal(run: LocalRun): void
  /** check the MCP servers now (at startup, on a timer, on wake), so a broken one is found before the call (#33) */
  checkServers(): Promise<void>
  /** prepare for a calendar meeting about to start, once per event (#52) */
  autoPrepare(): Promise<void>
  /** the UI's requests, one per IPC channel in Yogurt; each takes the UI's input unchecked and validates it */
  handlers: OleHandlers
}

export type OleHandlers = {
  /** ole:state */
  state(): OleLiveState
  /** ole:briefing: a meeting's briefing as it stood when the call ended (#35); '' when none */
  briefing(id: unknown): string
  /** ole:retry-servers (#33) */
  retryServers(): Promise<OleLiveState>
  /** ole:bullets: a saved meeting's context bullets, newest first */
  bullets(id: unknown): OleBullet[]
  /** ole:bullet:pin (#54) */
  pin(id: unknown, on: unknown): OleLiveState
  /** ole:bullet:rate (#55) */
  rate(id: unknown, rating: unknown): OleLiveState
  /** ole:ask: a question during the call (#53) */
  ask(question: unknown): Promise<OleLiveState>
  /** ole:call: a saved meeting's summary, open questions and commitments (#82); null when Ole kept none */
  call(id: unknown): OleCallMemory | null
  /** ole:answers */
  answers(id: unknown): OleAnswer[]
  /** ole:export-replay: a saved call as a replay fixture (#70) */
  exportReplay(id: unknown, o: unknown): Promise<OleExportResult>
  /** ole:prepare */
  prepare(o: unknown): Promise<OleLiveState>
}

export function createOleSession(host: OleHost, o: OleSessionOptions = {}): OleSession {
  let prepared: PreparedContext | null = null
  let preparing = false
  let error: string | null = null
  let meetingId: string | null = null
  let engine: BulletsEngine | null = null
  let summarizer: ReturnType<typeof createCallSummarizer> | null = null
  /** names said during the call, looked up in the background (#86), and the sections they added to the briefing */
  let enricher: Enricher | null = null
  let sections: string[] = []
  /** a briefing with this call's sections after it: a briefing prepared again mid-call keeps them (#86) */
  const withSections = (text: string) => sections.length ? [text.trim(), ...sections].filter(Boolean).join('\n\n') : text
  /** the user's notes, empty on any failure: a notes read never breaks a turn (#77) */
  const notesNow = (id: string) => { try { return host.notes?.read?.(id) ?? '' } catch { return '' } }
  let bullets: OleBullet[] = []
  let tools: OleTool[] = []
  /** enabled servers that failed the last time tools were loaded (#33) */
  let unavailable: Unavailable[] = []
  let call: SourceCall = async () => 'No MCP tools are available'
  /** when the tools were last gathered (0: never) */
  let toolsLoadedAt = 0
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
    const p = providersOf(host.settings.get())
    if (p.assistant === 'local') return 'Prepare and live context use OpenAI or your own server, with your MCP servers. Set Assistant to OpenAI or Custom server in Settings > Ole.'
    if (p.assistant === 'openai' && !openaiKey()) return 'Add an OpenAI key in Settings > Ole to prepare for calls.'
    if (p.assistant === 'custom' && !p.customBaseUrl) return 'Add the Custom server address in Settings > Ole to prepare for calls.'
    return null
  }
  /** why Prepare is off: on the local model only before a call and once it is ready (#5), otherwise as live context */
  const blocked = (): string | null => {
    if (providersOf(host.settings.get()).prepareOn !== 'local') return liveBlocked()
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
  const send = () => host.send(state())

  const openaiKey = () => host.secrets.read('openai')
  /** where chat goes: OpenAI, or the person's OpenAI-compatible server (#17); read per request so Settings apply at once */
  const endpoint = (role: 'live' | 'prepare') => {
    const p = providersOf(host.settings.get())
    if (p.assistant === 'custom') return { key: host.secrets.read('custom') ?? '', baseUrl: p.customBaseUrl, model: p.customModel || 'default' }
    return { key: openaiKey(), model: role === 'prepare' ? p.openaiPrepareModel : p.openaiChatModel }
  }
  const chat: ChatFn = (req) => openaiChat({ ...endpoint('live'), ...req })
  // the briefing picks tools and writes, so on OpenAI it gets its own (larger) model
  const prepareChat: ChatFn = (req) => openaiChat({ ...endpoint('prepare'), ...req })
  const clientOf = (s: McpServerConfig) => createMcpClient({ key: host.secrets.read(`mcp:${s.id}`) ?? undefined, url: s.url })

  /** the enabled servers' read-only tools, gathered again on each prepare and meeting start */
  const enabledServers = () => serversOf(host.settings.get()).filter(s => s.enabled).map(config => ({ config, client: clientOf(config) }))
  async function loadTools(): Promise<void> {
    const servers = enabledServers()
    const failed: Unavailable[] = []
    tools = servers.length ? await collectTools(servers, u => failed.push(u)) : []
    unavailable = failed
    const runner = createToolRunner(servers, tools)
    call = (name, argsJson, opts) => runner.call(name, argsJson, opts)
    toolsLoadedAt = host.clock.now()
  }

  /** with Assistant on Local and Prepare not on this Mac, Ole never contacts the servers (#11) */
  const serversAllowed = () => !(liveBlocked() && providersOf(host.settings.get()).prepareOn !== 'local') && serversOf(host.settings.get()).some(s => s.enabled)
  /**
   * Where meetings come from (#98): the meetings list and "what is this meeting". Every server choice is made in
   * meetingSource.ts; the session only hands it the tools (gathered again when older than the background check) and
   * the host calendar as the fallback.
   */
  const meetings = createMeetingSource({
    tools: async () => {
      if (!serversAllowed()) return []
      if (!toolsLoadedAt || host.clock.now() - toolsLoadedAt > TOOLS_FRESH_MS) {
        try { await loadTools() } catch (e) { host.log.warn('loading the MCP tools failed', e); return [] }
      }
      return tools
    },
    call: (name, argsJson, opts) => call(name, argsJson, opts),
    calendar: host.calendar,
    now: () => host.clock.now(),
    warn: (m, e) => host.log.warn(m, e),
  })

  async function prepare(o: { focus?: string | null; meetingTitle?: string | null; forMeeting?: string; startsAt?: number | null; note?: Meeting['note']; noteSource?: string }): Promise<OleLiveState> {
    // enforced here, not only in the panel: Assistant = Local (without local Prepare) never reaches OpenAI or an MCP server
    if (blocked()) { error = null; send(); return state() }
    if (!serversOf(host.settings.get()).some(s => s.enabled)) { error = 'Add an MCP server in Settings'; send(); return state() }
    const seq = ++prepareSeq
    preparing = true; error = null; send()
    try {
      await loadTools()
      const instructions = providersOf(host.settings.get()).warmupInstructions
      // every enabled server failed: say so rather than write a briefing from nothing (#33)
      if (!tools.length && unavailable.length) throw new Error(`Couldn't use any MCP server: ${unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}.`)
      const meetingTitle = o.meetingTitle ?? null, focus = o.focus ?? null
      // each server's own warm-up prompt (MCP prompts, prepare_for_meeting) comes first; the person's instructions refine it
      const serverPrompts = await collectWarmupPrompts(enabledServers(), { meetingTitle, focus })
      // on this Mac (#5) the notes queue runs it, so it never overlaps a summary
      const onMac = providersOf(host.settings.get()).prepareOn === 'local' && local
      const raw = await prepareContext({ chat: onMac ? createLocalChat(onMac) : prepareChat, tools, call, meetingTitle, focus, startsAt: o.startsAt ?? null, instructions, serverPrompts,
        source: meetings, note: o.note ? { text: o.note, source: o.noteSource } : null })
      // text posing as a mid-call section never reaches the briefing as one (#86): only the enricher adds those
      const result = { ...raw, text: stripMentioned(raw.text) }
      if (seq !== prepareSeq) return state()
      // the meeting ended while this was loading: the next call prepares fresh
      if (o.forMeeting !== undefined && o.forMeeting !== meetingId) { preparing = false; send(); return state() }
      // the saved briefing records which servers it lacks
      prepared = unavailable.length ? { ...result, text: `${result.text}\n\n_Not included: ${unavailable.map(u => `${u.name} (${u.reason})`).join(', ')}._` } : result
      if (meetingId) prepared = { ...prepared, text: withSections(prepared.text) }
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
    if (!serversAllowed() || preparing) return
    try { await loadTools() } catch (e) { host.log.warn('checking the MCP servers failed', e); return }
    const failing = new Set(unavailable.map(u => u.name))
    for (const u of unavailable) if (!reported.has(u.name)) host.notify?.(`Ole can't use ${u.name}`, `The MCP server ${u.reason === "couldn't be reached" ? "couldn't be reached" : `failed: ${u.reason}`}. Fix it in Settings › Ole before your next call.`)
    reported.clear(); for (const n of failing) reported.add(n)
    send()
  }
  const every = o.checkEveryMs ?? 10 * 60_000
  if (every > 0) { host.clock.after(5_000, () => void checkServers()); host.clock.every(every, () => void checkServers()) }

  /** the meeting on now, for a call with a default title (#56); its start goes to a meeting-context tool (#93) */
  async function calendarEvent(): Promise<Meeting | null> {
    try { const now = host.clock.now(); return eventNow(await meetings.upcomingMeetings(now - 12 * 60 * 60_000, now + 60 * 60_000), now) }
    catch (e) { host.log.warn('reading the calendar failed', e); return null }
  }

  async function autoPrepare(): Promise<void> {
    const p = providersOf(host.settings.get())
    if (!p.autoPrepare || meetingId || preparing || blocked()) return
    if (!serversOf(host.settings.get()).some(s => s.enabled)) return
    const now = host.clock.now(), lead = p.autoPrepareLead * 60_000
    let next: Meeting | null
    try { next = pickAutoPrepare(await meetings.upcomingMeetings(now, now + lead), now, lead, autoDone, host.genericTitle) } catch (e) { host.log.warn('reading the calendar failed', e); return }
    if (!next) return
    autoDone.add(next.id)
    await prepare({ meetingTitle: next.title, startsAt: next.start, note: next.note, noteSource: next.source })
    if (prepared?.meetingTitle === next.title && !error) {
      autoTitle = next.title
      host.notify?.('Your briefing is ready', next.title)
    }
  }
  const autoEvery = o.autoEveryMs ?? 2 * 60_000
  if (autoEvery > 0) host.clock.every(autoEvery, () => void autoPrepare().catch(e => host.log.warn('auto-prepare failed', e)))

  const handlers: OleHandlers = {
    state: () => state(),
    briefing: (id: unknown) => {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return ''
      if (id === meetingId) return prepared?.text ?? ''
      const found = finishedBriefings.get(id)
      if (found !== undefined) return found
      try { return host.files.loadBriefing?.(id) ?? '' } catch { return '' }
    },
    retryServers: async () => { try { await loadTools() } catch (e) { host.log.warn('loading the MCP tools failed', e) } send(); return state() },
    // a saved meeting's context bullets, newest first; ids are the host's meeting UUIDs
    bullets: (id: unknown) => {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return []
      const found = finished.get(id) ?? (id === meetingId ? bullets : null)
      if (found) return found
      try { return host.files.loadBullets?.(id) ?? [] } catch { return [] }
    },
    // pin (#54) and rate (#55) a bullet of the call on now
    pin: (id: unknown, on: unknown) => {
      if (typeof id === 'string' && typeof on === 'boolean') engine?.update(id, { pinned: on })
      return state()
    },
    rate: (id: unknown, rating: unknown) => {
      if (typeof id !== 'string' || !(rating === 'up' || rating === 'down' || rating === null) || !engine) return state()
      const b = engine.update(id, { rating })
      if (b) try { recordRating(host.settings, b.text, rating) } catch (e) { host.log.warn('saving the rating failed', e) }
      return state()
    },
    // a question during the call (#53)
    ask: async (q: unknown) => {
      const question = typeof q === 'string' ? q.trim().slice(0, QUESTION_MAX) : ''
      const forMeeting = meetingId
      if (!question || !forMeeting || liveBlocked()) return state()
      const id = `a${++answerSeq}`
      answers = [{ id, question, text: '', at: host.clock.now(), pending: true }, ...answers]
      send()
      let got: Omit<OleAnswer, 'id' | 'question' | 'at'>
      try {
        // the call's memory: running summary (#75), the user's notes (#77), earlier questions oldest first (#76)
        const earlier = answers.filter(a => !a.pending && a.id !== id).slice(0, 3).reverse().map(a => ({ question: a.question, text: a.text }))
        got = await answerQuestion({ chat, question, context: prepared, lines: engine?.recent() ?? [], tools: liveTools(), call: (n, a) => call(n, a),
          summary: summarizer?.summary(), notes: notesNow(forMeeting), earlier, mentioned: sections.length > 0 })
      } catch (e) { got = { text: `Couldn't answer: ${e instanceof Error ? e.message : String(e)}`, ok: false } }
      // the call ended while answering: the answer belongs to it, not to the next call
      const done = (a: OleAnswer): OleAnswer => a.id === id ? { id, question, at: a.at, ...got } : a
      if (forMeeting === meetingId) answers = answers.map(done)
      else { const kept = (finishedAnswers.get(forMeeting) ?? []).map(done); finishedAnswers.set(forMeeting, kept); try { host.files.saveAnswers?.(forMeeting, kept) } catch { /* kept in memory */ } }
      send()
      return state()
    },
    // a saved meeting's summary, open questions and commitments (#82); null when Ole kept none
    call: (id: unknown) => {
      if (typeof id !== 'string' || !ID.test(id)) return null
      if (id === meetingId) return summarizer?.memory() ?? null
      const found = finishedCalls.get(id)
      if (found) return found
      try { return host.files.loadCall?.(id) ?? null } catch { return null }
    },
    answers: (id: unknown) => {
      if (typeof id !== 'string' || !ID.test(id)) return []
      if (id === meetingId) return answers
      const found = finishedAnswers.get(id)
      if (found) return found
      try { return host.files.loadAnswers?.(id) ?? [] } catch { return [] }
    },
    // a saved call as a replay fixture (#70), written where the person picks; anonymised unless asked otherwise
    exportReplay: async (id: unknown, opts: unknown): Promise<OleExportResult> => {
      const failed = (error: string): OleExportResult => ({ status: 'failed', error })
      if (typeof id !== 'string' || !ID.test(id) || !host.meetingForExport || !host.saveExport) return failed("Couldn't export this meeting.")
      if (id === meetingId) return failed('The call is still recording. Export it once it ends.')
      const anonymise = !(opts && typeof opts === 'object' && (opts as Record<string, unknown>).anonymise === false)
      let m: ReturnType<NonNullable<OleHost['meetingForExport']>> = null
      try { m = host.meetingForExport(id) } catch (e) { host.log.warn('reading the meeting for export failed', e) }
      if (!m) return failed("Couldn't find this meeting.")
      if (!m.segments.some(s => s.text.trim())) return failed('This meeting has no transcript to export.')
      let kept = finishedTurns.get(id) ?? null
      if (!kept) try { kept = host.files.loadTurns?.(id) ?? null } catch { kept = null }
      let briefing = finishedBriefings.get(id)
      if (briefing === undefined) try { briefing = host.files.loadBriefing?.(id) ?? '' } catch { briefing = '' }
      const name = exportFileName(m.startedAt)
      const fixture = buildReplayFixture({
        name: name.replace(/\.json$/, ''), meetingTitle: m.title, attendees: m.attendees, segments: m.segments, anonymise, genericTitle: host.genericTitle,
        briefing: { text: briefing, meetingTitle: kept?.briefing ? kept.briefing.meetingTitle : m.title, focus: kept?.briefing?.focus ?? null },
        // a call from before turns were kept: the tools the servers offer now, as the app would offer them live
        tools: kept ? kept.tools : tools.filter(isLiveTool).map(t => t.name),
        turns: kept?.turns,
      })
      let status: OleExportResult['status']
      try { status = await host.saveExport(name, `${JSON.stringify(fixture, null, 2)}\n`) } catch (e) { host.log.warn('writing the replay file failed', e); status = 'failed' }
      return status === 'failed' ? failed("Couldn't write the file.") : { status, turns: fixture.turns.length }
    },
    prepare: (opts: unknown) => {
      const input = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
      return prepare({ focus: text(input.focus, 200), meetingTitle: text(input.meetingTitle, 300) })
    },
  }

  return {
    meetingStarted(m) {
      meetingId = m.id
      bullets = []
      answers = []
      const local = providersOf(host.settings.get()).prepareOn === 'local'
      const named = host.genericTitle(m.title) ? null : m.title
      // an auto-prepared briefing for another meeting is not this call's (#52)
      const otherMeeting = !!autoTitle && !!named && autoTitle !== named
      autoTitle = null
      // a local Prepare never runs during a call (#5): the bullets just get the tools
      const prepareNow = (!prepared || host.clock.now() - prepared.preparedAt > STALE_MS || otherMeeting) && !local
      if (prepareNow) {
        // "Meeting", "Zoom call", "Untitled": a default title says nothing, so the calendar event on now names it (#44, #56)
        void (async () => {
          const event = named ? null : await calendarEvent()
          const title = named ?? event?.title ?? null
          preparedFromDefault = !title
          await prepare({ meetingTitle: title, forMeeting: m.id, startsAt: event?.start ?? null, note: event?.note, noteSource: event?.source })
        })()
      } else {
        preparedFromDefault = false
        void loadTools().then(send, e => host.log.warn('loading the MCP tools failed', e))
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
        feedback: () => { try { return feedbackOf(host.settings.get()) } catch { return { useful: [], notUseful: [] } } },
        summary: () => summarizer?.summary() ?? '',
        notes: () => notesNow(m.id),
        mentioned: () => sections.length > 0,
      }) : null
      // the running summary updates in the background from the live model (#75)
      // open questions and commitments show in the panel as they change (#82)
      summarizer = engine ? createCallSummarizer({ chat, everyMs: o.summaryEveryMs, onChange: () => { if (meetingId === m.id) send() } }) : null
      // a name the other side says that the briefing doesn't cover is looked up in the background (#86); its section
      // joins the briefing, so the bullets, Ask, the panel and the saved briefing all have it. Not through the turn
      // recorder: these are not bullets turns. All lookup-style tools, even on a call with no matching record (#57),
      // since finding who they are is the point; never a docs search (enrich.ts leaves those out)
      sections = []
      enricher = engine ? createEnricher({
        chat,
        tools: () => tools.filter(isLiveTool),
        callTool: (name, argsJson) => call(name, argsJson),
        context: () => prepared,
        busy: () => preparing || !!engine?.busy(),
        onSection: md => {
          if (meetingId !== m.id) return
          sections.push(md)
          prepared = prepared ? { ...prepared, text: `${prepared.text.trimEnd()}\n\n${md}` } : { meetingTitle: host.genericTitle(m.title) ? null : m.title, focus: null, text: md, preparedAt: host.clock.now() }
          send()
        },
      }) : null
      send()
    },
    meetingRenamed(m) {
      if (m.id !== meetingId || !preparedFromDefault || host.genericTitle(m.title)) return
      preparedFromDefault = false
      if (providersOf(host.settings.get()).prepareOn !== 'local') void prepare({ meetingTitle: m.title, forMeeting: m.id })
    },
    segment(seg) {
      if (seg.meetingId !== meetingId || !engine || !seg.text.trim()) return
      const line = { speaker: seg.speaker || (seg.track === 'me' ? 'Me' : 'Them'), text: seg.text, startMs: seg.startMs }
      engine.push(line)
      summarizer?.push(line)
      enricher?.push(line, seg.track === 'me')
    },
    meetingStopped(id) {
      if (id !== meetingId) return
      engine?.stop()
      summarizer?.stop()
      enricher?.stop()
      enricher = null
      const memory = summarizer?.memory() ?? EMPTY_MEMORY
      summarizer = null
      // the call's open questions and commitments stay with the meeting (#82)
      if (!isEmptyMemory(memory)) { finishedCalls.set(id, memory); try { host.files.saveCall?.(id, memory) } catch (e) { host.log.warn('saving the call summary failed', e) } }
      finished.set(id, bullets)
      try { host.files.saveBullets?.(id, bullets) } catch (e) { host.log.warn('saving the context bullets failed', e) }
      // pinned bullets join the person's own notes, so the summary and the notes keep them (#54); then what Ole kept of
      // the call: summary, open questions, commitments and the questions asked (#83). One append, so one notes write.
      const md = [pinnedNotes(bullets), fromOleNotes(memory, answers)].filter(Boolean).join('\n\n')
      if (md) try { host.notes?.append?.(id, md) } catch (e) { host.log.warn('adding Ole\'s notes to the meeting failed', e) }
      if (answers.length) { finishedAnswers.set(id, answers); try { host.files.saveAnswers?.(id, answers) } catch (e) { host.log.warn('saving the answers failed', e) } }
      answers = []
      if (recorder) {
        const turns: RecordedCall = { version: 1, ...(prepared ? { briefing: { meetingTitle: prepared.meetingTitle, focus: prepared.focus } } : {}), ...recorder.recorded() }
        finishedTurns.set(id, turns)
        try { host.files.saveTurns?.(id, turns) } catch (e) { host.log.warn('saving the bullets turns failed', e) }
        recorder = null
      }
      if (prepared?.text) { finishedBriefings.set(id, prepared.text); try { host.files.saveBriefing?.(id, prepared.text) } catch (e) { host.log.warn('saving the briefing failed', e) } }
      engine = null
      meetingId = null
      prepared = null
      sections = []
      // the call's bullets now live with the meeting (its note page); Home starts clean for the next call
      bullets = []
      send()
    },
    setLocal(run) { local = run; send() },
    checkServers,
    autoPrepare,
    bulletsOf: (id) => finished.get(id) ?? (id === meetingId ? bullets : []),
    handlers,
  }
}

