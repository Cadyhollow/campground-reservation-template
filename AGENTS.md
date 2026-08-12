<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Where the database schema lives

There is deliberately no `database-setup.sql` in this repo. There used to be, it called itself
auto-generated documentation, nothing generated it, and it sat five schema generations out of
date describing a database this code cannot run against.

The schema of record is **`cady-hollow-reservations/database-setup.sql`**. It is the single
canonical artifact: `resonation-admin/scripts/sync-onboard-sql.mjs` bakes it into the
`DATABASE_SETUP_SQL` constant in `resonation-admin/app/api/onboard/route.ts`, and that constant
is what actually provisions a client's database. Schema changes go into the canonical file and
are regenerated from there — never hand-edited downstream.

To see what this app's database actually looks like, read that file, or read the live catalogue
of the project in `NEXT_PUBLIC_SUPABASE_URL`. Do not reintroduce a copy here; a second
hand-maintained definition is what produced the drift in the first place.
