'use client'
import Image from 'next/image'

// Client-neutral logo renderer. When the client has uploaded a logo (settings.logo_url),
// show it exactly as before. When they haven't, render a placeholder derived from the park's
// OWN data — the park name's initial(s) in a badge shaped by settings.logo_shape and tinted
// with settings.accent_color — so no other client's logo is ever served as a default.

type Props = {
  logoUrl?: string | null
  parkName?: string | null
  shape?: string | null        // 'circle' | 'rounded' | 'square'
  accentColor?: string | null
  size?: number                // px (square)
  className?: string
}

function shapeClass(shape?: string | null): string {
  if (shape === 'rounded') return 'rounded-xl'
  if (shape === 'square') return 'rounded-none'
  return 'rounded-full' // 'circle' / default
}

// First letters of up to two words: "Pine Ridge RV Park" → "PR", "Lakeshore" → "L".
function initials(name?: string | null): string {
  const words = (name || '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  if (words.length === 1) return words[0][0].toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export default function LogoBadge({ logoUrl, parkName, shape, accentColor, size = 48, className = '' }: Props) {
  const shp = shapeClass(shape)

  if (logoUrl) {
    return (
      <div className={`${shp} overflow-hidden flex-shrink-0 ${className}`} style={{ width: size, height: size }}>
        <Image src={logoUrl} alt={parkName || 'Campground'} width={size} height={size} className="object-contain w-full h-full" />
      </div>
    )
  }

  const accent = accentColor || '#2D6A4F' // template default (neutral green), never a client asset
  return (
    <div
      className={`${shp} flex-shrink-0 flex items-center justify-center font-bold text-white select-none ${className}`}
      style={{ width: size, height: size, backgroundColor: accent, fontSize: Math.round(size * 0.42) }}
      role="img"
      aria-label={parkName || 'Campground'}
    >
      {initials(parkName)}
    </div>
  )
}
