# QE3 — GST Invoice & Tax Compliance Platform (India)

A working, self-service, multi-tenant GST invoicing, e-invoicing (mock), and returns-prep
platform for Indian SMEs / CA firms.

## 1. Quick start (local dev)

```bash
npm install          # pure-JS deps only — no native builds
npm run seed          # creates data/db.json with a demo company, GSTINs, masters & invoices
npm start             # http://localhost:4000
npm test              # runs all unit tests (30 tests: tax engine, GSTIN checksum, encryption)
```

First run auto-generates a `.env` with real random `SESSION_SECRET`/`ENCRYPTION_KEY` (see
`lib/ensureEnv.js`) — nothing to configure by hand for local dev. **In production this
auto-generation is disabled** (see §4) — you set real secrets yourself.

**Demo logins:**
| Email | Password | Role | Access |
|---|---|---|---|
| owner@aravindtextiles.example | owner123 | Owner | Full + user management |
| accountant@aravindtextiles.example | accountant123 | Accountant | Full |
| ca@rameshandco.example | ca123 | CA (client access) | Read-only |
| viewer@aravindtextiles.example | viewer123 | Viewer | Read-only |

Or go to `/signup` to create your own workspace from scratch — that's the real onboarding
path for a new customer, not just seed data.

## 2. What's in this pass: making it safe for real, multi-tenant customers

Two earlier passes covered a functional scaffold and then a security/reliability hardening
pass (CSRF, rate limiting, central error handling, ITC set-off correctness, atomic writes —
still all in place). This pass is specifically about **real users sharing real GSTINs on one
deployment**, which raises the stakes on a different set of things:

1. **Real GSTIN checksum validation** (`lib/gstin.js`) — not just a format regex. GSTINs use
   a published alternating-weight mod-36 check digit; this catches transposed/typo'd GSTINs
   that a regex would happily accept. Wired into adding a GSTIN and adding/editing any
   customer or vendor. Unit-tested, including "every demo GSTIN in the seed data is actually
   checksum-valid" (they weren't, before this pass — regenerated them with a real checksum).
2. **Self-service signup** (`/signup`) — anyone can create a new, fully independent company
   workspace and become its Owner. This is the actual onboarding path for a commercial app;
   previously the seed script was the only way to create a tenant.
3. **Field-level encryption at rest** for PAN and bank details (`lib/crypto.js`, AES-256-GCM).
   GSTINs are deliberately left in the clear — they're printed on every invoice and shown to
   every customer, so encrypting them doesn't reduce real exposure the way it does for a PAN
   or bank account number.
4. **Password reset** (`/forgot-password` → emailed link → `/reset-password/:token`). No real
   email provider is wired up in this sandbox (no path to an SMTP server); the reset link is
   logged to the server console instead, clearly marked as a dev stand-in, with a one-file
   swap-in point for real email documented in `lib/mailer.js`.
5. **A full tenant-isolation re-audit.** This found and fixed two real cross-tenant bugs:
   - **Critical:** the backup-download endpoint returned the *entire* multi-tenant database
     — every company's invoices, PAN, bank details — to any Owner who hit it, not just their
     own company's data. Now scoped per tenant, and never includes password hashes.
   - Invoice creation looked up the selected customer and GST preset by ID with **no company
     check at all** — a crafted request from one tenant could reference another tenant's
     customer or preset. Same issue in the purchase-register vendor lookup. All three fixed
     and now require the referenced record to belong to the requesting session's company.
6. **Operational basics for running this as a real service:** `/healthz` for uptime
   monitoring, graceful shutdown on `SIGTERM`/`SIGINT`, boot-time validation that **refuses to
   start in production** with a missing/default `SESSION_SECRET` or missing `ENCRYPTION_KEY`
   instead of silently running insecurely, and an append-only audit log (`/audit`, Owner-only)
   recording who did what and when — logins, GSTIN/user changes, invoice cancellations,
   e-invoice generation, GSTR-3B locks.
