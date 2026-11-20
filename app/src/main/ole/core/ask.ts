// Ole: a question typed during the call (#53), answered from the briefing, the last few minutes of the call and,
// when those lack it, one or two read-only lookups.
import type { OleTool, PreparedContext } from './types'
import { toOpenAiTools } from './tools'
import type { CallToolFn, ChatFn, ChatMessage, TranscriptLine } from './bullets'
import { anonymityFor, callKey, hasMatchedRecord, latestNotes, noRecordRule, readableSource, SOURCE_ANONYMITY } from './bullets'
import { anonymizeSourceLink } from './anonymize'
import { linkAndLabel, receivedUrls } from './links'

/** lookup rounds before the model must answer */
const TOOL_ROUNDS = 2
/** the last part of the call the model sees */
const RECENT_LINES = 40
/** earlier questions and answers sent with a new one (#76) */
const EARLIER_QUESTIONS = 3
export const ANSWER_MAX = 400
export const NO_ANSWER = "Couldn't find that in the briefing or your servers."

export const ASK_SYSTEM = [
  'You answer a question the user typed during a live call. They will read the answer mid-conversation.',
  'Reply with JSON only: {"answer":"...","source":"...","url":"..."}.',
  '"answer": one to three short sentences, the fact first. No preamble, no advice unless asked.',
  '"source": the record the answer came from, named the way the briefing or the tool result names it. "url": its web address exactly as given there; leave it out when there is none. Never make one up.',
  'Answer from the briefing and the call first; call a tool only when they lack the answer.',
  "Never put an organization's or person's name in a search of public documentation.",
  'Other organizations and people stay anonymous unless they are part of this meeting. Never invent facts: when you cannot find the answer, say so in the answer and leave source out.',
  SOURCE_ANONYMITY,
].join('\n')

/**
 * What kind of failure an Ask was, for the log and the answer (#122): `timeout`, `network`, `http <status>` or
 * `error`. Never the message, which can carry a server's reply or the question.
 */
export function askErrorKind(e: unknown): string {
  // duck-typed, so a test that mocks the clients still gets a kind: OpenAIError carries `status`, McpError `kind`
  const f = (e ?? {}) as { name?: unknown; status?: unknown; kind?: unknown; message?: unknown }
  if (typeof f.status === 'number' && f.status > 0) return `http ${f.status}`
  if (f.name === 'McpError') return f.kind === 'timeout' ? 'timeout' : f.kind === 'unreachable' ? 'network' : f.kind === 'http' ? 'http' : 'error'
  if (f.name === 'TimeoutError') return 'timeout'
  // fetch rejects with a TypeError when the server can't be reached
  if (e instanceof TypeError && /fetch|network/i.test(String(f.message))) return 'network'
  return 'error'
}

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export async function answerQuestion(o: {
  chat: ChatFn; question: string; context: PreparedContext | null; lines: TranscriptLine[]; tools: OleTool[]; call: CallToolFn
  /** the running summary (#75), the user's notes (#77) and earlier questions in this call, oldest first (#76) */
  summary?: string; notes?: string; earlier?: Array<{ question: string; text: string }>
  /** the enricher added sections to the briefing this call (#86), from the session's state */
  mentioned?: boolean
  /** the user pressed Stop (#122): every chat and lookup is cancelled, and answerQuestion rejects with the abort */
  signal?: AbortSignal
}): Promise<{ text: string; source?: string; url?: string; ok: boolean }> {
  // what doesn't change during the call first, so prompt caching covers it (#77)
  const parts = [o.context?.text ? `Briefing:\n${o.context.text}` : 'No briefing.']
  if (!hasMatchedRecord(o.context)) parts.push(noRecordRule(o.mentioned))
  if (o.summary?.trim()) parts.push(`The call so far (summary):\n${o.summary.trim()}`)
  if (o.notes?.trim()) parts.push(`The user's notes so far:\n${latestNotes(o.notes)}`)
  parts.push(o.lines.length ? `Recent lines (latest):\n${o.lines.slice(-RECENT_LINES).map(l => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n')}` : 'Nothing said yet.')
  const earlier = (o.earlier ?? []).slice(-EARLIER_QUESTIONS)
  if (earlier.length) parts.push(`Earlier questions in this call:\n${earlier.map(e => `Q: ${e.question}\nA: ${e.text}`).join('\n')}`)
  parts.push(`Question: ${o.question}`)
  const messages: ChatMessage[] = [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: parts.join('\n\n') }]
  const allowed = new Set(o.tools.map(t => t.name))
  const tools = o.tools.length ? { tools: toOpenAiTools(o.tools) } : {}
  const signal = o.signal ? { signal: o.signal } : {}
  o.signal?.throwIfAborted()
  let reply = await o.chat({ messages, ...tools, response_format: { type: 'json_object' }, ...signal })
  for (let round = 1; reply.tool_calls?.length; round++) {
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
    // a round's lookups run together (#80); the same call twice in one round reaches the server once
    const same = new Map<string, Promise<string>>()
    const results = await Promise.all(reply.tool_calls.map(c => {
      if (!allowed.has(c.function.name)) return 'not allowed: unknown tool'
      const args = c.function.arguments?.trim() || '{}'
      let key: string
      try { key = callKey(c.function.name, JSON.parse(args)) } catch { key = `${c.function.name} ${args}` }
      const running = same.get(key)
      if (running) return running
      let p: Promise<string>
      try { p = Promise.resolve(o.signal ? o.call(c.function.name, args, signal) : o.call(c.function.name, args)) } catch (e) { p = Promise.reject(e) }
      const result = p.catch(() => 'lookup failed')
      same.set(key, result)
      return result
    }))
    // a stopped question never turns failed lookups into an answer
    o.signal?.throwIfAborted()
    reply.tool_calls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }))
    // the last round offers no tools, so the model has to answer
    reply = await o.chat({ messages, ...(round < TOOL_ROUNDS ? tools : {}), response_format: { type: 'json_object' }, ...signal })
    if (round >= TOOL_ROUNDS) break
  }
  o.signal?.throwIfAborted()
  let parsed: { answer?: unknown; source?: unknown; url?: unknown } = {}
  try { parsed = JSON.parse((reply.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch { /* plain text or nothing: no answer */ }
  const text = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim().slice(0, ANSWER_MAX) : ''
  if (!text) return { text: NO_ANSWER, ok: false }
  const source = typeof parsed.source === 'string' && parsed.source.trim() ? readableSource(parsed.source.trim()).slice(0, 120) : undefined
  // a link is kept only if Ole received that exact address: models invent plausible URLs (#42, #107); a source that is
  // a bare web address becomes a short label taken from the link actually used (#102, #107)
  const material = `${o.context?.text ?? ''}\n${messages.filter(m => m.role === 'tool').map(m => m.content ?? '').join('\n')}`
  const linked = linkAndLabel(typeof parsed.url === 'string' ? parsed.url : undefined, source, receivedUrls(material))
  // the source names no organization but the meeting's own (#109)
  const looked = messages.filter(m => m.role === 'tool').map(m => m.content ?? '')
  const anon = linked.source ? anonymizeSourceLink(linked.source, linked.url, anonymityFor(o.context, [o.context?.text ?? '', ...looked])) : { source: undefined, url: linked.url }
  const url = anon.url
  const shown = anon.source
  return { text, ...(shown ? { source: shown } : {}), ...(url ? { url } : {}), ok: true }
}
