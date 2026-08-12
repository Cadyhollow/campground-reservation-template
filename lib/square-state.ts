// The signed `state` that carries a Square OAuth round-trip.
//
// Security PR 7-4a. THIS IS THE SEAL ON A PAYMENT CREDENTIAL. Read the attack before changing
// anything here.
//
// Square's OAuth redirect lands on ONE shared callback — admin.myresonation.com/api/square/
// callback — because a Square application has a single configured redirect URL and this is a
// multi-tenant platform. That callback therefore has to be told which park the handshake belongs
// to, and the only channel available is the `state` parameter, which makes a round trip through
// the merchant's browser and Square's servers. In other words: the one input deciding WHOSE
// DATABASE receives a live payment token is attacker-reachable by construction.
//
// It used to be plain base64 JSON with nothing proving it genuine:
//
//     state = base64({ campground_id: 'some-park', return_to: 'https://some-park.example' })
//
// So anyone could write `campground_id: '<a victim park>'`, complete Square's authorization with
// THEIR OWN merchant account, and the callback would file the attacker's tokens under the
// victim's park. That park's bookings would then take payment into the attacker's Square account.
// Nobody would see an error; the money would simply arrive somewhere else.
//
// THE PROPERTY THIS FILE EXISTS TO GUARANTEE:
//   an attacker cannot produce a state the callback accepts for a campground_id whose signing
//   secret they do not hold.
//
// WHY THE SECRET IS PER-TENANT AND NOT GLOBAL — the part that is easy to get wrong. A single
// platform-wide signing secret satisfies "the state is signed" and NOT the property above: every
// client app would have to hold it, so any one park's owner, or anyone who read one client's
// environment variables, could mint a valid state for any OTHER park. The tenants are precisely
// the population we are defending against here. Each client app therefore signs with its own
// SQUARE_STATE_SECRET, generated at provisioning and stored per-row in the platform registry, and
// the callback verifies with THAT tenant's secret. A forged state naming a victim fails because
// it was signed with the wrong key, and one leaked secret compromises exactly one park.
//
// Format:  v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256 of "v1.<payload>")>
//
// The version prefix is inside the signed material, so a future v2 cannot be downgraded to v1 by
// rewriting the prefix.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const VERSION = 'v1'

/** How long a state is good for. Long enough to authorize in Square, short enough that a
 *  captured state is not a durable capability. */
export const STATE_TTL_SECONDS = 15 * 60

export type SquareStatePayload = {
  campground_id: string
  return_to: string
  /** Makes every state unique even for the same tenant and instant, so one cannot be replayed
   *  as another and captured states are individually identifiable. */
  nonce: string
  /** Unix seconds. Checked against STATE_TTL_SECONDS on the way back. */
  issued_at: number
}

const b64url = (b: Buffer) => b.toString('base64url')

function signingInput(version: string, payloadB64: string) {
  return `${version}.${payloadB64}`
}

function hmac(secret: string, input: string): Buffer {
  return createHmac('sha256', secret).update(input).digest()
}

/**
 * Mint a signed state. Called by the client app when the Owner clicks "Connect Square".
 *
 * Throws rather than returning an unsigned fallback when the secret is missing: a state this
 * server could not sign is one the callback must not accept, and silently degrading to the old
 * unsigned shape is exactly the regression this file exists to prevent.
 */
export function signSquareState(
  secret: string,
  payload: Omit<SquareStatePayload, 'nonce' | 'issued_at'>,
  now: number = Date.now(),
): string {
  if (!secret) {
    throw new Error('SQUARE_STATE_SECRET is not set — refusing to start an unsigned Square connection.')
  }
  const full: SquareStatePayload = {
    ...payload,
    nonce: randomBytes(16).toString('base64url'),
    issued_at: Math.floor(now / 1000),
  }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
  const sig = hmac(secret, signingInput(VERSION, payloadB64))
  return `${VERSION}.${payloadB64}.${b64url(sig)}`
}

/**
 * Read the campground_id out of a state WITHOUT trusting it.
 *
 * The callback needs this to know which tenant's secret to fetch, which is an unavoidable
 * chicken-and-egg: you cannot verify until you know the key, and the key is chosen by the
 * claim. The resolution is that this value is treated as a LOOKUP HINT and nothing else — it
 * selects a candidate secret, verifySquareState() then decides whether the state was really
 * signed with it, and nothing attacker-controlled is acted upon until that returns ok.
 *
 * Returns null on anything malformed.
 */
export function unverifiedCampgroundId(state: string): string | null {
  try {
    const parts = state.split('.')
    if (parts.length !== 3 || parts[0] !== VERSION) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const id = payload?.campground_id
    return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null
  } catch {
    return null
  }
}

export type VerifyResult =
  | { ok: true; payload: SquareStatePayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'tenant_mismatch' }

/**
 * Verify a state against ONE tenant's secret. This is the gate.
 *
 * Every failure is a refusal — there is no "probably fine" branch, and the reasons are returned
 * for logging rather than to be shown to the caller, since telling a prober which of malformed /
 * bad_signature / expired they hit is free information about the seal.
 */
export function verifySquareState(
  secret: string,
  state: string,
  expectedCampgroundId: string,
  now: number = Date.now(),
): VerifyResult {
  if (!secret || !state) return { ok: false, reason: 'malformed' }

  const parts = state.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [version, payloadB64, sigB64] = parts
  if (version !== VERSION) return { ok: false, reason: 'malformed' }

  let expected: Buffer
  let given: Buffer
  try {
    expected = hmac(secret, signingInput(version, payloadB64))
    given = Buffer.from(sigB64, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  // Length check first: timingSafeEqual throws on a length mismatch, and comparing with === on
  // the hex would leak the signature a character at a time.
  if (given.length !== expected.length) return { ok: false, reason: 'bad_signature' }
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' }

  let payload: SquareStatePayload
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  // The signature proves the payload was not edited; this proves we fetched the secret for the
  // tenant the payload actually names. Belt and braces against a future refactor that fetches
  // the secret by some other route and forgets they have to agree.
  if (payload?.campground_id !== expectedCampgroundId) return { ok: false, reason: 'tenant_mismatch' }

  if (typeof payload?.issued_at !== 'number') return { ok: false, reason: 'malformed' }
  const ageSeconds = Math.floor(now / 1000) - payload.issued_at
  // Rejects the future as well as the past: a state stamped ahead of time would otherwise be
  // valid for TTL + skew, and nothing legitimate produces one.
  if (ageSeconds < -60 || ageSeconds > STATE_TTL_SECONDS) return { ok: false, reason: 'expired' }

  return { ok: true, payload }
}