7. **Docker + a deployment runbook** (`Dockerfile`, `docker-compose.yml`, `Caddyfile`,
   `DEPLOYMENT.md`) — an actual path from "code on my machine" to "running on a server with
   HTTPS," including backup and monitoring guidance. Verified end-to-end in this environment
   (production boot correctly refuses to start without real secrets; correctly boots and
   serves `/healthz` once given them) — the container build itself is standard and follows
   the same install path already verified, but wasn't run through an actual Docker daemon
   since none is available in this sandbox.

## 3. What I will not claim, and why

**This is not yet ready to handle real government GST filings, and I'm not going to imply
otherwise.** Specifically:

- **No real GSP/IRP integration exists.** Every IRN, QR code, and GSTR-2B record is
  synthesized locally by this app. Getting a real GSP contract and credentials is a business
  step only you can take; `lib/einvoice.js` is the one file that needs to change once you
  have them (see README §6 below — unchanged from the previous pass).
- **No independent security audit or penetration test.** I did a careful self-audit and
  fixed everything I found, including two real cross-tenant bugs this pass. That is
  meaningfully different from an outside party trying to break it, which is what you'd want
  before handling many real businesses' financial data at scale.
- **No legal/compliance sign-off.** You're about to store other businesses' PAN, GSTIN, and
  bank details. Data-protection obligations (what you're allowed to store, for how long, what
  you must disclose in a breach) are a conversation with a lawyer, not something achieved by
  writing more code.
- **Single server, single process, JSON-file storage — by design, for now.** This deploys
  cleanly to one server and holds up fine for real customers at modest scale, but it does not
  horizontally scale (see DEPLOYMENT.md §6 for the specific ceilings: in-memory sessions,
  in-memory rate limiting, one JSON file as the whole database). Migrating storage to
  Postgres is the clear next step once you have real traction — I scoped it out of this pass
  deliberately (see §5) rather than rush a rewrite of every route's data access under time
  pressure, which is a worse way to introduce a real incident than shipping the current,
  well-tested storage layer with its limits clearly documented.

## 4. Environment & secrets

