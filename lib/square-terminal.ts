// Shared helpers for talking to the Square Terminal API.
//
// Kept out of the route files because a Next route module may only export route handlers —
// exporting anything else from route.ts fails the build.

import 'server-only'
import { getSquareCredentials, SquareCredentialsError } from '@/lib/square-credentials'

export type TerminalState =
  | 'pending'
  | 'in_progress'
  | 'canceling'
  | 'canceled'
  | 'completed'
  | 'failed'

// Square's TerminalCheckout lifecycle: PENDING -> IN_PROGRESS -> COMPLETED, or
// CANCEL_REQUESTED -> CANCELED. Mapped to the handful of states the UI branches on. The raw
// Square value is always passed through alongside, because the existing pollers compare
// against it directly.
export function normalizeCheckoutState(squareStatus: string | undefined): TerminalState {
  switch (squareStatus) {
    case 'COMPLETED': return 'completed'
    case 'CANCELED': return 'canceled'
    case 'CANCEL_REQUESTED': return 'canceling'
    case 'IN_PROGRESS': return 'in_progress'
    case 'PENDING': return 'pending'
    default: return 'failed'
  }
}

// A checkout can only be cancelled while Square still has it open. Once it is COMPLETED the
// money is taken and cancelling is meaningless — the refund paths handle that instead.
export function isCancellable(state: TerminalState) {
  return state === 'pending' || state === 'in_progress'
}

type CheckoutResult = {
  ok: boolean
  checkout: any
  errors?: { detail?: string }[]
}

// Host and token together, from the resolver, on every call.
//
// This used to be a header literal reading process.env.SQUARE_ACCESS_TOKEN alongside a
// module-level SQUARE_API_BASE — two independent answers to "which Square?" that a caller could
// not see were meant to agree. Resolved as a pair here, they cannot disagree.
//
// Resolved per call rather than cached at module load: a park can connect Square, or switch
// location, while a server instance is warm, and a module-level cache would keep aiming a
// terminal at whatever account was configured when the process started.
async function terminalCall(path: string, init?: RequestInit): Promise<CheckoutResult> {
  let square
  try {
    square = await getSquareCredentials()
  } catch (e) {
    // Shaped like a Square error so both callers need no separate branch: they already render
    // `errors?.[0]?.detail` and both already treat `ok: false` as "tell the operator and stop".
    const detail = e instanceof SquareCredentialsError
      ? e.message
      : 'Square is not connected. Connect a Square account in Settings to use the Terminal.'
    console.error('Square credentials unavailable for a Terminal call:', e)
    return { ok: false, checkout: undefined, errors: [{ detail }] }
  }

  const res = await fetch(`${square.apiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${square.accessToken}`,
      'Square-Version': '2024-01-18',
    },
  })
  const data = await res.json()
  return { ok: res.ok && !!data.checkout, checkout: data.checkout, errors: data.errors }
}

// Checkout ids arrive from a request body or query string. They are opaque Square ids, so
// escaping them costs nothing and stops a malformed one steering the request at another endpoint.
export function fetchSquareCheckout(checkoutId: string) {
  return terminalCall(`/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}`)
}

export function cancelSquareCheckout(checkoutId: string) {
  return terminalCall(`/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}/cancel`, { method: 'POST' })
}
