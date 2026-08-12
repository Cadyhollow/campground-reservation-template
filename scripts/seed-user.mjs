// Create or update an admin account. One-time bootstrap and break-glass tool, run by hand.
//
//   node scripts/seed-user.mjs <email> [full name] [--role owner|manager|staff]
//
// Defaults to --role owner, so the original `seed-owner` invocation still works unchanged.
//
// The password is never passed as an argument — it is prompted for, with the typing hidden, so it
// does not land in the shell history, the process list, or a screen share. Run it twice with the
// same email and it resets that user's password instead of failing, which makes it the break-glass
// tool too: if the Owner is ever locked out, this is how she gets back in.
//
// The --role flag exists, for one reason: role enforcement cannot be TESTED with only an Owner
// account. The account-management UI is 5c, so until then this is how a Manager and a Staff user
// come into existence to check that /api/refund really does 403 for them:
//
//   node scripts/seed-user.mjs manager@example.test "Test Manager" --role manager
//   node scripts/seed-user.mjs staff@example.test   "Test Staff"   --role staff
//
// RE-RUNNING WITH A DIFFERENT --role CHANGES THAT USER'S ROLE. That is deliberate — it is also
// the demote/promote path until 5c ships a screen for it — but it means a careless re-run can
// hand someone Owner. The role being applied is printed before the password prompt.
//
// WHY A SCRIPT AND NOT AN ENDPOINT — the security question worth being explicit about. A "create
// the first owner" HTTP route is a hole that never closes: it either stays reachable forever, or it
// depends on a self-disabling check (is the table empty?) that is one bad deploy or one DELETE away
// from being open again. So there is no route. Nothing under app/ can create a user. This file
// needs SUPABASE_SERVICE_ROLE_KEY, which lives in .env.local and in Vercel and is never shipped to
// a browser — so the ability to run it is the ability to read the service key, which already
// implies full database access. It grants nobody anything they did not already have.
//
// Public signup should be OFF at the Supabase project level (/auth/v1/settings should report
// disable_signup: true). A newly provisioned project starts with signup ON, so check it — the role
// model fails closed for a stranger who signs up, because they get no `profiles` row and
// app.at_least() therefore denies everything, but an open signup endpoint is still a gate left
// swinging.
//
// ONBOARDING CALLS THE SAME TWO WRITES this script makes — createUser({ email_confirm: true })
// then a profiles upsert — to seed a new client's first Owner. Keep the two in step: if the shape
// of a provisioned account changes here, it changes there.
//
// SAFE TO RE-RUN. Touches auth.users and public.profiles and nothing else — no bookings, no
// folios, no money.

import { readFileSync } from 'node:fs'

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Env, read the way the test files read it: straight from .env.local, so this
// works with no bundler and nothing exported into the shell.
// ---------------------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
)

const url = env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

// --role may appear anywhere; everything else positional is <email> then the full name.
const argv = process.argv.slice(2)
const ROLES = ['owner', 'manager', 'staff']

let role = 'owner'
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--role') {
    role = (argv[++i] || '').toLowerCase()
  } else if (argv[i].startsWith('--role=')) {
    role = argv[i].slice('--role='.length).toLowerCase()
  } else {
    positional.push(argv[i])
  }
}

const [email, ...nameParts] = positional
const fullName = nameParts.join(' ') || null

if (!email || !email.includes('@')) {
  console.error('Usage: node scripts/seed-user.mjs <email> [full name] [--role owner|manager|staff]')
  process.exit(1)
}

// Validated against the same ladder as the profiles CHECK constraint and app.at_least(), so a
// typo is refused here rather than becoming a row the database rejects — or worse, a role no
// policy recognises, which app.at_least() treats as no access at all.
if (!ROLES.includes(role)) {
  console.error(`Invalid --role '${role}'. Must be one of: ${ROLES.join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Prompt with echo off. Asked twice, so a typo cannot become a password that
// only the typo knows.
// ---------------------------------------------------------------------------
// Piped input is drained ONCE and handed out a line at a time. Opening a second readline on the
// same stdin hangs forever — the first one has already consumed the stream — which is exactly
// what a scripted run of this file hits on the confirm prompt.
let pipedLines = null
let pipedIndex = 0
async function nextPipedLine() {
  if (!pipedLines) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    pipedLines = Buffer.concat(chunks).toString('utf8').split('\n')
  }
  return (pipedLines[pipedIndex++] ?? '').replace(/\r$/, '')
}

function promptHidden(question) {
  const { stdin, stdout } = process

  // Not a terminal (piped input, CI): fall back to a plain line read. Nothing is echoed to a
  // screen there anyway, and refusing to run would only push people toward putting the password
  // in an argument, which is worse.
  if (!stdin.isTTY) {
    stdout.write(question)
    return nextPipedLine()
  }

  return new Promise((resolve) => {
    stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const onData = (chunk) => {
      // Raw mode can deliver several keystrokes in one chunk.
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          stdin.off('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') { stdout.write('\n'); process.exit(130) }              // Ctrl-C
        else if (char === '\u007f' || char === '\b') value = value.slice(0, -1)       // backspace
        else value += char
      }
    }
    stdin.on('data', onData)
  })
}

console.log(`Account: ${email}`)
console.log(`Role:    ${role}${role === 'owner' ? '  (full access, including user management)' : ''}`)

const password = await promptHidden(`Password for ${email}: `)
if (!password || password.length < 12) {
  console.error('Password must be at least 12 characters. Nothing was created.')
  process.exit(1)
}
const confirm = await promptHidden('Confirm password: ')
if (password !== confirm) {
  console.error('Passwords did not match. Nothing was created.')
  process.exit(1)
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

console.log(`\nProject: ${url}`)

// ---------------------------------------------------------------------------
// Create, or reset the password if this email already has an account.
//
// listUsers is paged; 1000 is far beyond any campground's staff list, and if it
// were ever exceeded the failure mode is a duplicate-email error from
// createUser, not a silent wrong write.
// ---------------------------------------------------------------------------
const { data: existing, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
if (listError) {
  console.error('Could not list users:', listError.message)
  process.exit(1)
}

const already = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase())

let userId
if (already) {
  console.log(`User ${email} already exists (${already.id}) — resetting the password.`)
  const { data, error } = await admin.auth.admin.updateUserById(already.id, { password })
  if (error) { console.error('Failed to update password:', error.message); process.exit(1) }
  userId = data.user.id
} else {
  // email_confirm: true — the Owner set this password directly, so there is no address to verify
  // and no confirmation mail to send. That also keeps this independent of SMTP, which is not
  // configured on this project.
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) { console.error('Failed to create user:', error.message); process.exit(1) }
  userId = data.user.id
  console.log(`Created auth user ${userId}`)
}

// ---------------------------------------------------------------------------
// The profiles row. Upsert, so a re-run repairs a half-finished first attempt
// rather than leaving an auth user with no profile.
// ---------------------------------------------------------------------------
const { error: profileError } = await admin
  .from('profiles')
  .upsert({ id: userId, email, full_name: fullName, role, active: true }, { onConflict: 'id' })

if (profileError) {
  console.error('Auth user exists but the profile write FAILED:', profileError.message)
  console.error('Re-run this script to repair it — it is safe to run again.')
  process.exit(1)
}

console.log(`\nAccount ready: ${email} (${userId}) role=${role} active=true`)
console.log('Log in at /admin/login using the email + password fields.')
