// Ole on Yogurt: bullet ratings (core/feedback.ts) over Yogurt's settings file.
import { feedbackOf as of, FEEDBACK_KEEP, recordRating as record, type Feedback } from '../core/feedback'
import { loadSettings } from '../../settings'
import { fileSettings } from './settingsFile'

export { FEEDBACK_KEEP, type Feedback }

export const feedbackOf = (file: string): Feedback => of(loadSettings(file))
export const recordRating = (file: string, text: string, rating: 'up' | 'down' | null): Feedback => record(fileSettings(file), text, rating)
