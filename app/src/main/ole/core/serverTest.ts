// Ole: Settings' Test button for an MCP server.
import { createMcpClient, McpError } from './mcp'
import { boundedSchema, isReadOnly } from './tools'
import type { McpServerConfig } from './types'

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
