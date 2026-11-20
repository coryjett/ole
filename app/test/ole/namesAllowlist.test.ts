import { describe, expect, it } from 'vitest'
import { mayGetNames } from '../../src/main/ole/core/enrich'

const t = (tool: string, o: { openWorld?: boolean; description?: string; serverName?: string } = {}) =>
  ({ tool, description: o.description ?? '', serverName: o.serverName ?? 'CRM', openWorld: o.openWorld })

describe('the closed-world hint is necessary, never sufficient (#91)', () => {
  it('a closed-world tool still has to pass the web and docs checks', () => {
    expect(mayGetNames(t('get_account_details', { openWorld: false }))).toBe(true)
    expect(mayGetNames(t('search_web', { openWorld: false }))).toBe(false)
    expect(mayGetNames(t('get_contact', { openWorld: false, description: 'Searches the web for a person' }))).toBe(false)
  })
  it("the server's name is checked too", () => {
    expect(mayGetNames(t('get_contact', { openWorld: false, serverName: 'Web search' }))).toBe(false)
    expect(mayGetNames(t('get_contact', { serverName: 'Docs' }))).toBe(false)
  })
  it('open-world never; unknown needs a record-lookup name', () => {
    expect(mayGetNames(t('get_account_details', { openWorld: true }))).toBe(false)
    expect(mayGetNames(t('get_account_details'))).toBe(true)
    expect(mayGetNames(t('summarize_week'))).toBe(false)
  })
})
