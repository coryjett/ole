import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isRecommended, MODEL_ADVICE } from '../../src/renderer/src/ole/modelAdvice'
import { ModelSelect } from '../../src/renderer/src/ole/OleSettings'

describe('recommended model class (#13)', () => {
  it('transcription: speech-to-text models', () => {
    expect(isRecommended('transcribe', 'gpt-4o-mini-transcribe')).toBe(true)
    expect(isRecommended('transcribe', 'gpt-4o-transcribe')).toBe(true)
    expect(isRecommended('transcribe', 'gpt-5.6-luna')).toBe(false)
  })
  it('prepare: mid or large tiers, never nano or mini', () => {
    expect(isRecommended('prepare', 'gpt-5.6-terra')).toBe(true)
    expect(isRecommended('prepare', 'gpt-5')).toBe(true)
    expect(isRecommended('prepare', 'gpt-5.6-luna')).toBe(false)
    expect(isRecommended('prepare', 'gpt-5-nano')).toBe(false)
    expect(isRecommended('prepare', 'gpt-4.1-mini')).toBe(false)
  })
  it('live: small fast tiers, never nano or speech models', () => {
    expect(isRecommended('live', 'gpt-5.6-luna')).toBe(true)
    expect(isRecommended('live', 'gpt-4.1-mini')).toBe(true)
    expect(isRecommended('live', 'gpt-5.6-terra')).toBe(false)
    expect(isRecommended('live', 'gpt-5-nano')).toBe(false)
    expect(isRecommended('live', 'gpt-4o-mini-transcribe')).toBe(false)
  })
  it('the dropdown shows the advice and marks recommended models', () => {
    const html = renderToStaticMarkup(createElement(ModelSelect, { id: 'p', role: 'prepare', label: 'Prepare model', hint: 'h', value: 'gpt-5.6-luna', options: ['gpt-5.6-terra', 'gpt-5.6-luna'], disabled: false, onChange: () => {} }))
    expect(html).toContain(MODEL_ADVICE.prepare.split('.')[0])
    expect(html).toContain('gpt-5.6-terra (recommended)')
    expect(html).not.toContain('gpt-5.6-luna (recommended)')
  })
})
