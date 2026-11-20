// Ole: the Settings requests (providers, MCP servers, keys) as plain functions. Each takes what the UI sends, unchecked,
// and validates it here, so a host only maps its IPC channels to them (Yogurt: yogurt/providers.ts, servers.ts,
// secrets.ts). Keys never cross: the UI only ever sees masked status.
import type { SecretStore, SettingsStore } from './host'
import { adoptOpenAI, providersOf, revertOpenAI, setProviders } from './providers'
import { serversOf, setServers, type ServerTest } from './servers'
import { defaultSecretNames, isSecretName, secretNamesFrom, secretStatus, SERVER_ID } from './secrets'
import { listOpenAIModels, testOpenAI } from './openaiTest'
import type { OleProviders, SecretName } from './types'

export function providerHandlers(d: { settings: SettingsStore; secrets: SecretStore; onChange?: (p: OleProviders) => void }) {
  const providers = () => providersOf(d.settings.get())
  return {
    get: () => providers(),
    set: (patch: unknown) => { const next = setProviders(d.settings, patch); if (patch && typeof patch === 'object' && !Array.isArray(patch)) d.onChange?.(next); return next },
    openaiTest: () => {
      const p = providers()
      return testOpenAI({ key: d.secrets.read('openai'), chatModel: p.openaiChatModel, transcribeModel: p.openaiTranscribeModel })
    },
    openaiAdopt: () => adoptOpenAI(d.settings),
    openaiRevert: (undo: unknown) => revertOpenAI(d.settings, { undo: undo === true }),
    openaiModels: () => listOpenAIModels({ key: d.secrets.read('openai') }),
    // the Custom server (#17): its models, and a reachability and key check
    customModels: () => {
      const p = providers()
      if (!p.customBaseUrl) return { ok: false, error: 'Add the server address first', chat: [], transcribe: [] }
      return listOpenAIModels({ key: d.secrets.read('custom'), baseUrl: p.customBaseUrl })
    },
    customTest: () => {
      const p = providers()
      if (!p.customBaseUrl) return { ok: false, error: 'Add the server address first' }
      return testOpenAI({ key: d.secrets.read('custom'), baseUrl: p.customBaseUrl, chatModel: p.customModel, transcribeModel: '' })
    },
  }
}

export function serverHandlers(d: { settings: SettingsStore; secrets: SecretStore; test: ServerTest }) {
  return {
    get: () => serversOf(d.settings.get()),
    set: (list: unknown) => setServers(d.settings, d.secrets.remove, list),
    test: async (id: unknown) => {
      if (typeof id !== 'string' || !SERVER_ID.test(id)) throw new Error('Invalid server')
      const server = serversOf(d.settings.get()).find((s) => s.id === id)
      if (!server) return { ok: false, tools: 0, error: 'No such server' }
      try {
        const r = await d.test(server, d.secrets.read(`mcp:${id}` as SecretName))
        // the list crosses IPC: capped, and every string bounded
        const toolList = Array.isArray(r.toolList)
          ? r.toolList.slice(0, 200).map(t => ({ name: String(t.name).slice(0, 100), description: String(t.description ?? '').slice(0, 300) }))
          : undefined
        return { ok: !!r.ok, tools: Number.isFinite(r.tools) ? r.tools : 0, ...(r.error ? { error: String(r.error).slice(0, 300) } : {}), ...(toolList ? { toolList } : {}) }
      } catch (err) {
        return { ok: false, tools: 0, error: err instanceof Error ? err.message.slice(0, 300) : 'Test failed' }
      }
    },
  }
}

export function secretHandlers(d: { settings: SettingsStore; secrets: SecretStore }) {
  return {
    set: (name: unknown, value: unknown) => {
      if (!isSecretName(name) || typeof value !== 'string') {
        throw new Error('Invalid secret')
      }
      d.secrets.write(name, value)
      return secretStatus(d.secrets.read, [...new Set([...defaultSecretNames(d.settings.get()), name])])
    },
    status: (names?: unknown) => secretStatus(d.secrets.read, secretNamesFrom(d.settings.get(), names)),
  }
}
