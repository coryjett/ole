// Ole: Prepare on the Mac's own model (#5). Yogurt's local model takes text and gives text, with no native tool calls,
// so this adapter speaks the same ChatFn as OpenAI: it lists the tools in the prompt, asks for one JSON object back
// ({"tool": ..., "arguments": ...} to call a tool, {"final": ...} for the briefing), and turns that into tool calls.
import type { Llm } from '../notes/enhance'
import type { ChatFn, ChatMessage, ToolCall } from './bullets'

/** a tool result longer than this is cut before it reaches a small local context */
export const LOCAL_RESULT_CAP = 2000
/** room kept for the model's answer when the prompt is trimmed to the context */
const ANSWER_TOKENS = 1500

type OpenAITool = { type: 'function'; function: { name: string; description?: string; parameters?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } } }

/** one line per tool: its name, what it does and its arguments, so a small model reads the menu cheaply */
export function toolMenu(tools: unknown[] = []): string {
  return (tools as OpenAITool[]).filter(t => t?.function?.name).map(t => {
    const props = t.function.parameters?.properties ?? {}
    const required = new Set(t.function.parameters?.required ?? [])
    const args = Object.entries(props).map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${v?.type ?? 'any'}`).join(', ')
    return `- ${t.function.name}(${args}): ${(t.function.description ?? '').replace(/\s+/g, ' ').slice(0, 160)}`
  }).join('\n')
}

/** the whole exchange as one prompt, newest kept when it has to be trimmed to fit the context */
export function localPrompt(messages: ChatMessage[], tools: unknown[] | undefined, maxChars: number): string {
  const head: string[] = []
  const turns: string[] = []
  for (const m of messages) {
    if (m.role === 'system') head.push(m.content ?? '')
    else if (m.role === 'user') turns.push(`USER:\n${m.content ?? ''}`)
    else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map(c => `{"tool": "${c.function.name}", "arguments": ${c.function.arguments || '{}'}}`).join('\n')
      turns.push(`YOU:\n${calls || m.content || ''}`)
    } else if (m.role === 'tool') turns.push(`TOOL RESULT:\n${(m.content ?? '').slice(0, LOCAL_RESULT_CAP)}`)
  }
  const how = tools?.length
    ? ['You can call these read-only tools:', toolMenu(tools), '',
      'Reply with exactly one JSON object and nothing else:',
      '- to call a tool: {"tool": "<name>", "arguments": {...}}',
      '- when you have enough: {"final": "<the briefing, in markdown>"}'].join('\n')
    : 'Write the briefing now, in markdown, from what you have. No JSON.'
  const fixed = `${head.join('\n\n')}\n\n${how}\n\n`
  // keep the newest turns that fit; the first user turn (the ask) always stays
  const budget = Math.max(1000, maxChars - fixed.length)
  const kept: string[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 1; i--) {
    if (used + turns[i].length > budget - (turns[0]?.length ?? 0)) break
    kept.unshift(turns[i]); used += turns[i].length
  }
  return `${fixed}${[turns[0], ...kept].filter(Boolean).join('\n\n')}\n\nYOU:\n`
}

/** the first JSON object in a reply (models often wrap it in prose or a code fence), or null */
export function firstJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const v = JSON.parse(text.slice(start, end + 1))
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch { /* a shorter span may parse */ }
  }
  return null
}

/** Runs one exclusive turn of the local model (the notes queue, so it never overlaps a summary). */
export type LocalRun = <T>(job: (llm: Llm, signal: AbortSignal) => Promise<T>) => Promise<T>

export function createLocalChat(run: LocalRun): ChatFn {
  let n = 0
  return (req) => run(async (llm) => {
    const prompt = localPrompt(req.messages, req.tools, Math.max(4000, (llm.contextSize - ANSWER_TOKENS) * 3))
    const text = (await llm.chat(prompt, () => {}, { maxTokens: ANSWER_TOKENS, temperature: 0.2 })).trim()
    if (!req.tools?.length) return { content: text }
    const json = firstJson(text)
    if (json && typeof json.tool === 'string') {
      const call: ToolCall = { id: `local-${++n}`, type: 'function', function: { name: json.tool, arguments: JSON.stringify(json.arguments ?? {}) } }
      return { content: null, tool_calls: [call] }
    }
    if (json && typeof json.final === 'string') return { content: json.final }
    // no usable JSON: take the text as the briefing rather than fail the whole Prepare
    return { content: text }
  })
}