| Variable | Required in prod? | Purpose |
|---|---|---|
| `SESSION_SECRET` | Yes | Signs session cookies. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ENCRYPTION_KEY` | Yes | AES-256-GCM key (64 hex chars) for PAN/bank-details encryption. **Back this up** — losing it makes existing encrypted data permanently unrecoverable, by design. |
| `PORT` | No (default 4000) | |
| `NODE_ENV` | Yes, set to `production` | Governs boot-time validation, cookie `secure` flag, and error-page verbosity. |

In dev, none of these need to be set by hand — `lib/ensureEnv.js` generates and persists a
real `.env` on first run. **In production, that auto-generation is deliberately disabled**
(container filesystems are often ephemeral; a fresh random key on every redeploy would
silently make previously-encrypted data unrecoverable and log everyone out) — the app will
refuse to boot with a clear error until you set these via your platform's real secret
management. See `.env.example` and `DEPLOYMENT.md`.

## 5. Path to a real database (the next major piece, not done here)

Storage is isolated behind `lib/store.js`'s `load()`/`save()`/`mutate()` interface
specifically so this migration doesn't require touching every route's business logic at
once, but it does require converting every route's array `.find()`/`.filter()`/`.push()`
data access into real queries — there's no way around that being a first-class, carefully
tested piece of work. Sketch of the target schema (one table per current JSON collection,
every per-tenant table carrying `company_id` with a foreign key and an index on it,
`invoices`/`purchase_invoices` getting a real `UNIQUE(company_id, gstin_id, invoice_no)`
constraint so the numbering race that atomic JSON writes currently prevent is enforced by the
database instead): `companies`, `gstins`, `parties`, `products`, `gst_presets`, `invoices`,
`invoice_line_items`, `purchase_invoices`, `gstr2b_lines`, `return_periods`, `users`,
`audit_log`, `password_resets`. `pg` (the Node Postgres driver) is pure JS, no native
compilation needed, same as everything else in this project.

## 6. Connecting a real GSP / IRP later

Unchanged from the previous pass:

1. Get GSP credentials and sandbox/production base URLs.
2. In `lib/einvoice.js`, replace `generateMockIRN()`'s body with a real HTTP call to the GSP's
   invoice endpoint, passing `buildInvJson()`'s output (extend it to the full GST INV-01
   schema as needed). Map the response (`Irn`, `AckNo`, `AckDt`, `SignedQRCode`) onto the same
   shape this mock returns — nothing in `server.js` or the views needs to change.
3. Add GSP auth via environment variables (never in `data/db.json`).
4. For GSTR-2B, replace `/reconciliation/generate-2b`'s synthetic generator with a real pull
   from the GSTN return APIs, feeding the same `db.gstr2b` shape that
   `buildPurchaseReconciliation()` already consumes.

## 7. Architecture

```
server.js            Express app — routes, security middleware, central error handling
lib/
  ensureEnv.js       Bootstraps .env (dev: auto-generate+persist; prod: never auto-write)
  store.js           Atomic JSON-file persistence (data/db.json) + mutate() helper
  gst.js             Core GST calc: inter/intra-state split, HSN-digit rule, ITC set-off
  gstin.js           Real GSTIN structural + checksum validation
  crypto.js          AES-256-GCM field encryption for PAN / bank details
  einvoice.js        Mock IRP: builds a simplified GST INV-01 payload, fakes an IRN + signed QR
  auth.js            scrypt password hashing + role-based route guards (write / owner-only)
  csrf.js            Per-session CSRF token generation + verification (all mutating routes)
  rateLimiter.js     In-memory brute-force guard (login, signup, password-reset)
  errors.js          AppError class + ah() async route wrapper for one central error handler
  audit.js           Append-only audit-log helper
  mailer.js          Pluggable mail sender (console-logs in dev; one-file swap for real SMTP)
  csv.js             Dependency-free CSV writer with proper escaping
  reports.js         GSTR-1 draft, sales/party-wise reports, reconciliation, pagination
  seed.js            Demo data generator
views/               EJS server-rendered pages (one folder per module)
public/              CSS + all client-side JS (no inline scripts anywhere — real CSP holds)
test/                node:test unit tests (30): tax engine, report aggregation, GSTIN, crypto
Dockerfile, docker-compose.yml, Caddyfile, DEPLOYMENT.md   Containerized deploy + runbook
```

## 8. What's implemented vs. simplified/stubbed

Unchanged from the previous pass except where noted above: the full invoicing engine
(Tax Invoice/Bill of Supply/Credit Note/Debit Note, auto inter/intra detection, catalog +
custom-entry line items, reverse charge, per-GSTIN numbering, invoice cancellation, credit-
note-from-invoice prefill), GST rate presets, GSTR-1 auto-draft with real set-off logic in
GSTR-3B, editable masters with active/inactive toggling, CSV/JSON exports, mock e-invoicing
and GSTR-2B reconciliation (both clearly labelled as synthetic), pagination, and role-based
access (Owner/Accountant/CA/Viewer) enforced server-side.

**Out of scope, as specified in the original brief:** direct live filing without a GSP, full
double-entry accounting/ledger, payroll/TDS, native mobile apps.

## 9. Known limitations still worth fixing before real production use

- Postgres migration (§5) — the single highest-priority item once you have real traction.
- No password complexity/breach-list checking beyond a minimum length.
- No 2FA.
- Sessions and rate-limiting are in-memory and per-process — fine for one server, not for
  horizontal scaling (see DEPLOYMENT.md §6).
- No independent security audit (§3).
- Audit log is capped at the last 5,000 entries in the same JSON file — ship it to a real log
  store before that matters for compliance retention requirements.
