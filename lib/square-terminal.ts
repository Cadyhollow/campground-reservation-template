// Shared helpers for talking to the Square Terminal API.
//
// Kept out of the route files because a Next route module may only export route handlers —
// exporting anything else from route.ts fails the build.

import { SQUARE_API_BASE } from '@/lib/square-env'

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

const SQUARE_HEADERS = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  'Square-Version': '2024-01-18',
})

export async function fetchSquareCheckout(checkoutId: string) {
  const res = await fetch(`${SQUARE_API_BASE}/v2/terminals/checkouts/${checkoutId}`, {
    headers: SQUARE_HEADERS(),
  })
  const data = await res.json()
  return { ok: res.ok && !!data.checkout, checkout: data.checkout, errors: data.errors }
}

export async function cancelSquareCheckout(checkoutId: string) {
  const res = await fetch(`${SQUARE_API_BASE}/v2/terminals/checkouts/${checkoutId}/cancel`, {
    method: 'POST',
    headers: SQUARE_HEADERS(),
  })
  const data = await res.json()
  return { ok: res.ok && !!data.checkout, checkout: data.checkout, errors: data.errors }
}
