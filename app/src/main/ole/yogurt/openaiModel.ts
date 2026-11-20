// Ole: OpenAI as Yogurt's notes model, behind the same surface as Yogurt's local one (createNotesModel), so the notes,
// chat and title jobs need no change. The key and model are read on every job, so a Settings change applies to the
// next one without a restart. The client itself is host-agnostic (core/openai.ts); this is the Yogurt seam.
import type { Llm } from '../../notes/enhance'
import type { NotesModel } from '../../notes/model'
import { needKey, OPENAI_CONTEXT, openaiText, type OpenAIMessage } from '../core/openai'

/** Yogurt's notes model surface, answered by OpenAI. Embeddings stay local. */
export function createOpenAIModel(o: { key: () => string | null; model: () => string; fetch?: typeof fetch; baseUrl?: string | (() => string) }): NotesModel {
  const baseUrl = () => typeof o.baseUrl === 'function' ? o.baseUrl() : o.baseUrl
  return {
    async llm(signal?: AbortSignal): Promise<Llm> {
      needKey(o.key(), baseUrl())
      return {
        contextSize: OPENAI_CONTEXT,
        count: async (texts) => texts.map((t) => Math.ceil(t.length / 4)),
        chat: async (prompt, onToken, opts) => {
          const key = needKey(o.key(), baseUrl())
          // before: an earlier prompt and its answer, in that order (summary is a local-model hint, not needed here)
          const messages: OpenAIMessage[] = [
            ...(opts?.before ?? []).map((content, i): OpenAIMessage => ({ role: i % 2 ? 'assistant' : 'user', content })),
            { role: 'user', content: prompt },
          ]
          return openaiText({ key, model: o.model(), baseUrl: baseUrl(), fetch: o.fetch, signal, messages, maxTokens: opts?.maxTokens, temperature: opts?.temperature, onToken })
        },
      }
    },
    unload: async () => {},
    loaded: () => (o.key()?.trim() ? o.model() : undefined),
    needsLoad: () => false,
  }
}
