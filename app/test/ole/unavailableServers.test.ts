import { describe, expect, it, vi } from 'vitest'
import { collectTools, unavailableReason, type ToolServer } from '../../src/main/ole/core/tools'
import { McpError } from '../../src/main/ole/core/mcp'

const server = (id: string, listTools: () => Promise<unknown[]>): ToolServer => ({
  config: { id, name: id.toUpperCase(), url: `https://${id}.example/mcp`, enabled: true },
  client: { listTools, callTool: vi.fn(), listPrompts: vi.fn(async () => []), getPrompt: vi.fn() } as never,
})

describe("servers Ole couldn't use are reported, never skipped silently (#33)", () => {
  it('names each failed server with a short reason, and keeps the working ones', async () => {
    const seen: Array<{ name: string; reason: string }> = []
    const tools = await collectTools([
      server('crm', async () => { throw new McpError('The MCP server rejected the key', 'auth') }),
      server('docs', async () => [{ name: 'get_page', inputSchema: { type: 'object' } }]),
      server('tix', async () => { throw new McpError('MCP server unreachable', 'unreachable') }),
    ], u => seen.push(u))
    expect(tools.map(t => t.tool)).toEqual(['get_page'])
    expect(seen).toEqual([{ name: 'CRM', reason: 'key rejected' }, { name: 'TIX', reason: "couldn't be reached" }])
  })
  it('reasons in a few words', () => {
    expect(unavailableReason(new McpError('x', 'timeout'))).toBe('timed out')
    expect(unavailableReason(new Error('odd failure'))).toBe('odd failure')
  })
})
