import { LockClosedIcon } from '@heroicons/react/24/outline'

/*
 * A quiet reassurance cue for the card-entry area: a lock plus the four card networks
 * Square accepts. Purely presentational — no settings, no data, no per-client variation.
 * Every client shows exactly this.
 *
 * The marks are inline SVG rather than a card-icon dependency or hosted images: four static
 * marks aren't worth a package's supply-chain and bundle cost, and inline means there is no
 * external request to fail and nothing to go blurry at any size.
 *
 * These are trademarks, so each is a clean recognizable rendering in the official brand
 * colors rather than a copy of the exact trademark artwork — the standard treatment for an
 * accepted-payment-mark row, and what stays readable at this size.
 */

// Every mark sits on its own white chip. Visa's and Amex's blues are dark enough to vanish
// against the dark theme's --surface-card (#2B2B2B), so the chip — not the page — is what
// guarantees contrast, and it makes the row read consistently in both themes. The hairline
// stroke keeps the chip from glaring as a white block against the dark surface.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <>
      <rect x="0.5" y="0.5" width="43" height="27" rx="4" fill="#FFFFFF" stroke="rgba(0,0,0,0.14)" />
      {children}
    </>
  )
}

const svgProps = {
  width: 44,
  height: 28,
  viewBox: '0 0 44 28',
  xmlns: 'http://www.w3.org/2000/svg',
  role: 'img' as const,
  className: 'flex-shrink-0',
}

function VisaMark() {
  return (
    <svg {...svgProps} aria-label="Visa">
      <Chip>
        <text
          x="22" y="18.5" textAnchor="middle"
          fontFamily="Helvetica, Arial, sans-serif" fontSize="11" fontWeight="700"
          fontStyle="italic" letterSpacing="0.5" fill="#1434CB"
        >VISA</text>
      </Chip>
    </svg>
  )
}

function MastercardMark() {
  return (
    <svg {...svgProps} aria-label="Mastercard">
      <Chip>
        {/* The interlocking circles carry the recognition on their own — no wordmark needed. */}
        <circle cx="18" cy="14" r="7" fill="#EB001B" />
        <circle cx="26" cy="14" r="7" fill="#F79E1B" />
        {/* The overlap, clipped to the left circle so the lens reads as the real mark does. */}
        <clipPath id="ptr-mc-overlap">
          <circle cx="18" cy="14" r="7" />
        </clipPath>
        <circle cx="26" cy="14" r="7" fill="#FF5F00" clipPath="url(#ptr-mc-overlap)" />
      </Chip>
    </svg>
  )
}

function AmexMark() {
  return (
    <svg {...svgProps} aria-label="American Express">
      <Chip>
        <rect x="4" y="4" width="36" height="20" rx="2.5" fill="#006FCF" />
        <text
          x="22" y="17.5" textAnchor="middle"
          fontFamily="Helvetica, Arial, sans-serif" fontSize="8" fontWeight="700"
          letterSpacing="0.3" fill="#FFFFFF"
        >AMEX</text>
      </Chip>
    </svg>
  )
}

function DiscoverMark() {
  return (
    <svg {...svgProps} aria-label="Discover">
      <Chip>
        {/* Eight characters in a 44-wide chip: the wordmark has to stay small and sit left of
            the sphere, or the sphere covers the final R and it reads "DISCOVE". */}
        <text
          x="18" y="16.8" textAnchor="middle"
          fontFamily="Helvetica, Arial, sans-serif" fontSize="5.2" fontWeight="700"
          letterSpacing="0.1" fill="#4D4D4D"
        >DISCOVER</text>
        {/* The orange sphere is the part people actually recognize at a glance. */}
        <circle cx="37" cy="14" r="4.2" fill="#FF6000" />
      </Chip>
    </svg>
  )
}

export default function PaymentTrustRow() {
  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {/* The label already says "Secure payment", so the lock is decorative to a screen
          reader — announcing it again would just be noise. */}
      <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <LockClosedIcon className="w-4 h-4" aria-hidden="true" />
        Secure payment
      </span>
      <span className="inline-flex items-center gap-1.5">
        <VisaMark />
        <MastercardMark />
        <AmexMark />
        <DiscoverMark />
      </span>
    </div>
  )
}
