// Ole: Settings' OpenAI Test button (#2). Checks the saved key against GET /models and whether the chat and
// transcription model names in Settings are on the account. Runs in the main process: the key never reaches the renderer.
import { OPENAI_BASE_URL, reason } from './openaiModel'

export type OpenAITestResult = { ok: boolean; error?: string; chatModel?: { name: string; found: boolean }; transcribeModel?: { name: string; found: boolean } }

/** an unreachable OpenAI is reported after this long */
export const OPENAI_TEST_TIMEOUT_MS = 10_000

export async function testOpenAI(o: {
  key: string | null; chatModel: string; transcribeModel: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number
}): Promise<OpenAITestResult> {
  if (!o.key) return { ok: false, error: 'Save a key first' }
  let res: Response
  try {
    res = await (o.fetch ?? fetch)(`${(o.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${o.key}` },
      signal: AbortSignal.timeout(o.timeoutMs ?? OPENAI_TEST_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: "Couldn't reach OpenAI" }
  }
  if (res.status === 401) return { ok: false, error: 'OpenAI rejected the key' }
  if (!res.ok) {
    const why = await reason(res, o.key)
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
    chatModel: { name: o.chatModel, found: ids.has(o.chatModel) },
    transcribeModel: { name: o.transcribeModel, found: ids.has(o.transcribeModel) },
  }
}
