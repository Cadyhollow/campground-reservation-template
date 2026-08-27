'use client'

import { useEffect, useState, useRef } from 'react'
import { createBrowserSupabase } from '@/lib/supabase-browser'

// Security PR 7-1: the admin browser talks to Supabase as the LOGGED-IN USER, not as `anon`.
// Same publishable key, but it travels with the session cookie, so PostgREST runs these queries
// as `authenticated` and the role-gated RLS policies apply. Safe at module scope:
// createBrowserClient returns a singleton in the browser and a no-op cookie store during
// prerender.
const supabase = createBrowserSupabase()
import toast, { Toaster } from 'react-hot-toast'
import Image from 'next/image'
import imageCompression from 'browser-image-compression'
// The same arithmetic the guest-facing date picker and the server-side gate use, so the date this
// page previews to the owner is exactly the last date a guest will be able to choose.
import { resolveMaxAdvanceDays, horizonLastArrival, parseMonthDay } from '@/lib/bookability'

// Hero photos come straight off phones, where 8-15MB and 4000px+ on the long edge is normal.
// Downscaling in the browser before the upload keeps the landing page quick — the whole point
// of serving the hero server-side in the first place. Only the hero does this: the logo is
// routinely a transparent PNG, and a canvas round-trip would flatten that transparency.
const HERO_MAX_EDGE = 2400   // px on the long edge — plenty for a full-bleed hero
const HERO_TARGET_MB = 1.5   // what compression aims at
const HERO_MAX_MB = 5        // hard ceiling, now enforced on the *compressed* result
const HERO_ABSURD_MB = 50    // refuse to even hand this to the decoder

// A canvas round-trip destroys these: SVG rasterizes to a fixed size, GIF loses every frame
// past the first. They skip compression and upload untouched.
const HERO_PASSTHROUGH_TYPES = ['image/svg+xml', 'image/gif']

const formatMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

// HEIC is what iPhones shoot by default. Safari decodes it; Chrome and Firefox don't — and a
// browser that can't decode a format frequently reports an empty file.type for it, so the
// filename is the more dependable of the two signals. Check both.
function isHeic(file: File) {
  const type = file.type.toLowerCase()
  return type === 'image/heic' || type === 'image/heif' || /\.hei[cf]$/i.test(file.name)
}

// Only reached when this browser genuinely failed to decode the file, so "this browser" is
// accurate and Safari is a real way out.
const HERO_HEIC_MESSAGE = "This looks like an iPhone HEIC photo, which this browser can't display. Save it as a JPEG — or upload from Safari — and try again."

// The logo is refused regardless of browser (see uploadLogoFile), so this one deliberately
// doesn't offer Safari as an escape hatch — uploading it there would still leave visitors on
// other browsers with a broken logo.
const LOGO_HEIC_MESSAGE = "This looks like an iPhone HEIC photo. Not every visitor's browser can display HEIC, so please save it as a JPEG or PNG and try again."

const defaultSettings = {
  park_name: '',
  park_tagline: '',
  park_email: '',
  park_phone: '',
  park_address: '',
  park_website: '',
  park_location: '',
  logo_url: '',
  logo_shape: 'circle',
  hero_image_url: '',
  check_in_time: '2:00 PM',
  check_out_time: '12:00 PM',
  same_day_cutoff_time: '11:00 AM',
  same_day_cutoff_message: 'Same-day reservations are not available online. Please call us to book.',
  // Held as a STRING, not a number, so that '' can mean "no booking window" distinctly from 0.
  // Empty is the default and the provisioned state: an owner who has never opened this field has
  // no horizon, exactly as before the column existed.
  max_advance_days: '',
  extra_adult_fee: '',
  extra_child_fee: '',
  base_occupancy_adults: 2,
  base_occupancy_children: 2,
  total_sites: 84,
  total_cabins: 3,
  auto_sync_guests: false,
  max_credit_amount: 0,
  cancellation_policy: '',
  early_checkin_enabled: false,
  early_checkin_price: 0,
  early_checkin_time: '12:00',
  early_checkin_show_customers: false,
  late_checkout_enabled: false,
  late_checkout_price: 0,
  late_checkout_time: '12:00',
  late_checkout_show_customers: false,
  confirmation_message: '',
  accent_color: '#2D6A4F',
  theme: 'light',
  show_site_map: false,
  season_start: 'May 1',
  season_end: 'October 11',
  closed_season_message: 'We are closed for the season. We look forward to welcoming you back next year!',
  waiver_enabled: true,
  waiver_text: '',
  contract_text: '',
  packet_email_intro: '',
  maintenance_mode: false,
  maintenance_message: 'We are temporarily unavailable for online reservations. Please call us to book your stay!',
  deposit_type: 'first_night',
  deposit_value: 0,
  custom_payment_methods: [] as string[],
  // ── PETS ────────────────────────────────────────────────────────────────────────────────────
  // pets_enabled is the master switch: while it is false, NOTHING else here is rendered, so a
  // park that does not take pets never sees the feature at all.
  pets_enabled: false,
  // Held as a STRING for the same reason extra_adult_fee is: the input is dollars and the column
  // is cents, and a half-typed "1." must not become 0 mid-keystroke.
  pet_fee_amount: '0.00',
  pet_fee_per_night: false,
  pet_fee_per_pet: false,
  // String, so '' can mean "no limit" distinctly from a typed 0 — both save as 0, but the field
  // should not show a 0 the owner never entered.
  pet_max: '',
  pet_rules_text: '',
  pet_rules_require_affirmation: false,
  pet_fee_taxable: false,
  pet_fee_surcharged: false,
  service_animal_allowed: true,
}

