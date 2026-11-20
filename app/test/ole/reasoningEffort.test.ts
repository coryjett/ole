import { describe, expect, it, vi } from 'vitest'
import { openaiChat } from '../../src/main/ole/core/openai'

const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), { status: 200 })
const bodyOf = (f: ReturnType<typeof vi.fn<typeof fetch>>, i = 0) => JSON.parse(String(f.mock.calls[i][1]?.body))
const tools = [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }]

describe('reasoning_effort with tools (#3)', () => {
  it("sends reasoning_effort 'none' when tools are offered", async () => {
    const f = vi.fn<typeof fetch>(async () => ok())
    await openaiChat({ key: 'k-123456', model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'q' }], tools, fetch: f })
    expect(bodyOf(f).reasoning_effort).toBe('none')
  })
  it('leaves it out without tools', async () => {
    const f = vi.fn<typeof fetch>(async () => ok())
    await openaiChat({ key: 'k-123456', model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'q' }], fetch: f })
    expect('reasoning_effort' in bodyOf(f)).toBe(false)
  })
  it('asks again without it for a model that does not know the parameter', async () => {
    const f = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } }), { status: 400 }))
      .mockResolvedValueOnce(ok())
    const m = await openaiChat({ key: 'k-123456', model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'q' }], tools, fetch: f })
    expect(m.content).toBe('hi')
    expect(f).toHaveBeenCalledTimes(2)
    expect('reasoning_effort' in bodyOf(f, 1)).toBe(false)
    expect(bodyOf(f, 1).tools).toHaveLength(1)
  })
})
