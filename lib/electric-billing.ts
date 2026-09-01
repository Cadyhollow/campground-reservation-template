// The electric charge arithmetic — ONE implementation, three callers.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────
//
// This arithmetic used to live inline in app/admin/electric-billing/page.tsx, inside
// updateReading(). That was fine while that page was the only place a reading could be entered.
// The meter walk makes it the second, and the draft staging the third, and three copies of a
// money calculation is how two of them quietly disagree.
//
// ⚠ THE ARITHMETIC IS UNCHANGED, DELIBERATELY AND EXACTLY. computeElectricCharge() reproduces
// the old inline expression operation for operation, including the order of the rounding:
//
//     kwh        = Math.max(0, current - previous)
//     calculated = Math.max(minCharge, Math.round(kwh * rate * 100))
//
// Rounding AFTER multiplying by 100 (rather than rounding a dollar figure and then converting)
// is the behaviour every bill this park has ever sent was computed with, so it is preserved to
// the cent. lib/electric-billing.test.ts pins it against the original expression.
//
// This is NOT a fee-model file. lib/booking-quote.ts, lib/pricing.ts and lib/ledger.ts are
// untouched by this feature and show an empty diff — electric billing has always been its own
// calculation, and moving it out of a component does not make it theirs.

/** The park's electric pricing, as the Electric Billing screen and the meter walk both read it. */
export type ElectricRate = {
  /** Dollars per kWh, e.g. 0.27. */
  ratePerKwh: number
  /** The floor, in CENTS. A camper who used almost nothing still pays this. */
  minimumChargeCents: number
}

/**
 * What one meter contributed to a bill.
 *
 * `kwh` is already floored at zero — see computeMeterUsage() for why a negative delta is a
 * reading to fix, not a credit to issue.
 */
export type MeterUsage = {
  meterId: string
  meterNumber: string
  /**
   * The value the usage was measured FROM — which on a meter replacement is the NEW meter's
   * starting value, not the old meter's final number.
   *
   * ⚠ THAT DEFINITION IS WHAT KEEPS THE BILL'S ARITHMETIC HONEST. It makes
   * `currentReading - previousReading === kwh` true on every line, resets included, so a bill
   * whose columns are added up by hand agrees with its own total. The old meter's last number is
   * not lost — it travels as `replacedMeterFinal`, and the record of it stays in meter_readings.
   */
  previousReading: number
  currentReading: number
  kwh: number
  /** True when the physical meter was swapped in this period. See computeMeterUsage(). */
  isReset: boolean
  /** On a reset only: what the OLD meter last read, kept for context on the bill. */
  replacedMeterFinal?: number | null
}

/**
 * Usage on ONE meter, in kWh.
 *
 * ⚠ FLOORED AT ZERO, exactly as the Electric Billing page has always floored it. A current
 * reading below the previous one is a mistyped digit or a meter that rolled over — never a
 * camper who generated electricity — and turning it into a negative would silently discount the
 * bill. Zero is visible; a negative hides inside a total.
 *
 * ⚠ A METER RESET DOES NOT SUBTRACT THE OLD METER'S NUMBER. When the physical meter is swapped,
 * the new one starts near zero, so `current - previous` would be a large NEGATIVE number (floored
 * to 0, hiding real usage) or, if the old meter read low, a wild jump. Neither is the truth. On a
 * reset the usage is measured on the NEW meter alone: `current - resetStartValue`, where the
 * start value is what the new meter read the day it went in (usually 0).
 *
 * What that deliberately does NOT capture is the usage on the OLD meter between the last read and
 * the swap. That number is gone with the meter unless somebody wrote it down, and inventing it
 * would be worse than omitting it. The Electric Billing page keeps every editing control it has,
 * so an owner who does have the old final reading can add it to the bill by hand — which is the
 * documented correction path, not a gap.
 */
export function computeMeterUsage(
  previousReading: number,
  currentReading: number,
  opts?: { isReset?: boolean; resetStartValue?: number }
): number {
  const current = Number.isFinite(currentReading) ? currentReading : 0
  if (opts?.isReset) {
    const start = Number.isFinite(opts.resetStartValue as number) ? (opts.resetStartValue as number) : 0
    return Math.max(0, current - start)
  }
  const previous = Number.isFinite(previousReading) ? previousReading : 0
  return Math.max(0, current - previous)
}

