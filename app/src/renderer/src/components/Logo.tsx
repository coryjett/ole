import mark from '../assets/ole-mark.png'

/** The Ole mark. */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return <img data-testid="logo" src={mark} alt="¡ole!" width={size} height={size} className={`shrink-0 ${className}`} draggable={false} />
}

/** The mark with the name next to it, as on the website. Sized by its height. */
export function Wordmark({ height = 32 }: { height?: number }) {
  return (
    <span data-testid="wordmark" role="img" aria-label="¡ole!" className="inline-flex shrink-0 items-center" style={{ height, gap: height * 0.3 }}>
      <img src={mark} alt="" width={height} height={height} draggable={false} />
      <span className="text-ink" aria-hidden="true" style={{ fontSize: height * 0.82, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1 }}>¡ole!</span>
    </span>
  )
}
