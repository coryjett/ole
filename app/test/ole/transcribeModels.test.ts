import { describe, expect, it } from 'vitest'
import { migrateTranscribeModel, retireDateText, TRANSCRIBE_SUCCESSOR, transcribeModelRetires } from '../../src/main/ole/core/transcribeModels'
import { PROVIDER_DEFAULTS } from '../../src/main/ole/core/providers'

// #89: OpenAI retires whisper-1 and the gpt-4o transcribe models; gpt-transcribe replaces them on /audio/transcriptions
describe('retiring transcription models (#89)', () => {
  it('the default is the supported successor, which is not retiring', () => {
    expect(TRANSCRIBE_SUCCESSOR).toBe('gpt-transcribe')
    expect(PROVIDER_DEFAULTS.openaiTranscribeModel).toBe('gpt-transcribe')
    expect(transcribeModelRetires('gpt-transcribe')).toBeNull()
    expect(transcribeModelRetires('gpt-live-transcribe')).toBeNull()
  })
  it('names the shutdown date of each retiring model', () => {
    for (const m of ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe-2025-12-15', 'gpt-4o-transcribe-diarize'])
      expect(transcribeModelRetires(m)).toBe('2027-02-26')
    expect(transcribeModelRetires('gpt-4o-mini-transcribe-2025-03-20')).toBe('2026-12-01')
    // a dated snapshot the table doesn't name goes with its family
    expect(transcribeModelRetires('gpt-4o-transcribe-2025-06-01')).toBe('2027-02-26')
    expect(transcribeModelRetires(' GPT-4o-Mini-Transcribe ')).toBe('2027-02-26')
    expect(transcribeModelRetires('my-whisper-1-finetune')).toBeNull()
  })
  it('maps a retiring model to the successor and says what it was', () => {
    expect(migrateTranscribeModel('gpt-4o-mini-transcribe')).toEqual({ model: 'gpt-transcribe', switched: { from: 'gpt-4o-mini-transcribe', to: 'gpt-transcribe', retires: '2027-02-26' } })
    expect(migrateTranscribeModel('whisper-1').model).toBe('gpt-transcribe')
    expect(migrateTranscribeModel('gpt-transcribe')).toEqual({ model: 'gpt-transcribe', switched: null })
  })
  it('writes the date in words, the same day everywhere', () => {
    expect(retireDateText('2027-02-26')).toBe('February 26, 2027')
    expect(retireDateText('2026-12-01')).toBe('December 1, 2026')
    expect(retireDateText('not a date')).toBe('not a date')
  })
})