/**
 * The charge for a bill, from total kWh.
 *
 * ⚠ THE MINIMUM CHARGE APPLIES ONCE PER BILL, NOT ONCE PER METER. A camper on two sites gets one
 * statement, so they meet the floor once. Applying it per meter would double the minimum for
 * exactly the campers who pay the park the most, which is both wrong and the kind of wrong an
 * owner discovers from a phone call.
 */
export function computeElectricCharge(
  kwhUsed: number,
  rate: ElectricRate
): { kwhUsed: number; calculatedAmountCents: number } {
  const kwh = Number.isFinite(kwhUsed) && kwhUsed > 0 ? kwhUsed : 0
  const perKwh = Number.isFinite(rate.ratePerKwh) ? rate.ratePerKwh : 0
  const floor = Number.isFinite(rate.minimumChargeCents) ? Math.round(rate.minimumChargeCents) : 0
  // Order preserved from the original inline expression — see the file header.
  return { kwhUsed: kwh, calculatedAmountCents: Math.max(floor, Math.round(kwh * perKwh * 100)) }
}

/**
 * A whole bill, from every meter the camper holds.
 *
 * ⚠ THIS IS THE DOUBLE-SITE ANSWER. A camper recorded as "43, 44" holds two meters and uses
 * electricity on both. Summing the kWh FIRST and pricing the sum once is what produces one bill
 * and one statement — and it is not the same figure as pricing each meter and adding, because
 * the minimum charge would then be met twice. The per-meter lines survive in `meters` so the
 * Electric Billing page can show each reading for verification without splitting the bill.
 */
export function computeElectricBill(
  meters: MeterUsage[],
  rate: ElectricRate
): { kwhUsed: number; calculatedAmountCents: number; meters: MeterUsage[] } {
  const totalKwh = meters.reduce((sum, m) => sum + (Number.isFinite(m.kwh) && m.kwh > 0 ? m.kwh : 0), 0)
  const { kwhUsed, calculatedAmountCents } = computeElectricCharge(totalKwh, rate)
  return { kwhUsed, calculatedAmountCents, meters }
}

// ── THE PARK'S RATE ──────────────────────────────────────────────────────────────────────────
//
// Until this feature the rate and the minimum lived in React state on the Electric Billing page,
// seeded with `useState('0.27')` and `useState('15.00')` and never persisted. Two consequences:
// the owner retyped their rate on every visit, and 0.27 / 15.00 — which are ONE PARK'S rates —
// were hard-coded into the blueprint every park is cloned from. The Configurability principle in
// CLAUDE.md names that exact shape as the signal to make something a setting.
//
// It also became load-bearing here: the meter walk shows a live "≈ amount" as each reading is
// typed, and it can only agree with the bill if both read the same stored rate.
//
// ⚠ THE FALLBACKS ARE TODAY'S BEHAVIOUR, NOT A NEW DEFAULT. A park that has never saved a rate
// sees exactly what it sees now — the boxes open at 0.27 and 15.00. The columns provision NULL
// (see the migration), so nothing is asserted about a new park's rates until its owner sets them;
// these constants only keep the existing screen byte-identical until they do.
export const LEGACY_RATE_PER_KWH = 0.27
export const LEGACY_MINIMUM_CHARGE_CENTS = 1500

/** The park's rate, from a settings row, falling back to today's on-screen defaults. */
export function rateFromSettings(settings: {
  electric_rate_per_kwh?: number | string | null
  electric_minimum_charge?: number | null
} | null | undefined): ElectricRate {
  const rawRate = settings?.electric_rate_per_kwh
  const parsedRate = typeof rawRate === 'string' ? parseFloat(rawRate) : rawRate
  const rawMin = settings?.electric_minimum_charge
  return {
    ratePerKwh: typeof parsedRate === 'number' && Number.isFinite(parsedRate) ? parsedRate : LEGACY_RATE_PER_KWH,
    minimumChargeCents:
      typeof rawMin === 'number' && Number.isFinite(rawMin) ? Math.round(rawMin) : LEGACY_MINIMUM_CHARGE_CENTS,
  }
}
