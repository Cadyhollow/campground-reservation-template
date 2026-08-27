// The two seasonal packet emails, as pure functions.
//
// SPLIT OUT OF lib/contract-server.ts DURING THE PORT, for one reason: that module builds a
// service-role Supabase client at import and imports through the '@/lib/…' alias, so `node --test`
// cannot load it — which would have left the HTML-escaping below untested at exactly the moment
// the port changed it. Nothing here touches the database, the network or the environment.
//
// contract-server.ts re-exports both builders, so every call site still imports them from
// '@/lib/contract-server' exactly as before and no route needed editing.

// HTML-escape for anything interpolated into an email body.
//
// HOISTED TO MODULE SCOPE DURING THE PORT — on Cady this lived inside packetReceiptHtml, and
// packetEmailHtml (directly below) escaped NOTHING. That asymmetry is the bug: the two functions
// interpolate the same kinds of value and only one of them was safe.
//
// It matters for ordinary data, not just malicious data. `campgroundName` is the park's own name,
// and "Bob & Sue's Campground" interpolated raw produces invalid HTML; `guestName` traces back to
// `reservations.guest_name`, which is typed by the GUEST on the public booking form, so it is
// genuinely untrusted input reaching an email body.
//
// The blast radius was small — the invitation goes to the guest whose own name it is — but a
// legitimate name or park name containing & or < would mangle the email for a real customer, and
// the fix costs nothing.
const esc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The default message, kept IN CODE rather than backfilled into settings.packet_email_intro.
 *
 * Every park has NULL in that column the moment the Phase 3 migration runs, so falling back here
 * is the normal case, not an edge case. Backfilling this wording into every park's database would
 * freeze today's text everywhere and make improving the default unshippable.
 *
 * Exported so a preview or a Settings placeholder can show an owner exactly what they are
 * replacing, rather than paraphrasing it.
 */
export function defaultPacketIntro(year: number): string {
  return `Your ${year} seasonal packet is ready. There are <strong>two documents</strong> to review and sign — your seasonal admission agreement and the liability waiver. You can do both from your phone in a couple of minutes.`
}

/**
 * The packet invitation email. Used by both /send and /resend.
 *
 * Phase 3 — `intro` is the park's own message, ALREADY RENDERED (merge tokens substituted) by the
 * caller, which is what lets it say "your deposit of $500 is due by February 15" in the park's own
 * words. Blank or omitted → the built-in default paragraph, byte-for-byte what this email has
 * always said, so a park that sets nothing sees no change at all.
 *
 * ⚠ WHAT IS EDITABLE AND WHAT IS NOT, AND WHY. Only the MESSAGE moves. The greeting, the
 * "Review & Sign Packet" button and the paste-this-link fallback stay fixed in code, because they
 * are the call to action: an owner experimenting with wording must not be able to produce an email
 * with no way to reach the packet. The intro is placed exactly where the default paragraph sat, so
 * the layout is identical either way.
 *
 * ⚠ THE INTRO IS STAFF INPUT REACHING AN EMAIL BODY, so it is HTML-ESCAPED here and its newlines
 * become <br>. That is deliberate and it is why the default above carries its own <strong> tags
 * while a park's text cannot: escaping park-authored text is worth more than letting it use bold.
 * A park writing "Rates & fees" gets "Rates & fees", not broken HTML.
 */
export function packetEmailHtml(
  campgroundName: string, guestName: string, year: number, packetUrl: string,
  intro?: string | null,
): string {
  // Escape FIRST, then turn newlines into <br> — the other order would let an escaped entity be
  // re-processed, and would mean the <br> itself got escaped.
  const introHtml = (intro || '').trim()
    ? esc(intro as string).replace(/\r\n|\r|\n/g, '<br>')
    : defaultPacketIntro(year)
  return `
    <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; color: #374151;">
      <h2 style="color:#15803d; margin-bottom: 8px;">${esc(campgroundName)}</h2>
      <p>Hi ${esc(guestName)},</p>
      <p>${introHtml}</p>
      <p style="text-align:center; margin: 28px 0;">
        <a href="${esc(packetUrl)}" style="background:#15803d; color:#fff; text-decoration:none; padding:14px 28px; border-radius:8px; font-weight:700; display:inline-block;">Review &amp; Sign Packet</a>
      </p>
      <p style="font-size:13px; color:#6b7280;">Or paste this link into your browser:<br><span style="color:#2E6B8A;">${esc(packetUrl)}</span></p>
      <p style="font-size:13px; color:#6b7280;">Thank you!<br>${esc(campgroundName)}</p>
    </div>
  `
}

// The after-sign RECEIPT email — the camper's COPY of the signed documents (a
// receipt, NOT a sign-invite). Embeds each frozen document's text plus who signed
// and when. Sent for both in-person and remote signing; skipped if no email. All
// interpolated values are HTML-escaped (the document text is arbitrary staff input) — via the
// shared `esc` above, which the invitation email now uses too.
export function packetReceiptHtml(
  campgroundName: string, guestName: string, year: number,
  signedName: string, signedAtLabel: string,
  docs: { title: string; text: string }[],
): string {
  const docsHtml = docs.map(d => `
      <h3 style="font-size:15px; color:#111827; margin:22px 0 6px;">${esc(d.title)}</h3>
      <div style="background:#FBF8F1; border:1px solid #F3EEE2; border-radius:8px; padding:12px; font-size:12.5px; line-height:1.5; color:#374151; white-space:pre-wrap;">${esc(d.text)}</div>`).join('')
  return `
    <div style="font-family: sans-serif; max-width: 620px; margin: 0 auto; color: #374151;">
      <h2 style="color:#15803d; margin-bottom: 8px;">${esc(campgroundName)}</h2>
      <p>Hi ${esc(guestName)},</p>
      <p>Thank you — your <strong>${year}</strong> seasonal packet is signed. This email is your copy for your records. Signed by <strong>${esc(signedName)}</strong> on ${esc(signedAtLabel)}.</p>
      ${docsHtml}
      <p style="font-size:13px; color:#6b7280; margin-top:24px;">Please keep this email for your records.<br>${esc(campgroundName)}</p>
    </div>
  `
}
