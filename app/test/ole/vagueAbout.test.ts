import { describe, expect, it } from 'vitest'
import { onlyHeadings } from '../../src/main/ole/core/bullets'

describe('"About <topic>" is not a source (#119)', () => {
  it('treats About / Re / Regarding / Topic forms as vague', () => {
    for (const s of ['About extProc', 'about rate limiting', 'Re: SSO', 'Regarding JWT validation', 'Topic: pricing']) expect(onlyHeadings(s, new Set())).toBe(true)
  })
  it('keeps real record sources', () => {
    for (const s of ['call notes, 12 Nov', 'issue #412', 'product docs', 'docs.example.com › jwt', 'opportunity: About Face Inc']) expect(onlyHeadings(s, new Set())).toBe(false)
  })
})
