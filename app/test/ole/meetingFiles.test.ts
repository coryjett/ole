import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { oleMeetingFile } from '../../src/main/ole/yogurt/meetingFiles'
import { cleanOrg } from '../../src/main/ole/core/orgTitle'

const base = '/tmp/ole-data'
const id = '00000000-0000-4000-8000-000000000154'

describe('per-meeting files only for real meeting ids (#156)', () => {
  it('builds the path under meetings/ for a meeting UUID and a known file', () => {
    expect(oleMeetingFile(base, id, 'ole-org.json')).toBe(resolve(base, 'meetings', id, 'ole-org.json'))
  })
  it('refuses anything else', () => {
    expect(() => oleMeetingFile(base, '../../etc', 'ole-org.json')).toThrow()
    expect(() => oleMeetingFile(base, `${id}/..`, 'ole-org.json')).toThrow()
    expect(() => oleMeetingFile(base, id, '../secrets.json' as never)).toThrow()
  })
})

describe('org names are cleaned (#156)', () => {
  it('drops control, zero-width and direction characters', () => {
    expect(cleanOrg('Exa‮mple​ Corp\u0007')).toBe('Example Corp')
  })
})
