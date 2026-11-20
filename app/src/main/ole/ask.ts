// Ole: a question typed during the call (#53), answered from the briefing, the last few minutes of the call and,
// when those lack it, one or two read-only lookups.
import type { OleTool, PreparedContext } from './types'
import { toOpenAiTools } from './tools'
import type { CallToolFn, ChatFn, ChatMessage, TranscriptLine } from './bullets'
import { hasCustomerAccount, NO_ACCOUNT_RULE, readableSource } from './bullets'

/** lookup rounds before the model must answer */
const TOOL_ROUNDS = 2
/** the last part of the call the model sees */
const RECENT_LINES = 40
export const ANSWER_MAX = 400
export const NO_ANSWER = "Couldn't find that in the briefing or your servers."

export const ASK_SYSTEM = [
  'You answer a question the user typed during a live call. They will read the answer mid-conversation.',
  'Reply with JSON only: {"answer":"...","source":"...","url":"..."}.',
  '"answer": one to three short sentences, the fact first. No preamble, no advice unless asked.',
  '"source": the record the answer came from, named the way the briefing or the tool result names it. "url": its web address exactly as given there; leave it out when there is none. Never make one up.',
  'Answer from the briefing and the call first; call a tool only when they lack the answer.',
  'Anonymise other customers by industry and size. Never invent facts: when you cannot find the answer, say so in the answer and leave source out.',
].join('\n')

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export async function answerQuestion(o: {
  chat: ChatFn; question: string; context: PreparedContext | null; lines: TranscriptLine[]; tools: OleTool[]; call: CallToolFn
}): Promise<{ text: string; source?: string; url?: string }> {
  const parts = [
    o.context?.text ? `Briefing:\n${o.context.text}` : 'No briefing.',
    o.lines.length ? `The call so far (latest):\n${o.lines.slice(-RECENT_LINES).map(l => `[${clock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n')}` : 'Nothing said yet.',
    `Question: ${o.question}`,
  ]
  if (!hasCustomerAccount(o.context)) parts.splice(2, 0, NO_ACCOUNT_RULE)
  const messages: ChatMessage[] = [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: parts.join('\n\n') }]
  const allowed = new Set(o.tools.map(t => t.name))
  const tools = o.tools.length ? { tools: toOpenAiTools(o.tools) } : {}
  let reply = await o.chat({ messages, ...tools, response_format: { type: 'json_object' } })
  for (let round = 1; reply.tool_calls?.length; round++) {
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls })
    for (const c of reply.tool_calls) {
      const result = !allowed.has(c.function.name) ? 'not allowed: unknown tool'
        : await o.call(c.function.name, c.function.arguments?.trim() || '{}').catch(() => 'lookup failed')
      messages.push({ role: 'tool', tool_call_id: c.id, content: result })
    }
    // the last round offers no tools, so the model has to answer
    reply = await o.chat({ messages, ...(round < TOOL_ROUNDS ? tools : {}), response_format: { type: 'json_object' } })
    if (round >= TOOL_ROUNDS) break
  }
  let parsed: { answer?: unknown; source?: unknown; url?: unknown } = {}
  try { parsed = JSON.parse((reply.content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch { /* plain text or nothing: no answer */ }
  const text = typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim().slice(0, ANSWER_MAX) : ''
  if (!text) return { text: NO_ANSWER }
  const source = typeof parsed.source === 'string' && parsed.source.trim() ? readableSource(parsed.source.trim()).slice(0, 120) : undefined
  // a link is kept only if Ole has it: models invent plausible URLs (#42)
  const material = `${o.context?.text ?? ''}\n${messages.filter(m => m.role === 'tool').map(m => m.content ?? '').join('\n')}`
  const url = typeof parsed.url === 'string' && /^https:\/\/[^\s"<>]{3,500}$/.test(parsed.url.trim()) && material.includes(parsed.url.trim()) ? parsed.url.trim() : undefined
  return { text, ...(source ? { source } : {}), ...(url ? { url } : {}) }
}
