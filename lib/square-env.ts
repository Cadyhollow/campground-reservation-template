// Which Square environment this deployment talks to.
//
// Exists so Preview can charge Square SANDBOX (fake) cards while Production keeps charging
// real ones, selected per-deployment by an environment variable rather than by editing code
// before each test. Every Square caller — payments, refunds, terminal, and the card form in
// the browser — resolves its endpoint through here, so there is exactly one answer per
// deployment and no caller can be left pointing somewhere else.
//
// ── The fail-safe direction ────────────────────────────────────────────────────────────
// Sandbox is an explicit OPT-IN, matched against one exact string. Unset, empty, misspelled,
// 'prod', 'PRODUCTION', 'sandbox-ish' — anything that is not the word "sandbox" resolves to
// PRODUCTION. That direction is deliberate and is the whole point of this module:
//
//   Production silently running on sandbox would mean real campers "paying" with fake money
//   — bookings that look confirmed while no revenue arrives, potentially for days before
//   anyone notices. That failure must be impossible to reach by accident, so it is reachable
//   only by typing the word exactly.
//
//   The opposite slip — a Preview left on production — charges a real card during testing.
//   That is the problem this module solves, but it is loud, immediately visible to whoever
//   is testing, and refundable.
//
// Note this INVERTS the previous default. The SDK URL was chosen by an inline ternary copied
// into five separate page files, each of which loaded the sandbox SDK for any value that was
// not exactly 'production' — i.e. every one of them failed open to sandbox. Nothing about
// a correctly-configured deployment changes: with the variable set to 'production', as every
// real environment has it, this resolves to the same production URLs that were hardcoded
// before.
//
// ── Why one variable, and why NEXT_PUBLIC_ ─────────────────────────────────────────────
// The browser and the server read the SAME variable. A separate server-only flag could drift
// out of step with the public one, and the result would be a card tokenized against one Square
// environment and charged against the other. One source of truth makes that disagreement
// unrepresentable.
//
// The value is not a secret — it is the word "sandbox" or "production" — so exposing it to
// the browser costs nothing. Next inlines NEXT_PUBLIC_ values at BUILD time, which is a second
// safety property: the environment is fixed when the deployment is built and cannot be flipped
// at runtime.
//
// ── Credentials are NOT selected here ──────────────────────────────────────────────────
// The app ID, location ID and access token keep their existing variable names. Vercel's
// Preview-vs-Production scoping supplies different VALUES for the same names, so there is no
// code path that could pair a production token with a sandbox endpoint. A mismatch — sandbox
// token against the production API, or the reverse — is rejected by Square with a 401 before
// any money moves.

const raw = (process.env.NEXT_PUBLIC_SQUARE_ENVIRONMENT ?? '').trim().toLowerCase()

/** True only when this deployment is explicitly configured for Square's sandbox. */
export const SQUARE_IS_SANDBOX = raw === 'sandbox'

/** Square REST API host. Identical to the string that was hardcoded, when not in sandbox. */
export const SQUARE_API_BASE = SQUARE_IS_SANDBOX
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com'

/** Web Payments SDK script for the browser card form. Must match SQUARE_API_BASE. */
export const SQUARE_SDK_URL = SQUARE_IS_SANDBOX
  ? 'https://sandbox.web.squarecdn.com/v1/square.js'
  : 'https://web.squarecdn.com/v1/square.js'

// ── Not to be confused with SQUARE_ENVIRONMENT ─────────────────────────────────────────
// lib/square-oauth.ts reads a separate, server-only SQUARE_ENVIRONMENT for the tenant
// onboarding OAuth flow. That is a different concern — which Square account a campground
// CONNECTS — and is deliberately left alone here. This module governs only which Square
// environment card charges and refunds are sent to.
