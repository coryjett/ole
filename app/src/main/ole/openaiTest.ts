// Ole: Settings' OpenAI Test button (#2). Checks the saved key against GET /models and whether the chat and
// transcription model names in Settings are on the account. Runs in the main process: the key never reaches the renderer.
import { OLE_USER_AGENT, OPENAI_BASE_URL, reason } from './openaiModel'

export type OpenAITestResult = { ok: boolean; error?: string; chatModel?: { name: string; found: boolean }; transcribeModel?: { name: string; found: boolean } }

/** an unreachable OpenAI is reported after this long */
export const OPENAI_TEST_TIMEOUT_MS = 10_000

export async function testOpenAI(o: {
  key: string | null; chatModel: string; transcribeModel: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number
}): Promise<OpenAITestResult> {
  if (!o.key && !o.baseUrl) return { ok: false, error: 'Save a key first' }
  let res: Response
  try {
    res = await (o.fetch ?? fetch)(`${(o.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')}/models`, {
      headers: { ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}), 'User-Agent': OLE_USER_AGENT },
      signal: AbortSignal.timeout(o.timeoutMs ?? OPENAI_TEST_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: o.baseUrl ? "Couldn't reach the server" : "Couldn't reach OpenAI" }
  }
  if (res.status === 401) return { ok: false, error: o.baseUrl ? 'The server rejected the key' : 'OpenAI rejected the key' }
  if (!res.ok) {
    const why = await reason(res, o.key ?? '')
    return { ok: false, error: `OpenAI answered ${res.status}${why ? `: ${why}` : ''}` }
  }
  let ids: Set<string>
  try {
    const data = (await res.json())?.data
    ids = new Set(Array.isArray(data) ? data.map((m: { id?: unknown }) => String(m?.id ?? '')) : [])
  } catch {
    return { ok: false, error: 'OpenAI returned an unreadable model list' }
  }
  return {
    ok: true,
    // only the names that are set are checked (a custom server's model can be left to the server)
    ...(o.chatModel ? { chatModel: { name: o.chatModel, found: ids.has(o.chatModel) } } : {}),
    ...(o.transcribeModel ? { transcribeModel: { name: o.transcribeModel, found: ids.has(o.transcribeModel) } } : {}),
  }
}

export type OpenAIModels = { ok: boolean; error?: string; chat: string[]; transcribe: string[] }

/** a model id that answers chat with tools (not audio, images, embeddings, moderation or realtime) */
export const isChatModel = (id: string) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(transcribe|tts|audio|realtime|image|embedding|search|moderation|dall-e|whisper|instruct|codex)/.test(id)
export const isTranscribeModel = (id: string) => /(transcribe|^whisper)/.test(id)

/** the models this key can use, for Settings' model dropdowns; newest-looking names first */
export async function listOpenAIModels(o: { key: string | null; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): Promise<OpenAIModels> {
  if (!o.key && !o.baseUrl) return { ok: false, error: 'Save an OpenAI key to see your models', chat: [], transcribe: [] }
  let res: Response
  try {
    res = await (o.fetch ?? fetch)(`${(o.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')}/models`, {
      headers: { ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}), 'User-Agent': OLE_USER_AGENT }, signal: AbortSignal.timeout(o.timeoutMs ?? OPENAI_TEST_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: "Couldn't reach OpenAI", chat: [], transcribe: [] }
  }
  if (res.status === 401) return { ok: false, error: 'OpenAI rejected the key', chat: [], transcribe: [] }
  if (!res.ok) return { ok: false, error: `OpenAI answered ${res.status}`, chat: [], transcribe: [] }
  let ids: string[] = []
  try {
    const data = (await res.json())?.data
    ids = Array.isArray(data) ? data.map((m: { id?: unknown }) => String(m?.id ?? '')).filter(id => /^[A-Za-z0-9._:-]{1,100}$/.test(id)) : []
  } catch { /* an unreadable list: no models */ }
  const sorted = [...new Set(ids)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  // a custom server's model names are its own: every listed model is offered for chat (#17)
  const custom = !!o.baseUrl && o.baseUrl.replace(/\/+$/, '') !== OPENAI_BASE_URL
  return { ok: true, chat: (custom ? sorted : sorted.filter(isChatModel)).slice(0, 200), transcribe: custom ? [] : sorted.filter(isTranscribeModel).slice(0, 50) }
}
