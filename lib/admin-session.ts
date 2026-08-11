// Signing the admin session cookie.
//
// WHY THIS EXISTS: /api/admin-auth used to set `admin_session=authenticated`, and both guards
// (middleware.ts and lib/require-admin.ts) accepted the session by comparing the cookie value to
// the literal string 'authenticated'. The cookie was httpOnly, but httpOnly only stops JS from
// READING it — nothing stopped anyone from sending it. The value was a constant with no secret in
// it, so
//
//     curl -H 'Cookie: admin_session=authenticated' https://<site>/api/refund
//
// passed every guard without ever touching ADMIN_PASSWORD. This repository is public, so the
// cookie name and its exact value were published alongside the code that trusted them. That
// reached all 29 requireAdmin-gated routes (refunds, terminal charges, guest PII, outbound email)
// and every admin page.
//
// The fix: the cookie now carries an expiry and an HMAC over that expiry, so a value the server
// did not mint cannot be produced without the signing secret.
//
//     v1.<expiry-unix-seconds>.<base64url HMAC-SHA256>
//
// WHY ADMIN_PASSWORD IS THE SIGNING KEY, rather than a new env var: it is already present in every
// deployment, already secret, and already per-client (the provisioner generates 144 bits of
// entropy per client — see resonation-admin app/api/onboard/route.ts). Introducing a new secret
// would mean setting it in Vercel for Cady AND for every provisioned client before this could
// ship, which is exactly the coordination a security hotfix should not need. A consequence worth
// knowing: rotating ADMIN_PASSWORD now also invalidates every live session, which is the correct
// behaviour anyway.
//
// WHY WEB CRYPTO, not node:crypto: this module is imported by middleware.ts, and middleware does
// not reliably run on the Node.js runtime (Next 16 moved that guarantee to proxy.ts, which is a
// PR 5a migration, not this hotfix). crypto.subtle is present in both the Edge and Node runtimes,
// so the same code verifies identically wherever it runs. It is async, which is why
// requireAdmin() is now async and its 29 call sites await it.
//
// SCOPE: this closes the forgery. It is NOT the auth redesign — the login is still one shared
// password with no per-user identity, no rate limiting and no revocation. Real per-user logins,
// roles and self-service passwords are PR 5a/5b/5c.

const COOKIE_NAME = 'admin_session'

// Matches the 24h maxAge the cookie has always had. The signed expiry is the authority: a cookie
// that outlives it is refused even if the browser kept sending it.
const TTL_SECONDS = 60 * 60 * 24

const VERSION = 'v1'

/**
 * The signing secret. Returns null when ADMIN_PASSWORD is unset or blank so every caller fails
 * closed rather than signing with an empty key.
 *
 * This also closes a second hole found alongside the first: /api/admin-auth compared
 * `password === process.env.ADMIN_PASSWORD` directly, so on a deployment where ADMIN_PASSWORD was
 * never set, posting `{}` compared undefined to undefined and logged the caller straight in.
 */
function secret(): string | null {
  const value = process.env.ADMIN_PASSWORD
  return typeof value === 'string' && value.length > 0 ? value : null
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): ArrayBuffer | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  } catch {
    return null
  }
}

// crypto.subtle wants a BufferSource. Handing it a plain ArrayBuffer everywhere keeps the types
// simple and sidesteps the Uint8Array<ArrayBufferLike> vs ArrayBufferView<ArrayBuffer> mismatch.
function encode(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function signingKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

// The signed message includes the cookie name so a signature minted here can never be replayed as
// some other signed value we might add later.
function payload(expiry: number): ArrayBuffer {
  return encode(`${COOKIE_NAME}|${VERSION}|${expiry}`)
}

/** Mint a session value. Returns null if there is no signing secret — the caller must refuse login. */
export async function mintAdminSession(now: number = Date.now()): Promise<string | null> {
  const key = secret()
  if (!key) return null

  const expiry = Math.floor(now / 1000) + TTL_SECONDS
  const signature = await crypto.subtle.sign('HMAC', await signingKey(key), payload(expiry))
  return `${VERSION}.${expiry}.${toBase64Url(signature)}`
}

/**
 * True only for a value this server minted, that has not expired.
 *
 * Uses crypto.subtle.verify rather than comparing strings, so the comparison does not leak the
 * signature through timing. Every failure path returns false — there is no error to distinguish a
 * malformed cookie from a wrong signature, because the caller must treat them identically.
 */
export async function verifyAdminSession(
  value: string | undefined,
  now: number = Date.now()
): Promise<boolean> {
  const key = secret()
  if (!key || !value) return false

  const parts = value.split('.')
  if (parts.length !== 3) return false

  const [version, expiryText, signatureText] = parts
  if (version !== VERSION) return false

  // Reject anything not a plain positive integer before Number() gets a chance to be generous
  // about '0x10', '1e9' or leading whitespace.
  if (!/^\d+$/.test(expiryText)) return false
  const expiry = Number(expiryText)
  if (expiry * 1000 <= now) return false

  const signature = fromBase64Url(signatureText)
  if (!signature) return false

  try {
    return await crypto.subtle.verify('HMAC', await signingKey(key), signature, payload(expiry))
  } catch {
    return false
  }
}

export const ADMIN_SESSION_COOKIE = COOKIE_NAME
export const ADMIN_SESSION_TTL_SECONDS = TTL_SECONDS
