import { MARK } from '../../../shared/logo'

/** The Ole mark. */
export function Logo({ size = 28, className = 'text-accent' }: { size?: number; className?: string }) {
  return (
    <svg data-testid="logo" role="img" aria-label="Ole" width={size} height={size} viewBox="0 0 100 100" className={`shrink-0 ${className}`}>
      <path fill="currentColor" d={MARK} />
    </svg>
  )
}

/** The mark with the name next to it, as on the website. Sized by its height. */
export function Wordmark({ height = 32 }: { height?: number }) {
  return (
    <svg data-testid="wordmark" role="img" aria-label="Ole" height={height} width={(height * 200) / 80} viewBox="0 0 200 80" className="shrink-0">
      <path style={{ fill: 'color-mix(in srgb, var(--primary), var(--accent))' }} transform="translate(0 5) scale(.65)" d={MARK} />
      <text className="text-ink" fill="currentColor" x="82" y="58" fontSize="58" fontWeight="700" letterSpacing="-1" fontFamily="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif">Ole</text>
    </svg>
  )
}
