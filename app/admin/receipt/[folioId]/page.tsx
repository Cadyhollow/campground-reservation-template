'use client'
// THE PRINTABLE RECEIPT — Phase 4, PR 4.
//
// ⚠ IT RENDERS NOTHING OF ITS OWN. It asks /api/receipt for the SAME receipt it would email
// (`preview: true`) and displays that. So the copy handed across the counter and the copy that
// lands in a camper's inbox are byte-identical by construction — there is no second receipt
// renderer to drift.
//
// This exists because most counter payments have no email on file. A walk-up still gets a
// receipt.
//
// No money is read or written here beyond what the receipt already reads.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'

export default function PrintableReceiptPage() {
  const params = useParams()
  const folioId = params.folioId as string
  const [html, setHtml] = useState('')
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const frame = useRef<HTMLIFrameElement>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const lane = new URLSearchParams(window.location.search).get('lane') || undefined
      const res = await fetch('/api/receipt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folioId, receiptType: 'account', preview: true, lane }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d.error || 'Could not build this receipt.') }
      else { setHtml(d.html || ''); setText(d.text || '') }
    } catch { setErr('Could not build this receipt.') }
    setLoading(false)
  }, [folioId])
  useEffect(() => { void load() }, [load])

  /** Print the receipt itself, not this page's chrome — the iframe is the document. */
  function print() {
    const win = frame.current?.contentWindow
    if (win) { win.focus(); win.print() } else { window.print() }
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <style>{`@media print { .no-print { display: none !important } }`}</style>

      <div className="mb-4 no-print flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href="/admin/seasonals" className="text-sm text-gray-400 hover:text-gray-600">← Seasonals</Link>
          <h2 className="text-2xl font-bold text-gray-900">Receipt</h2>
          <p className="text-sm text-gray-500">Hand this to the camper, or print it.</p>
        </div>
        <button onClick={print} disabled={loading || !!err}
          className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50" style={{ background: '#2E6B8A' }}>
          🖨 Print receipt
        </button>
      </div>

      {loading && <p className="text-sm text-gray-500">Building the receipt…</p>}
      {err && <div className="rounded-lg px-3 py-2 text-sm" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>{err}</div>}

      {/* srcDoc, not dangerouslySetInnerHTML: the receipt is a COMPLETE html document with its own
          background and styling, and an iframe is what lets it print as itself rather than
          inheriting this page's layout. */}
      {!loading && !err && html && (
        <iframe ref={frame} srcDoc={html} title="Receipt"
          className="w-full rounded-xl border border-gray-200 bg-white" style={{ height: '75vh' }} />
      )}

      {/* A combined park's account receipt is plain text — show it as text rather than pretending
          it is a styled document. */}
      {!loading && !err && !html && text && (
        <pre className="rounded-xl border border-gray-200 bg-white p-4 text-sm whitespace-pre-wrap font-mono">{text}</pre>
      )}
    </div>
  )
}
