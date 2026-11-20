import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isRecommended, MODEL_ADVICE, modelLabel } from '../../src/renderer/src/ole/modelAdvice'
import { ModelSelect } from '../../src/renderer/src/ole/OleSettings'

describe('recommended model class (#13)', () => {
  it('transcription: the current speech-to-text model, never a retiring or Realtime-only one (#89)', () => {
    expect(isRecommended('transcribe', 'gpt-transcribe')).toBe(true)
    expect(isRecommended('transcribe', 'gpt-4o-mini-transcribe')).toBe(false)
    expect(isRecommended('transcribe', 'gpt-4o-transcribe')).toBe(false)
    expect(isRecommended('transcribe', 'whisper-1')).toBe(false)
    expect(isRecommended('transcribe', 'gpt-live-transcribe')).toBe(false)
    expect(isRecommended('transcribe', 'gpt-5.6-luna')).toBe(false)
    expect(MODEL_ADVICE.transcribe).toContain('Recommended: gpt-transcribe')
    expect(MODEL_ADVICE.transcribe).toContain('February 26, 2027')
  })
  it('labels: recommended, retiring with its date, or just the name (#89)', () => {
    expect(modelLabel('transcribe', 'gpt-transcribe')).toBe('gpt-transcribe (recommended)')
    expect(modelLabel('transcribe', 'gpt-4o-mini-transcribe')).toBe('gpt-4o-mini-transcribe (retiring February 26, 2027)')
    expect(modelLabel('transcribe', 'gpt-4o-mini-transcribe-2025-03-20')).toBe('gpt-4o-mini-transcribe-2025-03-20 (retiring December 1, 2026)')
    expect(modelLabel('prepare', 'gpt-5.6-terra')).toBe('gpt-5.6-terra (recommended)')
    expect(modelLabel('live', 'gpt-5.6-terra')).toBe('gpt-5.6-terra')
  })
  it('the transcription dropdown shows retiring models from the account but does not offer them (#89)', () => {
    const html = renderToStaticMarkup(createElement(ModelSelect, { id: 't', role: 'transcribe', label: 'Transcription model', hint: 'h', value: 'gpt-transcribe', options: ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'], disabled: false, onChange: () => {} }))
    expect(html).toContain('gpt-transcribe (recommended)')
    expect(html).toMatch(/<option value="gpt-4o-mini-transcribe" disabled="">gpt-4o-mini-transcribe \(retiring February 26, 2027\)<\/option>/)
    expect(html).toMatch(/<option value="whisper-1" disabled="">whisper-1 \(retiring February 26, 2027\)/)
    expect(html).not.toMatch(/<option value="gpt-transcribe"[^>]*disabled/)
    expect(html).toContain(MODEL_ADVICE.transcribe.split(',')[0])
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