export default function SettingsPage() {
  const [form, setForm] = useState(defaultSettings)
  const [settingsId, setSettingsId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [newMethod, setNewMethod] = useState('')
  const [plan, setPlan] = useState('trailhead')
  // The `theme` column doesn't exist in every tenant's settings table yet. Detected from the
  // loaded row so the selector both hides itself until the column lands AND stays out of the
  // save payload — writing an unknown column fails the whole update and would take every
  // other setting down with it. Self-activates once the column exists; no code change needed.
  const [hasThemeColumn, setHasThemeColumn] = useState(false)
  // Same story for `hero_image_url` — detected from the loaded row so the control hides
  // itself, stays out of the save payload, AND can't run an upload that would write to a
  // column that isn't there yet (which would fail the write and orphan the uploaded file).
  const [hasHeroColumn, setHasHeroColumn] = useState(false)
  // Same pattern, and here it is not a nicety. The pet columns exist in the canonical schema and
  // on the Test Sandbox, but were DELIBERATELY not applied to live tenants — see
  // resonation-admin/db/2026-08-18-pet-fee.sql. This page sends ONE payload containing every
  // column, and one unknown column fails the whole UPDATE: without this guard, shipping the pet
  // section would stop an existing park from saving its phone number. Detected from the loaded
  // row, so it self-activates the moment a tenant is migrated, with no code change.
  const [hasPetColumns, setHasPetColumns] = useState(false)
  const [hasPacketIntroColumn, setHasPacketIntroColumn] = useState(false)
  const [earlyPriceInput, setEarlyPriceInput] = useState('0.00')
  const [latePriceInput, setLatePriceInput] = useState('0.00')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [uploadingHero, setUploadingHero] = useState(false)
  const [heroDragging, setHeroDragging] = useState(false)
  const [heroError, setHeroError] = useState('')
  // Distinct from uploadingHero only for the label — compression can take a beat on a big
  // photo, and a silent pause reads as a hang. uploadingHero stays true throughout, so the
  // disabled states hold for both stages.
  const [optimizingHero, setOptimizingHero] = useState(false)
  const [logoDragging, setLogoDragging] = useState(false)
  const [logoError, setLogoError] = useState('')
  useEffect(() => { setEarlyPriceInput((form.early_checkin_price / 100).toFixed(2)) }, [form.early_checkin_price])
  useEffect(() => { setLatePriceInput((form.late_checkout_price / 100).toFixed(2)) }, [form.late_checkout_price])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const heroInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { fetchSettings() }, [])

  async function fetchSettings() {
    const { data } = await supabase.from('settings').select('*').limit(1).single()
    if (data) {
      setSettingsId(data.id)
      setPlan(data.plan || 'trailhead')
      setHasThemeColumn('theme' in data)
      setHasHeroColumn('hero_image_url' in data)
      setHasPetColumns('pets_enabled' in data)
      // Phase 3 column — a tenant that has not run the migration must not be offered a field whose
      // save would fail. Same pattern as hero_image_url and the pet columns.
      setHasPacketIntroColumn('packet_email_intro' in data)
      setForm({
        park_name: data.park_name || '',
        park_tagline: data.park_tagline || '',
        park_email: data.park_email || '',
        park_phone: data.park_phone || '',
        park_address: data.park_address || '',
        park_website: data.park_website || '',
        park_location: data.park_location || '',
        logo_url: data.logo_url || '',
        logo_shape: data.logo_shape || 'circle',
        hero_image_url: data.hero_image_url || '',
        check_in_time: data.check_in_time || '2:00 PM',
        check_out_time: data.check_out_time || '12:00 PM',
        same_day_cutoff_time: data.same_day_cutoff_time || '11:00 AM',
        same_day_cutoff_message: data.same_day_cutoff_message || 'Same-day reservations are not available online. Please call us to book.',
        // An explicit null check, not the `|| ''` this file uses everywhere else. `||` is falsy-
        // based, so it would render a stored 0 as blank — and blank means "no window" here, so an
        // owner would be shown a park with no horizon while the row actually held a value that
        // lib/bookability.ts treats as garbage. Whatever is in the row is what appears in the field.
        max_advance_days: data.max_advance_days === null || data.max_advance_days === undefined
          ? ''
          : String(data.max_advance_days),
        extra_adult_fee: (data.extra_adult_fee / 100).toString(),
        extra_child_fee: (data.extra_child_fee / 100).toString(),
        base_occupancy_adults: data.base_occupancy_adults || 2,
        base_occupancy_children: data.base_occupancy_children || 2,
        total_sites: data.total_sites || 84,
        total_cabins: data.total_cabins || 3,
        auto_sync_guests: data.auto_sync_guests || false,
        max_credit_amount: data.max_credit_amount || 0,
        cancellation_policy: data.cancellation_policy || '',
        early_checkin_enabled: data.early_checkin_enabled || false,
        early_checkin_price: data.early_checkin_price || 0,
        early_checkin_time: data.early_checkin_time || '12:00',
        early_checkin_show_customers: data.early_checkin_show_customers || false,
        late_checkout_enabled: data.late_checkout_enabled || false,
        late_checkout_price: data.late_checkout_price || 0,
        late_checkout_time: data.late_checkout_time || '12:00',
        late_checkout_show_customers: data.late_checkout_show_customers || false,
        confirmation_message: data.confirmation_message || '',
        accent_color: data.accent_color || '#2D6A4F',
        theme: data.theme === 'dark' ? 'dark' : 'light',
        show_site_map: data.show_site_map || false,
        season_start: data.season_start || 'May 1',
        season_end: data.season_end || 'October 11',
        closed_season_message: data.closed_season_message || 'We are closed for the season. We look forward to welcoming you back next year!',
        waiver_enabled: data.waiver_enabled !== false,
        waiver_text: data.waiver_text || '',
        contract_text: data.contract_text || '',
        packet_email_intro: data.packet_email_intro || '',
        maintenance_mode: data.maintenance_mode || false,
        maintenance_message: data.maintenance_message || 'We are temporarily unavailable for online reservations. Please call us to book your stay!',
        pets_enabled: data.pets_enabled || false,
        pet_fee_amount: ((data.pet_fee_amount || 0) / 100).toFixed(2),
        pet_fee_per_night: data.pet_fee_per_night || false,
        pet_fee_per_pet: data.pet_fee_per_pet || false,
        // Explicit null check rather than `||`: 0 means "no limit" and is a real stored value,
        // but it should read back as blank so the owner sees the same thing they left.
        pet_max: data.pet_max === null || data.pet_max === undefined || data.pet_max === 0
          ? ''
          : String(data.pet_max),
        pet_rules_text: data.pet_rules_text || '',
        pet_rules_require_affirmation: data.pet_rules_require_affirmation || false,
        pet_fee_taxable: data.pet_fee_taxable || false,
        pet_fee_surcharged: data.pet_fee_surcharged || false,
        // Defaults ON when absent. A park must opt OUT of honouring service animals, never in.
        service_animal_allowed: data.service_animal_allowed !== false,
        deposit_type: data.deposit_type || 'first_night',
        deposit_value: data.deposit_value || 0,
        custom_payment_methods: data.custom_payment_methods || [],
      })
    }
    setLoading(false)
  }

  // Single upload path for the logo; the file picker and the drop zone are both just entry
  // points into it. Same shape as uploadHeroFile below, at the logo's own 2MB cap.
  async function uploadLogoFile(file: File) {
    setLogoError('')
    // Nothing on this path decodes or re-encodes the logo, so a HEIC would land in storage
    // untouched and break for every visitor whose browser can't read it. A decode probe would
    // pass in Safari and let exactly that through, so refuse HEIC outright instead. Checked
    // ahead of the gate below because HEIC frequently arrives with an empty type.
    if (isHeic(file)) {
      setLogoError(LOGO_HEIC_MESSAGE); toast.error(LOGO_HEIC_MESSAGE); return
    }
    if (!file.type.startsWith('image/')) {
      const message = "That file isn't an image. Please choose a PNG, JPG or SVG."
      setLogoError(message); toast.error(message); return
    }
    if (file.size > 2 * 1024 * 1024) {
      const message = `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. Please choose one under 2MB.`
      setLogoError(message); toast.error(message); return
    }
    setUploadingLogo(true)
    const fileExt = file.name.split('.').pop()
    const fileName = `logo-${Date.now()}.${fileExt}`
    const { error: uploadError } = await supabase.storage.from('logos').upload(fileName, file, { upsert: true })
    if (uploadError) { toast.error('Error uploading logo.'); setUploadingLogo(false); return }
    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(fileName)
    const publicUrl = urlData.publicUrl
    const { error: updateError } = await supabase.from('settings').update({ logo_url: publicUrl }).eq('id', settingsId)
    if (updateError) { toast.error('Error saving logo URL.'); setUploadingLogo(false); return }
    setForm({ ...form, logo_url: publicUrl })
    toast.success('Logo uploaded successfully!')
    setUploadingLogo(false)
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadLogoFile(file)
    // Clear the input so re-picking the same file after a rejection still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleLogoDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!uploadingLogo) setLogoDragging(true)
  }

  function handleLogoDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setLogoDragging(false)
  }

  async function handleLogoDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setLogoDragging(false)
    if (uploadingLogo) return
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    await uploadLogoFile(file)
  }

  // Mirrors handleLogoUpload — same bucket, same immediate write so the hero applies without
  // a separate Save. The cap is 5MB rather than the logo's 2MB: a full-width landscape photo
  // at a usable resolution routinely lands between 2 and 4MB.
  //
  // Both ways in — the file picker and the drop zone — funnel through this one function, so
  // there is a single upload path and the two entry points can't drift apart. Rejections set
  // an inline message next to the drop zone as well as the toast, since a dropped file is
  // easy to walk away from before a toast is noticed.
  async function uploadHeroFile(file: File) {
    setHeroError('')
    const heic = isHeic(file)
    // A HEIC often arrives with an empty type, which would trip this gate and report the wrong
    // problem entirely. Let it through to the decode attempt below, which gives a real answer.
    if (!file.type.startsWith('image/') && !heic) {
      const message = "That file isn't an image. Please choose a PNG or JPG."
      setHeroError(message); toast.error(message); return
    }
    // Cheap guard before the decoder sees anything: something this large would lock the tab up
    // for seconds on its way to failing anyway.
    if (file.size > HERO_ABSURD_MB * 1024 * 1024) {
      const message = `That image is ${formatMb(file.size)}MB. Please choose one under ${HERO_ABSURD_MB}MB.`
      setHeroError(message); toast.error(message); return
    }

    setUploadingHero(true)
    let upload = file
    // Skip work that can't pay off: formats a canvas would ruin, and files already at target.
    // maxWidthOrHeight only ever shrinks, so an image under the cap keeps its dimensions.
    //
    // HEIC is the exception and always goes through, however small. The decode attempt is what
    // tells us whether this browser can read it at all, and the re-encode is what stops a .heic
    // reaching storage — where every visitor on a browser that can't decode it sees a broken
    // hero. Without this, a sub-1.5MB iPhone photo would skip the check and upload broken.
    const mustCompress = heic ||
      (!HERO_PASSTHROUGH_TYPES.includes(file.type) && file.size > HERO_TARGET_MB * 1024 * 1024)
    if (mustCompress) {
      setOptimizingHero(true)
      let decodeFailed = false
      try {
        const compressed = await imageCompression(file, {
          maxWidthOrHeight: HERO_MAX_EDGE,
          maxSizeMB: HERO_TARGET_MB,
          initialQuality: 0.85,
          useWebWorker: true,
          // Safari decodes HEIC happily, but the result would round-trip back out as HEIC and
          // be just as unreadable elsewhere. Pin the output to JPEG so what we store displays
          // everywhere.
          ...(heic ? { fileType: 'image/jpeg' } : {}),
        })
        // Keep the original name — fileExt below reads from it — and whatever type the
        // compressor actually emitted. A converted HEIC needs the extension to follow suit.
        const name = heic ? file.name.replace(/\.hei[cf]$/i, '.jpg') : file.name
        upload = new File([compressed], name, { type: compressed.type || file.type })
      } catch {
        decodeFailed = true
      }
      setOptimizingHero(false)

      // A HEIC this browser can't decode is one it can't display either, so say so plainly
      // rather than falling back and storing something that renders as a broken image.
      if (decodeFailed && heic) {
        setHeroError(HERO_HEIC_MESSAGE); toast.error(HERO_HEIC_MESSAGE); setUploadingHero(false); return
      }
      // Any other decode oddity keeps the old behaviour: carry on with the original file
      // (upload is still it) and let the ceiling below decide.
    }

    // The ceiling runs on the compressed result, so the big phone photo that used to bounce
    // now sails through. Only something still oversized after optimizing gets refused.
    if (upload.size > HERO_MAX_MB * 1024 * 1024) {
      const message = `That image is still ${formatMb(upload.size)}MB after optimizing. Please choose a smaller one.`
      setHeroError(message); toast.error(message); setUploadingHero(false); return
    }

    const fileExt = upload.name.split('.').pop()
    const fileName = `hero-${Date.now()}.${fileExt}`
    const { error: uploadError } = await supabase.storage.from('logos').upload(fileName, upload, { upsert: true })
    if (uploadError) { toast.error('Error uploading hero image.'); setUploadingHero(false); return }
    const { data: urlData } = supabase.storage.from('logos').getPublicUrl(fileName)
    const publicUrl = urlData.publicUrl
    const { error: updateError } = await supabase.from('settings').update({ hero_image_url: publicUrl }).eq('id', settingsId)
    if (updateError) { toast.error('Error saving hero image.'); setUploadingHero(false); return }
    setForm({ ...form, hero_image_url: publicUrl })
    toast.success('Hero image uploaded successfully!')
    setUploadingHero(false)
  }

  async function handleHeroUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadHeroFile(file)
    // Clear the input so re-picking the same file after a rejection still fires onChange.
    if (heroInputRef.current) heroInputRef.current.value = ''
  }

  // preventDefault on dragover is what makes the element a valid drop target; without it the
  // browser falls back to opening the dropped file in the tab.
  function handleHeroDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!uploadingHero) setHeroDragging(true)
  }

  // dragleave also fires when the pointer crosses onto a child node, so only drop the
  // highlight once the pointer has genuinely left the zone's subtree.
  function handleHeroDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setHeroDragging(false)
  }

  async function handleHeroDrop(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setHeroDragging(false)
    if (uploadingHero) return
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    await uploadHeroFile(file)
  }

  // Clearing to '' (not null) keeps the column's type simple; the landing page treats an
  // empty string as unset and falls back to the plain header band.
  async function handleHeroRemove() {
    const { error } = await supabase.from('settings').update({ hero_image_url: '' }).eq('id', settingsId)
    if (error) { toast.error('Error removing hero image.'); return }
    setForm({ ...form, hero_image_url: '' })
    if (heroInputRef.current) heroInputRef.current.value = ''
    toast.success('Hero image removed.')
  }

  // Bounds for the booking window. 1095 days is three years — past that an owner is almost
  // certainly typing a year rather than a day count, and a horizon that long is indistinguishable
  // from none. 0 is refused outright: lib/bookability.ts reads it as "no window" (a cleared field
  // is far likelier than a park meaning same-day-only), so letting it be SAVED here would store a
  // value whose meaning does not match what the owner just typed.
  const HORIZON_MIN_DAYS = 1
  const HORIZON_MAX_DAYS = 1095

  async function handleSave() {
    // Validated before anything is sent, and it BLOCKS the save rather than silently coercing.
    // This whole page writes one payload containing every column, so a quietly-corrected value
    // would be saved alongside the owner's real edits with nothing to show it had been changed.
    const rawHorizon = String(form.max_advance_days ?? '').trim()
    let horizonDays: number | null = null
    if (rawHorizon !== '') {
      const n = Number(rawHorizon)
      if (!Number.isInteger(n) || n < HORIZON_MIN_DAYS || n > HORIZON_MAX_DAYS) {
        toast.error(`Booking window must be a whole number of days between ${HORIZON_MIN_DAYS} and ${HORIZON_MAX_DAYS}, or blank for no limit.`)
        return
      }
      horizonDays = n
    }

    // ── SEASON TEXT IS VALIDATED HERE, AND THIS IS WHAT MAKES FAIL-OPEN SAFE ────────────────
    //
    // checkSeasonSpan treats an unreadable season as "no season" and keeps taking bookings,
    // because a park going dark on every date is a worse failure than one that misses a closure.
    // That default is only defensible if a mistyped season is caught the moment it is typed —
    // otherwise a park writes "Oct 31st!", saves happily, and discovers months later that its
    // closed period never existed.
    //
    // So the same parser the gate uses runs here, and refuses the save. The message names the
    // offending value and shows a form that works, because "invalid date" would leave an owner
    // guessing which of the two fields is wrong and why.
    //
    // Both bounds are optional — a park with no season configured is a real, supported state —
    // but anything non-empty has to be readable.
    for (const [label, value] of [
      ['Season Opens', form.season_start],
      ['Season Closes', form.season_end],
    ] as const) {
      const text = String(value ?? '').trim()
      if (text !== '' && !parseMonthDay(text)) {
        toast.error(`${label}: "${text}" isn't a date we recognize — try "October 31".`)
        return
      }
    }

    // ── PET VALIDATION ─────────────────────────────────────────────────────────────────────
    //
    // Only when the tenant HAS the columns and the owner has switched pets on — a park with the
    // feature off cannot be blocked by a field it has never seen.
    //
    // Blocks the save rather than coercing, for the reason at the top of this function: one
    // payload carries every column, so a quietly-corrected value would ride along with the
    // owner's real edits and nothing would show it had been changed.
    let petAmountCents = 0
    let petMaxValue = 0
    if (hasPetColumns && form.pets_enabled) {
      const rawAmount = String(form.pet_fee_amount ?? '').trim()
      const amount = rawAmount === '' ? 0 : Number(rawAmount)
      if (!Number.isFinite(amount) || amount < 0) {
        toast.error('Pet fee must be a positive amount, or 0.')
        return
      }
      petAmountCents = Math.round(amount * 100)

      const rawMax = String(form.pet_max ?? '').trim()
      if (rawMax !== '') {
        const n = Number(rawMax)
        if (!Number.isInteger(n) || n < 0) {
          toast.error('Max pets must be a whole number, or blank for no limit.')
          return
        }
        petMaxValue = n
      }

      // A per-pet or per-night mode multiplies the amount, so leaving the amount at zero while
      // switching a mode on is almost certainly a half-finished setup rather than a park that
      // means to charge nothing. Caught here rather than discovered by a guest seeing $0.00.
      if (petAmountCents === 0 && (form.pet_fee_per_night || form.pet_fee_per_pet)) {
        toast.error('Enter a pet fee amount, or turn off "per night" and "per pet".')
        return
      }
    }

    setSaving(true)
    const payload = {
      park_name: form.park_name,
      park_tagline: form.park_tagline,
      park_email: form.park_email,
      park_phone: form.park_phone,
      park_address: form.park_address,
      park_website: form.park_website,
      park_location: form.park_location,
      logo_shape: form.logo_shape,
      check_in_time: form.check_in_time,
      check_out_time: form.check_out_time,
      same_day_cutoff_time: form.same_day_cutoff_time,
      same_day_cutoff_message: form.same_day_cutoff_message,
      // NULL, not 0 and not '', when the field is blank — NULL is what lib/bookability.ts and the
      // canonical schema both treat as "no window".
      max_advance_days: horizonDays,
      extra_adult_fee: Math.round(parseFloat(form.extra_adult_fee) * 100),
      extra_child_fee: Math.round(parseFloat(form.extra_child_fee) * 100),
      base_occupancy_adults: form.base_occupancy_adults,
      base_occupancy_children: form.base_occupancy_children,
      total_sites: form.total_sites,
      total_cabins: form.total_cabins,
      auto_sync_guests: form.auto_sync_guests,
      max_credit_amount: form.max_credit_amount,
      cancellation_policy: form.cancellation_policy,
      early_checkin_enabled: form.early_checkin_enabled,
      early_checkin_price: form.early_checkin_price,
      early_checkin_time: form.early_checkin_time,
      early_checkin_show_customers: form.early_checkin_show_customers,
      late_checkout_enabled: form.late_checkout_enabled,
      late_checkout_price: form.late_checkout_price,
      late_checkout_time: form.late_checkout_time,
      late_checkout_show_customers: form.late_checkout_show_customers,
      confirmation_message: form.confirmation_message,
      accent_color: form.accent_color,
      // Only written when the column exists — see hasThemeColumn above.
      ...(hasThemeColumn ? { theme: form.theme } : {}),
      // Likewise. The upload/remove handlers already persist this on their own, so this is
      // just keeping Save consistent with the rest of the form — guarded for the same reason:
      // one unknown column fails the whole update and takes every other setting with it.
      ...(hasHeroColumn ? { hero_image_url: form.hero_image_url } : {}),
      show_site_map: form.show_site_map,
      season_start: form.season_start,
      season_end: form.season_end,
      closed_season_message: form.closed_season_message,
      waiver_enabled: form.waiver_enabled,
      waiver_text: form.waiver_text,
      contract_text: form.contract_text,
      ...(hasPacketIntroColumn ? { packet_email_intro: form.packet_email_intro } : {}),
      maintenance_mode: form.maintenance_mode,
      maintenance_message: form.maintenance_message,
      deposit_type: form.deposit_type,
      deposit_value: form.deposit_value || 0,
      custom_payment_methods: form.custom_payment_methods || [],
      // Only written when the tenant has the columns — see hasPetColumns above. On a tenant
      // without them this spreads to nothing and the save behaves exactly as it did before the
      // pet feature existed.
      ...(hasPetColumns ? {
        pets_enabled: form.pets_enabled,
        pet_fee_amount: petAmountCents,
        pet_fee_per_night: form.pet_fee_per_night,
        pet_fee_per_pet: form.pet_fee_per_pet,
        // 0 = no limit, which is also what a blank field means. See the column comment in the
        // migration: 0 must never be read as "no pets allowed".
        pet_max: petMaxValue,
        // NULL rather than '' when blank, matching the column's default and keeping "never
        // written" distinguishable from "deliberately cleared".
        pet_rules_text: form.pet_rules_text.trim() === '' ? null : form.pet_rules_text,
        pet_rules_require_affirmation: form.pet_rules_require_affirmation,
        pet_fee_taxable: form.pet_fee_taxable,
        pet_fee_surcharged: form.pet_fee_surcharged,
        service_animal_allowed: form.service_animal_allowed,
      } : {}),
    }
    if (settingsId) {
      const { error } = await supabase.from('settings').update(payload).eq('id', settingsId)
      if (error) { toast.error('Error saving settings.'); setSaving(false); return }
    } else {
      const { error } = await supabase.from('settings').insert(payload)
      if (error) { toast.error('Error saving settings.'); setSaving(false); return }
    }
    toast.success('Settings saved!')
    await new Promise(resolve => setTimeout(resolve, 500))
    setSaving(false)
    fetchSettings()
  }

  // What the owner's number actually means today, in dates. A park owner thinks in "next
  // September", not in "412 days", so the field shows both. Recomputed on every render rather than
  // memoized — it is one date addition, and it must not go stale as they type.
  // Spells out, in a sentence, what the amount and the two switches actually add up to.
  //
  // "per pet" and "per night" read as alternatives rather than as multipliers, so an owner can
  // easily set both and be surprised by the total. Worked through on a concrete 2-pet, 3-night
  // stay, the four modes are unmistakable — and this is the only place the owner sees the
  // arithmetic before a guest does.
  const petModeSentence = (() => {
    const dollars = Number(String(form.pet_fee_amount ?? '').trim())
    if (!Number.isFinite(dollars) || dollars <= 0) return 'Enter an amount to see how it will be charged.'
    const money = (n: number) => `$${n.toFixed(2)}`
    const per = form.pet_fee_per_pet, night = form.pet_fee_per_night
    const example = dollars * (per ? 2 : 1) * (night ? 3 : 1)
    const basis =
      per && night ? `${money(dollars)} per pet, per night`
      : per ? `${money(dollars)} per pet for the whole stay`
      : night ? `${money(dollars)} per night, no matter how many pets`
      : `${money(dollars)} once for the whole stay, no matter how many pets`
    return `${basis}. A guest bringing 2 pets for 3 nights would pay ${money(example)}.`
  })()

  const horizonPreviewDays = resolveMaxAdvanceDays(form.max_advance_days)
  const horizonPreviewDate = horizonPreviewDays === null
    ? null
    : horizonLastArrival(horizonPreviewDays, new Date().toISOString().split('T')[0])

  if (loading) return <div className="flex items-center justify-center h-64"><div className="text-gray-500">Loading settings...</div></div>

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Toaster />
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
          <p className="text-sm text-gray-500 mt-1">Manage your park information and booking rules.</p>
        </div>
        <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>

      <div className="space-y-6">

        {/* Logo */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Logo</h3>
          <div className="flex items-center gap-6 mb-4">
            <div className={`w-24 h-24 overflow-hidden border border-gray-200 flex items-center justify-center bg-gray-50 flex-shrink-0 ${
              form.logo_shape === 'circle' ? 'rounded-full' :
              form.logo_shape === 'rounded' ? 'rounded-xl' :
              form.logo_shape === 'square' ? 'rounded-none' : 'rounded-none bg-transparent border-dashed'
            }`}>
              {form.logo_url ? (
                <Image src={form.logo_url} alt="Campground logo" width={96} height={96} className="object-contain w-full h-full" />
              ) : (
                <span className="text-gray-400 text-xs text-center px-2">No logo uploaded</span>
              )}
            </div>
            <div className="flex-1">
              <input type="file" accept="image/*" ref={fileInputRef} onChange={handleLogoUpload} className="hidden" />
              {/* Same drop-target pattern as the hero below — clicking opens the very same picker
                  the button does, so drag and click share one upload path. */}
              <div
                role="button"
                tabIndex={0}
                aria-label="Drag an image here, or click to browse"
                onClick={() => { if (!uploadingLogo) fileInputRef.current?.click() }}
                onKeyDown={e => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.preventDefault()
                  if (!uploadingLogo) fileInputRef.current?.click()
                }}
                onDragEnter={handleLogoDragOver}
                onDragOver={handleLogoDragOver}
                onDragLeave={handleLogoDragLeave}
                onDrop={handleLogoDrop}
                className={`rounded-lg border-2 border-dashed px-4 py-4 text-center text-sm transition-colors ${
                  uploadingLogo
                    ? 'cursor-wait border-gray-200 bg-gray-50 text-gray-400'
                    : logoDragging
                      ? 'cursor-copy border-green-500 bg-green-50 text-green-700'
                      : 'cursor-pointer border-gray-300 bg-gray-50 text-gray-500 hover:border-green-400 hover:text-green-700'
                }`}
              >
                {uploadingLogo ? 'Uploading…' : logoDragging ? 'Drop to upload' : 'Drag an image here, or click to browse'}
              </div>
              {logoError && <p className="text-xs text-red-600 mt-2">{logoError}</p>}
              <button onClick={() => fileInputRef.current?.click()} disabled={uploadingLogo} className="mt-3 bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
                {uploadingLogo ? 'Uploading...' : 'Upload New Logo'}
              </button>
              <p className="text-xs text-gray-400 mt-2">PNG, JPG or SVG. Max 2MB.</p>
              {form.logo_url && <p className="text-xs text-green-600 mt-1">✓ Logo uploaded</p>}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Logo Display Shape</label>
            <select className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.logo_shape} onChange={e => setForm({ ...form, logo_shape: e.target.value })}>
              <option value="circle">Circle — round crop</option>
              <option value="rounded">Rounded Square — soft corners</option>
              <option value="square">Square — sharp corners</option>
              <option value="original">Original — no crop, transparent background</option>
            </select>
          </div>

          {/* Rendered only once the settings row actually carries a `hero_image_url` key, so
              this stays invisible (and unsaved, and un-uploadable) on tenants whose column
              hasn't landed yet. Same pattern as the theme selector below. */}
          {hasHeroColumn && (
            <div className="mt-6 pt-6 border-t border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900 mb-1">Hero Image</h3>
              <p className="text-sm text-gray-500 mb-4">A wide photo shown behind the booking form on your landing page. Leave it empty and the page keeps its plain header band.</p>
              <div className="flex items-start gap-6">
                <div className="w-56 h-32 overflow-hidden rounded-lg border border-gray-200 flex items-center justify-center bg-gray-50 flex-shrink-0 relative">
                  {form.hero_image_url ? (
                    <Image src={form.hero_image_url} alt="Landing page hero" fill sizes="224px" className="object-cover" />
                  ) : (
                    <span className="text-gray-400 text-xs text-center px-2">No hero image set</span>
                  )}
                </div>
                <div className="flex-1">
                  <input type="file" accept="image/*" ref={heroInputRef} onChange={handleHeroUpload} className="hidden" />
                  {/* Drop target. Clicking it opens the very same picker the button below does,
                      so drag and click are two ways into one upload path. */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Drag an image here, or click to browse"
                    onClick={() => { if (!uploadingHero) heroInputRef.current?.click() }}
                    onKeyDown={e => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      if (!uploadingHero) heroInputRef.current?.click()
                    }}
                    onDragEnter={handleHeroDragOver}
                    onDragOver={handleHeroDragOver}
                    onDragLeave={handleHeroDragLeave}
                    onDrop={handleHeroDrop}
                    className={`rounded-lg border-2 border-dashed px-4 py-5 text-center text-sm transition-colors ${
                      uploadingHero
                        ? 'cursor-wait border-gray-200 bg-gray-50 text-gray-400'
                        : heroDragging
                          ? 'cursor-copy border-green-500 bg-green-50 text-green-700'
                          : 'cursor-pointer border-gray-300 bg-gray-50 text-gray-500 hover:border-green-400 hover:text-green-700'
                    }`}
                  >
                    {optimizingHero ? 'Optimizing…' : uploadingHero ? 'Uploading…' : heroDragging ? 'Drop to upload' : 'Drag an image here, or click to browse'}
                  </div>
                  {heroError && <p className="text-xs text-red-600 mt-2">{heroError}</p>}
                  <div className="flex items-center gap-2 mt-3">
                    <button onClick={() => heroInputRef.current?.click()} disabled={uploadingHero} className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800 disabled:opacity-50">
                      {optimizingHero ? 'Optimizing...' : uploadingHero ? 'Uploading...' : form.hero_image_url ? 'Replace Hero Image' : 'Upload Hero Image'}
                    </button>
                    {form.hero_image_url && (
                      <button onClick={handleHeroRemove} disabled={uploadingHero} className="border border-gray-200 text-gray-600 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50">
                        Remove
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">PNG or JPG. Big photos straight off a phone are fine — they&rsquo;re resized and compressed automatically. A wide landscape photo works best.</p>
                  {form.hero_image_url && <p className="text-xs text-green-600 mt-1">✓ Hero image set</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Park Information */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Park Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Park Name</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_name} onChange={e => setForm({ ...form, park_name: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Tagline</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_tagline} onChange={e => setForm({ ...form, park_tagline: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Location</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Port Allegany, PA" value={form.park_location} onChange={e => setForm({ ...form, park_location: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Email</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" type="email" value={form.park_email} onChange={e => setForm({ ...form, park_email: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Phone</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_phone} onChange={e => setForm({ ...form, park_phone: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Address</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_address} onChange={e => setForm({ ...form, park_address: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Website</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.park_website} onChange={e => setForm({ ...form, park_website: e.target.value })} /></div>

            {/* THE SENDER FIELDS THAT USED TO BE HERE DID NOTHING — removed 2026-08-19.
                "Sender Email", "Reply-To Email" and a "Use Custom Sender" switch were collected
                here and written to `settings`, and NO SENDING CODE EVER READ THEM. An owner could
                type a sender address, save it successfully, and every email would keep going out
                from the same place. A control that accepts input and silently discards it is
                worse than no control.

                How sending actually works, and why it should stay this way: every email goes out
                as `"{park_name}" <RESEND_FROM_EMAIL>` with Reply-To set to `settings.park_email`.
                The address is a ResoNation-owned one, the same for every client; the park's name
                is what a guest sees, and a reply reaches the park. That is deliberate — a sending
                domain has to be DNS-verified with the provider, so verifying ONE ResoNation domain
                covers every client forever, instead of asking each park owner to add DNS records
                to their own domain before their first confirmation email can go out. One warmed
                domain also lands in inboxes more reliably than twenty cold ones.

                The park's own address is still collected — it is the "Email" field above
                (`park_email`), which is what Reply-To uses and what guests see as the contact.

                THE DATABASE COLUMNS ARE LEFT IN PLACE (sender_email, reply_to_email,
                use_custom_sender, sender_name). Dropping columns is not an additive change and
                would need a migration on every tenant to remove something already inert. If
                per-client sending domains are ever built, they are still here to use. */}


            <div><label className="block text-sm font-medium text-gray-700 mb-1">Brand Color</label><div className="flex items-center gap-3"><input type="color" className="w-12 h-10 rounded border border-gray-200 cursor-pointer" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /><input className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono" value={form.accent_color} onChange={e => setForm({ ...form, accent_color: e.target.value })} /></div></div>

            {/* Rendered only once the settings row actually carries a `theme` key, so this
                stays invisible (and unsaved) on tenants whose column hasn't landed yet. */}
            {hasThemeColumn && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Booking Site Theme</label>
                <select
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                  value={form.theme}
                  onChange={e => setForm({ ...form, theme: e.target.value })}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">Applies to your camper-facing booking pages, not this admin area.</p>
              </div>
            )}
          </div>

          {/* Show Site Map — Ridgeline and Summit only */}
          {['ridgeline', 'summit'].includes(plan) && (
            <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-700">Show Site Map</p>
                <p className="text-xs text-gray-500 mt-0.5">{form.show_site_map ? 'Guests see the interactive map when browsing sites.' : 'Guests see a list view when browsing sites.'}</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, show_site_map: !form.show_site_map })}
                className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-6"
                style={{ backgroundColor: form.show_site_map ? '#15803d' : '#d1d5db' }}>
                <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                  style={{ transform: form.show_site_map ? 'translateX(28px)' : 'translateX(0px)' }} />
              </button>
            </div>
          )}
        </div>

        {/* Booking Rules */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Booking Rules</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Check-In Time</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.check_in_time} onChange={e => setForm({ ...form, check_in_time: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Check-Out Time</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.check_out_time} onChange={e => setForm({ ...form, check_out_time: e.target.value })} /></div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Same-Day Booking Cutoff</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. 11:00 AM (leave blank to allow all day)" value={form.same_day_cutoff_time} onChange={e => setForm({ ...form, same_day_cutoff_time: e.target.value })} />
              <p className="text-xs text-gray-400 mt-1">Leave blank to allow same-day bookings at any time.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Same-Day Cutoff Message</label>
              <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Please call for same-day reservations." value={form.same_day_cutoff_message} onChange={e => setForm({ ...form, same_day_cutoff_message: e.target.value })} />
              <p className="text-xs text-gray-400 mt-1">Shown to guests when same-day booking is blocked.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Booking Window (days ahead)</label>
              <input
                type="number"
                min={HORIZON_MIN_DAYS}
                max={HORIZON_MAX_DAYS}
                step="1"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                placeholder="e.g. 365 (leave blank for no limit)"
                value={form.max_advance_days}
                onChange={e => setForm({ ...form, max_advance_days: e.target.value })}
              />
              <p className="text-xs text-gray-400 mt-1">
                {form.max_advance_days === ''
                  ? 'No limit — guests can book any future date.'
                  : `Guests can book arrivals up to ${form.max_advance_days} day${form.max_advance_days === '1' ? '' : 's'} ahead${horizonPreviewDate ? ` (through ${horizonPreviewDate})` : ''}.`}
              </p>
              <p className="text-xs text-gray-400 mt-1">Applies to the arrival date. A stay that starts inside the window may end outside it. Staff can still book beyond it from the booking pages.</p>
            </div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Base Occupancy — Adults</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.base_occupancy_adults} onChange={e => setForm({ ...form, base_occupancy_adults: parseInt(e.target.value) })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Base Occupancy — Children</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.base_occupancy_children} onChange={e => setForm({ ...form, base_occupancy_children: parseInt(e.target.value) })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Extra Adult Fee ($/night)</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.extra_adult_fee} onChange={e => setForm({ ...form, extra_adult_fee: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Extra Child Fee ($/night)</label><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.extra_child_fee} onChange={e => setForm({ ...form, extra_child_fee: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Total Campsites</label><p className="text-xs text-gray-400 mb-1">Non-cabin sites at your campground (used for occupancy reporting)</p><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.total_sites} onChange={e => setForm({ ...form, total_sites: parseInt(e.target.value) || 0 })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Total Cabins</label><p className="text-xs text-gray-400 mb-1">Cabin units tracked separately in occupancy reporting</p><input type="number" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.total_cabins} onChange={e => setForm({ ...form, total_cabins: parseInt(e.target.value) || 0 })} /></div>
            <div className="col-span-full"><label className="block text-sm font-medium text-gray-700 mb-1">Automatic Guest Sync</label><p className="text-xs text-gray-400 mb-2">Automatically add guests to your Guest Directory as reservations come in. Leave this off while testing so test bookings don't get added — you can always use the manual Sync button.</p><div className="flex items-center gap-3"><button type="button" onClick={() => setForm({...form, auto_sync_guests: !form.auto_sync_guests})} style={{width:44,height:24,borderRadius:12,border:'none',cursor:'pointer',backgroundColor:form.auto_sync_guests?'#15803d':'#d1d5db',position:'relative',flexShrink:0,transition:'background 0.2s'}}><span style={{position:'absolute',top:3,left:form.auto_sync_guests?23:3,width:18,height:18,borderRadius:'50%',backgroundColor:'white',transition:'left 0.2s'}}/></button><span className="text-sm text-gray-700">{form.auto_sync_guests ? 'Enabled' : 'Disabled'}</span></div></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Maximum Credit Balance (seasonal campers)</label><p className="text-xs text-gray-400 mb-1">Allow seasonal campers to carry a credit balance up to this amount. Set to $0 to disallow credits — any overpayment will trigger a warning.</p><div className="flex items-center gap-2"><span className="text-sm text-gray-500">$</span><input type="number" min="0" step="1" className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm" value={form.max_credit_amount / 100} onChange={e => setForm({ ...form, max_credit_amount: Math.round(parseFloat(e.target.value || '0') * 100) })} /></div><p className="text-xs text-gray-400 mt-1">{form.max_credit_amount === 0 ? 'Credits disabled — staff will be warned before recording an overpayment' : `Staff can record payments that leave up to $${(form.max_credit_amount/100).toFixed(2)} credit on account`}</p></div>
          </div>
        </div>

        {/* Deposit */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Deposit</h3>
          <p className="text-sm text-gray-500 mb-4">Choose how much guests pay up front when booking. The remaining balance is collected at or before arrival.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Deposit Type</label>
              <select
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                value={form.deposit_type}
                onChange={e => setForm({ ...form, deposit_type: e.target.value, deposit_value: 0 })}
              >
                <option value="first_night">First night — first night&apos;s rate plus a share of fees</option>
                <option value="percentage">Percentage of total — a set percent of the full reservation</option>
                <option value="flat">Flat amount — a fixed dollar deposit</option>
                <option value="full">Paid in full — guests pay the entire balance at booking</option>
              </select>
            </div>

            {form.deposit_type === 'percentage' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Deposit Percentage</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" max="100" step="1" className="w-28 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={form.deposit_value}
                    onChange={e => setForm({ ...form, deposit_value: Math.min(parseInt(e.target.value) || 0, 100) })} />
                  <span className="text-sm text-gray-500">% of the reservation total</span>
                </div>
                <p className="text-xs text-gray-400 mt-1">Example: 50 means guests pay half up front.</p>
              </div>
            )}

            {form.deposit_type === 'flat' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Deposit Amount</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">$</span>
                  <input type="number" min="0" step="1" className="w-32 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                    value={form.deposit_value / 100}
                    onChange={e => setForm({ ...form, deposit_value: Math.round(parseFloat(e.target.value || '0') * 100) })} />
                </div>
                <p className="text-xs text-gray-400 mt-1">Capped at the reservation total so it never exceeds the balance.</p>
              </div>
            )}
          </div>
        </div>

        {/* Payment Methods */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Payment Methods</h3>
          <p className="text-sm text-gray-500 mb-4">Cash, Card, and Check are always available. Add any other ways your guests pay — like Venmo, PayPal, Cash App, or Zelle — and they’ll appear as options everywhere you record a payment.</p>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Always available</label>
            <div className="flex flex-wrap gap-2">
              {['Cash', 'Card', 'Check'].map(m => (
                <span key={m} className="inline-flex items-center gap-1 text-sm bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full font-medium">
                  {m}
                </span>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Your additional methods</label>
            {form.custom_payment_methods.length === 0 ? (
              <p className="text-sm text-gray-400 italic">None yet — add one below.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {form.custom_payment_methods.map((m: string) => (
                  <span key={m} className="inline-flex items-center gap-2 text-sm bg-green-50 text-green-800 border border-green-200 px-3 py-1.5 rounded-full font-medium capitalize">
                    {m}
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, custom_payment_methods: form.custom_payment_methods.filter((x: string) => x !== m) })}
                      className="text-green-600 hover:text-green-900 font-bold leading-none"
                      aria-label={'Remove ' + m}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="e.g. PayPal"
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
              value={newMethod}
              onChange={e => setNewMethod(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const v = newMethod.trim().toLowerCase()
                  if (v && !['cash','card','check'].includes(v) && !form.custom_payment_methods.includes(v)) {
                    setForm({ ...form, custom_payment_methods: [...form.custom_payment_methods, v] })
                  }
                  setNewMethod('')
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                const v = newMethod.trim().toLowerCase()
                if (v && !['cash','card','check'].includes(v) && !form.custom_payment_methods.includes(v)) {
                  setForm({ ...form, custom_payment_methods: [...form.custom_payment_methods, v] })
                }
                setNewMethod('')
              }}
              className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
            >
              Add
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">Remember to click Save at the bottom to apply your changes.</p>
        </div>

        {/* Season Dates */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Season Dates</h3>
          <p className="text-sm text-gray-500 mb-4">Customers will see a closed message if they search dates outside your season.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Season Opens</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. May 1" value={form.season_start} onChange={e => setForm({ ...form, season_start: e.target.value })} /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1">Season Closes</label><input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" placeholder="e.g. October 11" value={form.season_end} onChange={e => setForm({ ...form, season_end: e.target.value })} /></div>
            <div className="md:col-span-2"><label className="block text-sm font-medium text-gray-700 mb-1">Closed Season Message</label><textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={2} value={form.closed_season_message} onChange={e => setForm({ ...form, closed_season_message: e.target.value })} /></div>
          </div>
        </div>

        {/* Confirmation Email Message */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Confirmation Email Message</h3>
          <p className="text-sm text-gray-500 mb-4">This message appears in the <strong>Important Information</strong> section of every customer confirmation email. Separate paragraphs with a blank line.</p>
          <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed" rows={12} placeholder="Enter directions, check-in instructions, rules, or anything guests need to know before they arrive..." value={form.confirmation_message} onChange={e => setForm({ ...form, confirmation_message: e.target.value })} />
          <p className="text-xs text-gray-400 mt-2">💡 Tip: Leave a blank line between paragraphs and each one will appear as its own paragraph in the email.</p>
        </div>

        {/* Cancellation Policy */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Cancellation Policy</h3>
          <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={4} value={form.cancellation_policy} onChange={e => setForm({ ...form, cancellation_policy: e.target.value })} />
        </div>

        {/* Liability Waiver */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Liability Waiver</h3>
          <p className="text-sm text-gray-500 mb-4">Control whether guests must sign a liability waiver during checkout. If enabled, guests will read and sign before paying.</p>
          <div className="flex items-center justify-between mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div>
              <p className="text-sm font-medium text-gray-900">Require liability waiver at checkout</p>
              <p className="text-xs text-gray-500 mt-0.5">{form.waiver_enabled ? 'Guests must read and sign the waiver before they can pay.' : 'No waiver will be shown to guests during checkout.'}</p>
            </div>
            <button type="button" onClick={() => setForm({ ...form, waiver_enabled: !form.waiver_enabled })}
              className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
              style={{ backgroundColor: form.waiver_enabled ? '#15803d' : '#d1d5db' }}>
              <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                style={{ transform: form.waiver_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
            </button>
          </div>
          {form.waiver_enabled && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Waiver Text</label>
              <p className="text-xs text-gray-400 mb-2">Write your full liability waiver here. Use <strong>[CAMPGROUND NAME]</strong> as a placeholder — it will be automatically replaced with your park name when guests see it.</p>
              <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed" rows={16}
                placeholder="Enter your liability waiver text here. Use [CAMPGROUND NAME] where your park name should appear..."
                value={form.waiver_text} onChange={e => setForm({ ...form, waiver_text: e.target.value })} />
              <p className="text-xs text-gray-400 mt-2">💡 Tip: Consult with a legal professional to ensure your waiver is appropriate for your property and jurisdiction.</p>
            </div>
          )}
        </div>

        {/* ── SEASONAL PACKET ──────────────────────────────────────────────────────────────
            The seasonal agreement's body and the invitation email that carries it.

            ⚠ THE CONTRACT BODY EDITOR IS NEW HERE, AND IT CLOSES A REAL GAP RATHER THAN ADDING A
            FEATURE. settings.contract_text is provisioned for every park and is READ by the
            packet preview, the review screen and freezePacket — but before this there was no UI
            anywhere in the app to SET it. Every merge token added across Phases 1–3
            ({{charge_note}}, {{season_name}}, {{deposit_due}}, the due-by dates) was therefore
            unreachable for a real park, and freezePacket's empty-document guard would refuse to
            send at all until somebody edited the row by hand. */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Seasonal Packet</h3>
          <p className="text-sm text-gray-500 mb-4">
            The agreement your seasonal campers sign, and the email that invites them to sign it.
          </p>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">Seasonal Contract Text</label>
            <p className="text-xs text-gray-400 mb-2">
              The body of the seasonal admission agreement. A packet cannot be sent while this is empty.
              Use the merge fields below and they are filled in for each camper.
            </p>
            <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed" rows={14}
              placeholder="SEASONAL ADMISSION AGREEMENT — {{season_name}}&#10;&#10;Between the campground and {{name}} of:&#10;{{home_address}}&#10;&#10;Site {{site_number}}, from {{opens}} to {{closes}}."
              value={form.contract_text} onChange={e => setForm({ ...form, contract_text: e.target.value })} />
            <p className="text-xs text-gray-400 mt-2">
              💡 Consult a legal professional to make sure your agreement suits your property and jurisdiction.
            </p>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Packet Invitation Email</label>
            <p className="text-xs text-gray-400 mb-2">
              The message in the email that asks a camper to sign. Plain text is fine — for example your winter
              payment instructions. <strong>Leave it blank to use the standard message.</strong> The greeting and the
              &ldquo;Review &amp; Sign Packet&rdquo; button are always included, so the link can never be lost.
            </p>
            <textarea
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-sans leading-relaxed"
              rows={6}
              disabled={!hasPacketIntroColumn}
              placeholder={'Your ' + '{{season_name}}' + ' packet is ready to sign. Your deposit of ' + '{{deposit_due}}' + ' is due by ' + '{{deposit_due_by}}' + '.\nOver the winter we accept cheques at the office.'}
              value={form.packet_email_intro} onChange={e => setForm({ ...form, packet_email_intro: e.target.value })} />
            {!hasPacketIntroColumn && (
              <p className="text-xs text-amber-700 mt-1">
                This park&rsquo;s database does not have this field yet — it arrives with the next update.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-xs font-semibold text-gray-600 mb-1">Merge fields (usable in both boxes above)</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              <code>{'{{name}}'}</code> <code>{'{{site_number}}'}</code> <code>{'{{season_name}}'}</code>{' '}
              <code>{'{{opens}}'}</code> <code>{'{{closes}}'}</code> <code>{'{{total_due}}'}</code>{' '}
              <code>{'{{deposit_due}}'}</code> <code>{'{{total_due_by}}'}</code> <code>{'{{deposit_due_by}}'}</code>{' '}
              <code>{'{{charge_note}}'}</code> <code>{'{{party_names}}'}</code> <code>{'{{camper_make_year}}'}</code>{' '}
              <code>{'{{home_address}}'}</code> <code>{'{{year}}'}</code>
            </p>
            <p className="text-xs text-gray-400 mt-2">
              A field with nothing behind it prints as blank — never as the raw <code>{'{{…}}'}</code> text.
            </p>
          </div>
        </div>

        {/* Maintenance Mode */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">Early Check-In & Late Check-Out</h3>
          <p className="text-sm text-gray-500 mb-4">Offer guests the option to check in early or check out late for an additional fee. When shown to customers, early check-in will be automatically hidden if another guest is checking out of the same site that day.</p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">Early Check-In</p>
                <button type="button" onClick={() => setForm({ ...form, early_checkin_enabled: !form.early_checkin_enabled })}
                  className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                  style={{ backgroundColor: form.early_checkin_enabled ? '#15803d' : '#d1d5db' }}>
                  <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.early_checkin_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
                </button>
              </div>
              {form.early_checkin_enabled && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Fee</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01"
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm"
                        value={earlyPriceInput}
                        onChange={e => setEarlyPriceInput(e.target.value)}
                        onBlur={() => setForm({ ...form, early_checkin_price: Math.round((parseFloat(earlyPriceInput) || 0) * 100) })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Earliest available check-in time</label>
                    <input type="time"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={form.early_checkin_time}
                      onChange={e => setForm({ ...form, early_checkin_time: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <p className="text-xs font-medium text-gray-700">Show to customers at booking</p>
                      <p className="text-xs text-gray-400">Auto-hidden if same-day checkout on that site</p>
                    </div>
                    <button type="button" onClick={() => setForm({ ...form, early_checkin_show_customers: !form.early_checkin_show_customers })}
                      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                      style={{ backgroundColor: form.early_checkin_show_customers ? '#15803d' : '#d1d5db' }}>
                      <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                        style={{ transform: form.early_checkin_show_customers ? 'translateX(20px)' : 'translateX(0px)' }} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">Late Check-Out</p>
                <button type="button" onClick={() => setForm({ ...form, late_checkout_enabled: !form.late_checkout_enabled })}
                  className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200"
                  style={{ backgroundColor: form.late_checkout_enabled ? '#15803d' : '#d1d5db' }}>
                  <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.late_checkout_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
                </button>
              </div>
              {form.late_checkout_enabled && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Fee</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01"
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm"
                        value={latePriceInput}
                        onChange={e => setLatePriceInput(e.target.value)}
                        onBlur={() => setForm({ ...form, late_checkout_price: Math.round((parseFloat(latePriceInput) || 0) * 100) })}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Latest available check-out time</label>
                    <input type="time"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={form.late_checkout_time}
                      onChange={e => setForm({ ...form, late_checkout_time: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <div>
                      <p className="text-xs font-medium text-gray-700">Show to customers at booking</p>
                      <p className="text-xs text-gray-400">Auto-hidden if same-day arrival on that site</p>
                    </div>
                    <button type="button" onClick={() => setForm({ ...form, late_checkout_show_customers: !form.late_checkout_show_customers })}
                      className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                      style={{ backgroundColor: form.late_checkout_show_customers ? '#15803d' : '#d1d5db' }}>
                      <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                        style={{ transform: form.late_checkout_show_customers ? 'translateX(20px)' : 'translateX(0px)' }} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── PETS ────────────────────────────────────────────────────────────────────────
              Hidden entirely on a tenant whose settings table has no pet columns (see
              hasPetColumns): showing controls that cannot be saved is worse than showing none.

              THE MASTER SWITCH IS THE WHOLE DESIGN OF THIS SECTION. When "Do you charge a pet
              fee?" is off, that single question is the ONLY pet thing on the page — no amount,
              no rules box, no toggles. A park that does not take pets should never have to read
              past one line to establish that. */}
          {hasPetColumns && (
            <>
              <h3 className="text-lg font-semibold text-gray-900 mb-1">Pets</h3>
              <p className="text-sm text-gray-500 mb-4">Charge for pets, set your rules, and choose which sites allow them.</p>

              <div className="flex items-center justify-between mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
                <div>
                  <p className="text-sm font-medium text-gray-900">Do you charge a pet fee?</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {form.pets_enabled
                      ? 'Guests will be asked whether they are bringing pets.'
                      : 'Leave this off if you do not take pets, or do not charge for them. Nothing pet-related will appear to guests.'}
                  </p>
                </div>
                <button type="button" onClick={() => setForm({ ...form, pets_enabled: !form.pets_enabled })}
                  className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
                  style={{ backgroundColor: form.pets_enabled ? '#15803d' : '#d1d5db' }}>
                  <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                    style={{ transform: form.pets_enabled ? 'translateX(28px)' : 'translateX(0px)' }} />
                </button>
              </div>

              {form.pets_enabled && (
                <div className="mb-6 space-y-4">
                  {/* Amount + the two switches that produce all four charging modes. The live
                      sentence below them is deliberate: "per pet" and "per night" are easy to
                      read as alternatives rather than as multipliers, and an owner should be able
                      to see what a 2-pet, 3-night stay costs without doing the arithmetic. */}
                  <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <label className="block text-sm font-medium text-gray-900 mb-2">Pet fee</label>
                    <div className="relative max-w-[12rem]">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                      <input type="number" min="0" step="0.01"
                        className="w-full border border-gray-200 rounded-lg pl-7 pr-3 py-2 text-sm"
                        value={form.pet_fee_amount}
                        onChange={e => setForm({ ...form, pet_fee_amount: e.target.value })} />
                    </div>

                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-900">Charge it per night</p>
                          <p className="text-xs text-gray-500">Off = one charge for the whole stay.</p>
                        </div>
                        <button type="button" onClick={() => setForm({ ...form, pet_fee_per_night: !form.pet_fee_per_night })}
                          className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                          style={{ backgroundColor: form.pet_fee_per_night ? '#15803d' : '#d1d5db' }}>
                          <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                            style={{ transform: form.pet_fee_per_night ? 'translateX(20px)' : 'translateX(0px)' }} />
                        </button>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-900">Charge it per pet</p>
                          <p className="text-xs text-gray-500">Off = one charge no matter how many pets.</p>
                        </div>
                        <button type="button" onClick={() => setForm({ ...form, pet_fee_per_pet: !form.pet_fee_per_pet })}
                          className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                          style={{ backgroundColor: form.pet_fee_per_pet ? '#15803d' : '#d1d5db' }}>
                          <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                            style={{ transform: form.pet_fee_per_pet ? 'translateX(20px)' : 'translateX(0px)' }} />
                        </button>
                      </div>
                    </div>

                    <p className="mt-3 text-xs text-gray-600 bg-white border border-gray-200 rounded-lg px-3 py-2">
                      {petModeSentence}
                    </p>
                  </div>

                  {/* Max pets. The note is not decoration: 0 read as "no pets allowed" is the
                      single most likely misreading of this field, and it is the value every park
                      starts with. */}
                  <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <label className="block text-sm font-medium text-gray-900 mb-1">Maximum pets per booking</label>
                    <input type="number" min="0" step="1" placeholder="No limit"
                      className="w-full max-w-[12rem] border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      value={form.pet_max}
                      onChange={e => setForm({ ...form, pet_max: e.target.value })} />
                    <p className="text-xs text-gray-500 mt-1">
                      Leave blank (or 0) for <strong>no limit</strong>. This does not mean &ldquo;no pets&rdquo; &mdash; to stop taking pets altogether, switch the question above off.
                    </p>
                  </div>

                  {/* Rules + affirmation. */}
                  <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <label className="block text-sm font-medium text-gray-900 mb-1">Pet rules</label>
                    <p className="text-xs text-gray-500 mb-2">Shown to guests who tell you they are bringing a pet.</p>
                    <textarea rows={4}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
                      placeholder="e.g. Pets must be leashed at all times and never left unattended."
                      value={form.pet_rules_text}
                      onChange={e => setForm({ ...form, pet_rules_text: e.target.value })} />
                    <div className="flex items-center justify-between mt-3">
                      <div>
                        <p className="text-sm text-gray-900">Require guests to agree to these rules</p>
                        <p className="text-xs text-gray-500">They must tick a box before booking. The time they agreed is recorded.</p>
                      </div>
                      <button type="button" onClick={() => setForm({ ...form, pet_rules_require_affirmation: !form.pet_rules_require_affirmation })}
                        className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                        style={{ backgroundColor: form.pet_rules_require_affirmation ? '#15803d' : '#d1d5db' }}>
                        <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                          style={{ transform: form.pet_rules_require_affirmation ? 'translateX(20px)' : 'translateX(0px)' }} />
                      </button>
                    </div>
                  </div>

                  {/* Tax and card surcharge. These vary by state and county, so the platform
                      stores no rate and takes no view — the park ticks what applies to it. */}
                  <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
                    <p className="text-sm font-medium text-gray-900">Tax &amp; card fees</p>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-900">Include the pet fee in taxes and percentage fees</p>
                        <p className="text-xs text-gray-500">Your percentage-based fees will be calculated on the stay <em>plus</em> the pet fee. Tax rules vary by state and county &mdash; check yours.</p>
                      </div>
                      <button type="button" onClick={() => setForm({ ...form, pet_fee_taxable: !form.pet_fee_taxable })}
                        className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                        style={{ backgroundColor: form.pet_fee_taxable ? '#15803d' : '#d1d5db' }}>
                        <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                          style={{ transform: form.pet_fee_taxable ? 'translateX(20px)' : 'translateX(0px)' }} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-900">Apply the card surcharge to the pet fee</p>
                        <p className="text-xs text-gray-500">Your card-processing fee will be calculated on the stay <em>plus</em> the pet fee.</p>
                      </div>
                      <button type="button" onClick={() => setForm({ ...form, pet_fee_surcharged: !form.pet_fee_surcharged })}
                        className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                        style={{ backgroundColor: form.pet_fee_surcharged ? '#15803d' : '#d1d5db' }}>
                        <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                          style={{ transform: form.pet_fee_surcharged ? 'translateX(20px)' : 'translateX(0px)' }} />
                      </button>
                    </div>
                  </div>

                  {/* Service animals. Defaults ON, and the note says why — an owner switching it
                      off should know what they are switching off. */}
                  <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-gray-900">Honor service animals</p>
                        <p className="text-xs text-gray-500">Waives the pet fee and lets the guest book any site. Under the ADA a service animal is not a pet, and US campgrounds are generally required to accommodate one &mdash; leave this on unless you have taken advice.</p>
                      </div>
                      <button type="button" onClick={() => setForm({ ...form, service_animal_allowed: !form.service_animal_allowed })}
                        className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-3"
                        style={{ backgroundColor: form.service_animal_allowed ? '#15803d' : '#d1d5db' }}>
                        <span className="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition duration-200"
                          style={{ transform: form.service_animal_allowed ? 'translateX(20px)' : 'translateX(0px)' }} />
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-gray-500">
                    Next: mark which of your sites allow pets on the <a href="/admin/sites" className="text-green-700 underline">Sites</a> page. Guests bringing pets are only shown sites you have marked.
                  </p>
                </div>
              )}
            </>
          )}

          <h3 className="text-lg font-semibold text-gray-900 mb-1">Maintenance Mode</h3>
          <p className="text-sm text-gray-500 mb-4">When enabled, guests will see your message instead of the booking form. The admin panel remains accessible.</p>
          <div className="flex items-center justify-between mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div>
              <p className="text-sm font-medium text-gray-900">Maintenance Mode</p>
              <p className="text-xs text-gray-500 mt-0.5">{form.maintenance_mode ? '⚠️ Booking is currently disabled for guests.' : 'Booking is live and available to guests.'}</p>
            </div>
            <button type="button" onClick={() => setForm({ ...form, maintenance_mode: !form.maintenance_mode })}
              className="relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ml-4"
              style={{ backgroundColor: form.maintenance_mode ? '#dc2626' : '#d1d5db' }}>
              <span className="pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md transition duration-200"
                style={{ transform: form.maintenance_mode ? 'translateX(28px)' : 'translateX(0px)' }} />
            </button>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Message shown to guests</label>
            <textarea className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" rows={3}
              value={form.maintenance_message} onChange={e => setForm({ ...form, maintenance_message: e.target.value })} />
          </div>
        </div>

      </div>

      {/* The "Change Admin Password" section used to live here. It wrote settings.admin_password,
          which NOTHING read for authentication — so typing a new password here changed nothing
          about logging in, while writing a password-shaped secret into a table any visitor could
          read with the publishable key. The column is dropped in the locked-down schema, and this
          control had to go with it: writing a column that no longer exists fails the WHOLE
          settings save, not just this field.

          There is nothing to bring back. Every person has their own login now — change your own
          under My Account, and an Owner resets someone else's from Staff Accounts. */}

      <div className="mt-6 flex justify-end">
        <button onClick={handleSave} disabled={saving} className="bg-green-700 text-white px-8 py-3 rounded-lg font-medium hover:bg-green-800 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
