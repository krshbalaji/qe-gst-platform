# Deployment runbook

## Before you deploy anywhere real

Read README.md §7 first. In short: this is ready for a **single-server pilot with real
customers at modest scale**. It is not ready for multi-instance horizontal scaling (see
"Known ceilings" below) or for real GST filing (no GSP is wired in yet — you need a GSP
contract first; see README.md §6).

## 1. Get a server

Any small VM works (a $5-6/mo box from any provider is plenty to start): Ubuntu 22.04+,
Docker installed. Point a domain's DNS `A` record at its IP before starting Caddy (step 3),
since Caddy requests a real Let's Encrypt certificate on first request and needs the domain
to already resolve to this server.

## 2. Set real secrets

```bash
git clone <your repo> qe3 && cd qe3
cp .env.example .env
```

Generate and fill in real values in `.env`:

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

Set `NODE_ENV=production` in `.env` too. **Back up `.env` somewhere safe outside the
server** (a password manager, a secrets vault) — if `ENCRYPTION_KEY` is lost, every already-
encrypted PAN/bank-details field becomes permanently unreadable by design; there is no
recovery path.

## 3. Bring it up

```bash
DOMAIN=yourdomain.com docker compose up -d --build
```

This starts the app container plus a Caddy reverse proxy that automatically obtains and
renews a Let's Encrypt TLS certificate for `DOMAIN`. First boot takes a few seconds while
Caddy requests the certificate.

Seed the demo data (optional — skip this for a real customer-facing deploy; use `/signup`
instead to create your first real workspace):

```bash
docker compose exec app node lib/seed.js
```

Check it's alive:

```bash
curl https://yourdomain.com/healthz
```

## 4. Backups

`data/db.json` (inside the `qe3-data` Docker volume) is the entire database. Set up a daily
cron job on the host that either:
- copies the volume out (`docker run --rm -v qe3-data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/qe3-$(date +%F).tar.gz -C /data .`), or
- calls the in-app scoped backup endpoint per tenant (`/settings/backup/download`, Owner-
  only) if you'd rather back up per-customer than the whole file.

Keep at least 7-14 days of rotation off the server itself (S3, Backblaze, etc.) — a backup
that lives next to the thing it's backing up doesn't protect you from losing the server.

## 5. Monitoring

There is no built-in APM/error-tracking integration. At minimum:
- Point an uptime checker (UptimeRobot, Better Uptime, etc., or your own cron + curl) at
  `/healthz` and alert on failure.
- `docker compose logs -f app` for now; pipe stdout to a real log aggregator (even just
  `docker compose logs app >> /var/log/qe3.log` on a cron, rotated with logrotate) once you
  have real users, so an incident doesn't mean SSH-ing in to read scrollback.

## 6. Known ceilings (don't be surprised by these)

- **Single process, single server.** Sessions live in the process's memory
  (`express-session`'s default `MemoryStore` — you'll see it warn about this on boot, and
  it's right to). Scaling to two app instances or restarting the process logs everyone out
  and would need a shared session store (Redis) first.
- **JSON-file storage.** Fine for one company at real but modest scale; the whole database
  is one file, read/rewritten on every write. Move to Postgres before this becomes a
  bottleneck or before you need real point-in-time recovery beyond the manual backup file.
  See README.md §7 for the planned path.
- **Rate limiting is per-process, in-memory.** Restarting the app resets it; running two
  instances means each has its own independent counters.
- **No horizontal scaling** until the two items above are addressed. Vertical scaling
  (a bigger VM) works fine in the meantime.

## 7. Rolling out an update

```bash
git pull
docker compose up -d --build
```

The `qe3-data` volume persists across this, so `data/db.json` survives. Docker's default
restart policy (`unless-stopped`) means a server reboot brings everything back up on its own.
