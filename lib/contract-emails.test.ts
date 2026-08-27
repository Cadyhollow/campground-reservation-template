import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packetEmailHtml, packetReceiptHtml, defaultPacketIntro } from './contract-emails.ts'

// The two seasonal packet emails.
//
// WHY THIS SUITE EXISTS. On Cady, where this code has been running, packetReceiptHtml escaped
// every value it interpolated and packetEmailHtml escaped NONE of them. The port unified the two
// on the receipt's (correct) behaviour, and these tests are what stop the invitation email
// drifting back.
//
// It is worth being precise about severity rather than overstating it: the invitation goes to the
// guest whose own name it is, so this was never a route to attacking a third party. What it WAS
// is a rendering bug for ordinary customers — an ampersand in a park name is common, and it
// produced invalid HTML in a legal-ish email.

const DOCS = [
  { title: '2026 Seasonal Admission Agreement', text: 'This agreement is not a lease of real estate.' },
  { title: 'Liability Waiver', text: 'I assume all risk.' },
]

// ── the invitation email ─────────────────────────────────────────────────────────────────────

test('the invitation renders the park name, guest name, year and link', () => {
  const html = packetEmailHtml('Cady Hollow Campground', 'Ortiz Family', 2026, 'https://example.test/packet/abc')
  assert.match(html, /Cady Hollow Campground/)
  assert.match(html, /Hi Ortiz Family,/)
  assert.match(html, /2026 seasonal packet/)
  assert.match(html, /href="https:\/\/example\.test\/packet\/abc"/)
})

test('an ampersand in the PARK NAME is escaped — the ordinary-customer case', () => {
  // "Bob & Sue's Campground" is a perfectly normal park name. Interpolated raw it is invalid
  // HTML. This is the bug that actually bit real data, not a hypothetical attack.
  const html = packetEmailHtml("Bob & Sue's Campground", 'Ortiz', 2026, 'https://example.test/p/1')
  assert.match(html, /Bob &amp; Sue's Campground/)
  assert.doesNotMatch(html, /Bob & Sue/, 'a bare ampersand must not survive')
})

test('HTML in the GUEST NAME is escaped — it comes from the public booking form', () => {
  // guests.name traces back to reservations.guest_name, which a camper types themselves when
  // booking online. It is untrusted input reaching an email body.
  const html = packetEmailHtml('Park', '<script>alert(1)</script>', 2026, 'https://example.test/p/1')
  assert.doesNotMatch(html, /<script>/, 'no raw script tag may reach the email')
  assert.match(html, /&lt;script&gt;/)
})

test('the invitation escapes every interpolated value, not just some', () => {
  const html = packetEmailHtml('P&P', 'A<B', 2026, 'https://example.test/p/?a=1&b=2')
  // The one thing that must NOT be escaped is the year — it is a typed number.
  assert.match(html, /<strong>|2026/)
  // Everything else: no bare < from our inputs, and ampersands entity-encoded.
  assert.doesNotMatch(html, /A<B/)
  assert.match(html, /A&lt;B/)
  assert.match(html, /P&amp;P/)
  assert.match(html, /a=1&amp;b=2/, 'the link is escaped too, for consistency')
})

// ── the receipt email ────────────────────────────────────────────────────────────────────────

test('the receipt embeds both signed documents, who signed and when', () => {
  const html = packetReceiptHtml('Park', 'Ortiz', 2026, 'Maria Ortiz', 'August 19, 2026', DOCS)
  assert.match(html, /2026 Seasonal Admission Agreement/)
  assert.match(html, /This agreement is not a lease of real estate\./)
  assert.match(html, /Liability Waiver/)
  assert.match(html, /I assume all risk\./)
  assert.match(html, /Maria Ortiz/)
  assert.match(html, /August 19, 2026/)
})

test('the DOCUMENT TEXT is escaped — it is arbitrary staff input', () => {
  // Contract bodies are typed into Settings by park staff. They are not attackers, but they do
  // paste things, and an unescaped < would silently swallow the rest of a legal paragraph.
  const html = packetReceiptHtml('Park', 'G', 2026, 'G', 'today', [
    { title: 'Agreement <v2>', text: 'Fees are <strong>due</strong> on arrival & in full.' },
  ])
  assert.doesNotMatch(html, /Fees are <strong>/)
  assert.match(html, /Fees are &lt;strong&gt;due&lt;\/strong&gt; on arrival &amp; in full\./)
  assert.match(html, /Agreement &lt;v2&gt;/)
})

test('document text keeps its line breaks for display', () => {
  // The container is white-space: pre-wrap, so newlines survive as written. A contract's
  // paragraph structure is part of the document.
  const html = packetReceiptHtml('P', 'G', 2026, 'G', 'today', [
    { title: 'T', text: 'Clause one.\n\nClause two.' },
  ])
  assert.match(html, /white-space:pre-wrap/)
  assert.match(html, /Clause one\.\n\nClause two\./)
})

test('both emails cope with empty strings without printing "undefined"', () => {
  const invite = packetEmailHtml('', '', 2026, '')
  const receipt = packetReceiptHtml('', '', 2026, '', '', [])
  for (const html of [invite, receipt]) {
    assert.doesNotMatch(html, /undefined|null|NaN/)
  }
})

test('a receipt with no documents still renders a valid email', () => {
  // Defensive: the caller decides which docs to include, and an empty list must not produce a
  // broken shell.
  const html = packetReceiptHtml('Park', 'Ortiz', 2026, 'Ortiz', 'today', [])
  assert.match(html, /Park/)
  assert.match(html, /your copy for your records/)
})

test('the two emails are different documents — an invite is not a receipt', () => {
  // They were confused once already (the receipt's header comment says so). The invitation asks
  // you to sign; the receipt says you have signed. Neither should read like the other.
  const invite = packetEmailHtml('P', 'G', 2026, 'https://example.test/p/1')
  const receipt = packetReceiptHtml('P', 'G', 2026, 'G', 'today', DOCS)
  assert.match(invite, /Review &amp; Sign Packet/)
  assert.doesNotMatch(invite, /is signed/)
  assert.match(receipt, /is signed/)
  assert.doesNotMatch(receipt, /Review &amp; Sign Packet/)
})

// ── Phase 3: the park-authored invitation message ────────────────────────────────────────────

test('with no intro set, the email is EXACTLY what it has always said', () => {
  // The fallback is the normal case: every park has NULL in packet_email_intro the moment the
  // migration runs. A park that sets nothing must see no change whatsoever.
  const before = packetEmailHtml('Cady Hollow', 'Ortiz', 2027, 'https://x/packet/1')
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(packetEmailHtml('Cady Hollow', 'Ortiz', 2027, 'https://x/packet/1', blank), before)
  }
  assert.match(before, /Your 2027 seasonal packet is ready/)
  assert.match(before, /<strong>two documents<\/strong>/)
})

