// Bringing up a Square card form in the browser, once, for every admin page that needs one.
//
// The four admin card forms — manual booking, the new-reservation wizard, walk-in booking and
// the guest folio — each carried their own copy of "inject the SDK script, then call
// Square.payments(appId, locationId)". Four copies meant four places to get the account wrong,
// and they all got it the same wrong way: they read NEXT_PUBLIC_SQUARE_APP_ID and
// NEXT_PUBLIC_SQUARE_LOCATION_ID, which Next inlines at BUILD time.
//
// A park's application id and location id do not exist at build time. They come into being
// later, when an owner connects their own Square account through OAuth, in a different service.
// A build-time variable can never carry them, so those four forms could only ever have drawn a
// card box for whatever account the operator had configured deployment-wide.
//
// So the config is fetched at REQUEST time from /api/square/config, which answers out of the
// same resolver the charge itself uses (lib/square-credentials.ts). The form and the charge
// cannot end up on different Square accounts, because they are asking the same question of the
// same code. Three public fields come back — application id, location id, environment — and the
// access token stays on the server where it belongs.
//
// The sibling of this file is the inline version inside app/book/BookingForm.tsx, which does the
// same thing for the public booking page. Consolidating those two is logged as cleanup; it is
// live-proven code and this batch deliberately left it alone.

export type SquarePaymentsResult =
  | { ok: true; payments: any }
  | { ok: false; error: string }

/** Not set up, versus set up and broken — the two need different words to an operator. */
const NOT_CONFIGURED =
  'Online card payments are not set up for this campground yet. Connect Square in Settings, or take this payment another way.'
const UNREACHABLE =
  'Could not reach the payment service. Refresh and try again, or take this payment another way.'
const SDK_FAILED =
  'The card form could not be loaded. Refresh and try again, or take this payment another way.'

/**
 * Fetch this campground's Square config, make sure the matching SDK build is loaded, and hand
 * back an initialised `Square.payments` instance.
 *
 * Never throws: every failure comes back as `{ ok: false, error }` carrying a sentence a member
 * of staff can act on. A blank bordered box with an error only in the console — which is what
 * these pages did before — tells whoever is standing at the desk with a guest nothing at all.
 */
export async function loadSquarePayments(): Promise<SquarePaymentsResult> {
  let config: { applicationId: string; locationId: string; environment: string }
  try {
    const res = await fetch('/api/square/config')
    // 503 is the endpoint's honest "this campground has no usable Square account", not a fault.
    if (!res.ok) return { ok: false, error: NOT_CONFIGURED }
    config = await res.json()
  } catch {
    return { ok: false, error: UNREACHABLE }
  }

  if (!config?.applicationId || !config?.locationId) {
    return { ok: false, error: NOT_CONFIGURED }
  }

  // The SDK build has to match the environment the token belongs to, so it follows the
  // connection rather than a deploy-wide variable. Sandbox is opt-in by exact match and
  // anything else is production — the same rule the server applies, stated the same way.
  const sdkUrl = config.environment === 'sandbox'
    ? 'https://sandbox.web.squarecdn.com/v1/square.js'
    : 'https://web.squarecdn.com/v1/square.js'

  try {
    await ensureSdk(sdkUrl)
    return { ok: true, payments: (window as any).Square.payments(config.applicationId, config.locationId) }
  } catch {
    return { ok: false, error: SDK_FAILED }
  }
}

/**
 * Load the Web Payments SDK at most once per page, and reject if it fails.
 *
 * The old inline versions awaited `script.onload` with no `onerror` handler, so a blocked or
 * failed script left the promise pending forever and the caller sat in a try block that never
 * resolved — the form simply never appeared and nothing was logged. Both outcomes are handled
 * here. (A browser extension blocking squarecdn.com is a real case: it is why this project's
 * live card tests are run in an Incognito window.)
 */
let sdkPromise: Promise<void> | null = null

function ensureSdk(src: string): Promise<void> {
  if ((window as any).Square) return Promise.resolve()
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => {
      // onload fires even when the script ran but defined nothing useful. Treat a missing
      // global as a failure rather than letting the caller dereference undefined.
      if ((window as any).Square) resolve()
      else reject(new Error('Square SDK loaded but did not initialise'))
    }
    script.onerror = () => reject(new Error('Square SDK could not be loaded'))
    document.head.appendChild(script)
  })

  // A failed load must not be cached as the permanent answer — the next attempt should be
  // allowed to try again (the operator may have just disabled whatever blocked it).
  sdkPromise.catch(() => { sdkPromise = null })

  return sdkPromise
}