test("a park's message replaces the default paragraph, in place", () => {
  const html = packetEmailHtml('Cady Hollow', 'Ortiz', 2027, 'https://x/packet/1',
    'Your deposit of $500.00 is due by February 15, 2027. We take cheques over the winter.')
  assert.match(html, /Your deposit of \$500\.00 is due by February 15, 2027\./)
  assert.doesNotMatch(html, /seasonal packet is ready/, 'the default is replaced, not appended')
  // Position: still between the greeting and the button.
  assert.ok(html.indexOf('Hi Ortiz,') < html.indexOf('Your deposit'))
  assert.ok(html.indexOf('Your deposit') < html.indexOf('Review &amp; Sign Packet'))
})

test('THE CALL TO ACTION CANNOT BE BROKEN BY AN EDIT', () => {
  // The reason only the message is editable. Whatever an owner writes — including something that
  // looks like markup — the button and the paste-able link survive intact.
  const hostile = '<a href="https://evil.example">click here instead</a>'
  const html = packetEmailHtml('Cady Hollow', 'Ortiz', 2027, 'https://x/packet/1', hostile)
  assert.match(html, /Review &amp; Sign Packet/)
  assert.match(html, /href="https:\/\/x\/packet\/1"/)
  assert.equal((html.match(/<a /g) || []).length, 1, 'exactly one anchor — the real one')
})

test('the message is HTML-escaped, so ordinary punctuation cannot mangle the email', () => {
  // Not only about hostile input: "Rates & fees" is a thing a park writes, and raw & is invalid
  // HTML. Same reasoning as the escaping already applied to the park name.
  const html = packetEmailHtml('Cady Hollow', 'Ortiz', 2027, 'https://x/packet/1', 'Rates & fees <see office>')
  assert.match(html, /Rates &amp; fees &lt;see office&gt;/)
  assert.doesNotMatch(html, /Rates & fees/)
})

test('newlines in the message become line breaks', () => {
  const html = packetEmailHtml('Cady Hollow', 'Ortiz', 2027, 'https://x/packet/1', 'Line one\nLine two\r\nLine three')
  assert.match(html, /Line one<br>Line two<br>Line three/)
})

test('defaultPacketIntro names the season year it is given', () => {
  assert.match(defaultPacketIntro(2028), /Your 2028 seasonal packet is ready/)
})
