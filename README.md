# Workflow Monitor

Self-hosted watchdog for one Ubuntu box (Oracle Cloud free tier friendly), the n8n / cron workflows
that run on it, and the box's own backups and ssh security. Single Node.js process, one SQLite file, no Docker.

- **Server metrics** — CPU, RAM, disk, load, uptime and network every 30s, with threshold alerts.
- **Monitors** — `http`, `port`, `systemd`, `pm2`, `n8n`, `cron_heartbeat`, `backup`, all editable from the UI.
- **n8n aware** — reads the n8n REST API, reports per-workflow success rate and pulls the failing
  execution payload into the incident.
- **Cron heartbeats** — every job gets a unique ping URL; if it has not called in, you get told.
- **AI root cause** — on a new incident it grabs the last 50 log lines and asks an LLM for a short
  diagnosis and the fix command. Stored on the incident, also available as *Explain with AI*.
- **Auto-restart** — per-monitor, runs a command from a `.env` whitelist, waits, re-checks, and only
  gives up (with the AI explanation) after N attempts. Every attempt is logged and shown on the incident.
- **Backup monitor** — checks that the newest file matching a pattern exists, is recent, is big enough
  and has not collapsed versus the previous backup; the dashboard shows size for the last 7 backups.
- **Security watch** — tails the ssh log for brute force, new-IP and root logins, diffs `ss -tuln`
  against a saved baseline, and lists fail2ban bans. Own **Security** tab plus Telegram alerts.
- **Log viewer** — read-only browser tail of the systemd / PM2 / file sources whitelisted in `.env`,
  with live SSE tailing, search, level filter, download and *Explain with AI*. Secrets are masked
  before anything leaves the server.
- **Phone app (PWA)** — installable, offline app shell, bottom tab bar and card tables on small
  screens, pull to refresh, and optional web push for new incidents on top of Telegram.
- **Telegram** — down / recovered / high CPU-RAM-disk / missed cron / SSL expiry, with a cooldown so
  one broken thing cannot spam you, a daily digest, and `/status` `/incidents` `/restart <service>`.

## Install (Ubuntu 20.04+)

```bash
git clone <your-repo> workflow-monitor && cd workflow-monitor   # or upload the folder
sudo bash install.sh                                            # -> /opt/workflow-monitor + systemd
sudo nano /opt/workflow-monitor/.env                            # set PASSWORD, telegram, AI…
sudo systemctl restart workflow-monitor
```

Open `http://<server-ip>:4180`. Keep it closed to the internet and tunnel it (`ssh -L 4180:localhost:4180 ubuntu@<ip>`)
or put it behind nginx with basic auth; only expose it deliberately.

Want PM2 instead of systemd?

```bash
npm install
cp .env.example .env && nano .env
pm2 start server.js --name workflow-monitor && pm2 save
```

Manual run: `npm install && npm start` (agent: `npm run agent`).

## .env

| Key | Default | Meaning |
| --- | --- | --- |
| `PORT`, `BIND_HOST`, `PUBLIC_URL` | 4180, 0.0.0.0, local | web listen address; `PUBLIC_URL` builds the ping URLs |
| `PASSWORD` | `admin` | dashboard login — **set this** |
| `SESSION_SECRET` | dev value | signs the login cookie — set a long random string |
| `DB_PATH`, `RETENTION_DAYS` | ./data/monitor.db, 7 | SQLite file, and how long checks/metrics/incidents are kept |
| `METRICS_INTERVAL_SEC`, `CHECK_INTERVAL_SEC` | 30, 60 | sample rate and default monitor check rate |
| `CPU_WARN_PCT`, `MEM_WARN_PCT`, `DISK_WARN_PCT`, `LOAD_WARN_FACTOR`, `WARN_STREAK` | 90/90/90/2/3 | thresholds, and how many samples in a row before alerting |
| `SSL_WARN_DAYS` | 14 | warn when an HTTPS monitor's certificate expires within this |
| `ALERT_COOLDOWN_MIN` | 30 | minimum minutes between repeats of the same alert |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS`, `TELEGRAM_OWNER_IDS` | empty | alerts off until both are set; owners may `/restart` |
| `DAILY_SUMMARY`, `SUMMARY_HOUR` | true, 8 | server-local hour for the digest |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | none | `none`, `openai` (any OpenAI-compatible endpoint) or `anthropic` |
| `N8N_URL`, `N8N_API_KEY` | empty | defaults for n8n monitors when the monitor leaves them blank |
| `AGENT_API_KEYS` | empty | `name:key,name:key` — pre-seeded remote servers |
| `RESTART_ENABLED` | true | master switch for auto-restart; a monitor still needs the tick *and* a whitelisted command |
| `RESTART_ALLOW` | empty | the **only** commands the app may run, `;`-separated — see [Auto-restart](#auto-restart) |
| `RESTART_ALLOW_BINS`, `RESTART_ALLOW_VERBS` | systemctl/service/pm2 · restart/start/reload/… | extra guards on the first and second word of a command |
| `RESTART_WAIT_SEC`, `RESTART_MAX_RETRIES`, `RESTART_COOLDOWN_MIN` | 15, 3, 10 | wait before re-checking, attempt budget, and gap between attempts (per-monitor overrides) |
| `BACKUP_ENABLED` | true | master switch for monitors of type `backup` |
| `SECURITY_ENABLED`, `SECURITY_INTERVAL_SEC` | true, 60 | ssh/port/fail2ban scan on/off and how often |
| `AUTH_LOG_SOURCE` | /var/log/auth.log | `/var/log/auth.log`, `journalctl:ssh`, or `file:/path` (handy for testing) |
| `SSH_FAILED_LIMIT`, `SSH_FAILED_WINDOW_MIN` | 10, 10 | alert when one IP exceeds these failures in the window |
| `SECURITY_COOLDOWN_MIN` | 30 | minutes between repeats of the same security alert |
| `PORT_SCAN_ENABLED` | true | diff `ss -tuln` against the saved baseline |
| `FAIL2BAN_JAILS` | empty | jail names to read with `fail2ban-client status`; empty = skip fail2ban |
| `LOG_ENABLED` | true | master switch for the Logs page |
| `LOG_SOURCES` | empty | the **only** logs the app may read, `;`-separated `name=journal:unit` / `name=pm2:app` / `name=file:/abs/path` — see [Log viewer](#log-viewer) |
| `LOG_MAX_LINES` | 1000 | ceiling for the line-count control (50 / 200 / 1000) |
| `LOG_STREAM_MAX`, `LOG_IDLE_MIN`, `LOG_POLL_MS` | 2, 10, 1000 | concurrent live tails, idle close, and the file poll interval |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | empty | optional web push for new incidents — `node scripts/gen-vapid.mjs` makes a pair |

Everything except `PASSWORD` has a working default, so an empty `.env` still runs.

## Monitors

| Type | Config | Notes |
| --- | --- | --- |
| `http` | url, method, expect_status, keyword, bearer, timeout_ms, ssl | Any non-2xx/3xx (or missing `keyword`) is down. HTTPS monitors also check certificate expiry and warn inside `SSL_WARN_DAYS`. |
| `port` | host, port, timeout_ms | TCP connect only — no data sent. |
| `systemd` | unit, expect_sub | `systemctl show` — must run on the Linux host being monitored. |
| `pm2` | name, max_restarts | Reads `pm2 jlist`; needs the same user that owns the PM2 daemon. |
| `n8n` | url, api_key, workflow_id, window_min, min_rate, limit | Down when the success rate over `window_min` drops below `min_rate` (default 100). |
| `cron_heartbeat` | interval_min, grace_min | Down when the ping URL has not been hit within interval + grace. |
| `backup` | path, pattern, max_age_hours, min_size_mb, at_hour | Newest matching file must exist, be younger than `max_age_hours` (default 26), exceed `min_size_mb`, and not have lost >50% of the previous backup's size. See [Backup monitor](#backup-monitor). |

Per-monitor `interval_sec` overrides the check frequency for that one monitor.
`log_kind` / `log_target` (journal, file, pm2) tell the incident log grabber where to look; with
nothing set it uses the unit/app name, and falls back to the recent check history.
Every type also carries the four auto-restart fields (`auto_restart`, `restart_command`,
`max_retries`, `cooldown_minutes`) — see below.

### Cron heartbeat

Add a monitor of type `cron_heartbeat` with `interval_min` matching the job, then ping its URL:

```cron
0 3 * * * /usr/local/bin/backup.sh; curl -fsS -m 10 "http://127.0.0.1:4180/api/ping/<secret>" >/dev/null
# report a failure instead of a success:
0 4 * * * rclone copy a b || curl -fsS "http://127.0.0.1:4180/api/ping/<secret>?fail=1&msg=rclone"
```

Inside n8n, add a *HTTP Request* node at the end of the workflow pointing at the same URL
(`?fail=1&msg=<node>` on the error branch). The URL is the only credential — keep it secret.

### Extra servers

Dashboard → **Hosts** → *Add agent*, then on the other box:

```bash
mkdir -p /opt/wm-agent && cd /opt/wm-agent && npm init -y && npm i systeminformation
# copy agent/agent.js here
HUB_URL=https://your-monitor:4180 HUB_KEY=<key> SERVER_NAME=db-box node agent.js
```

`GET /api/agent/hello` with `x-agent-key` confirms the key without writing a metric. An agent that
goes quiet for more than 4 sample intervals alerts as a failure itself.

## Auto-restart

Tick **Auto-restart when down** on a monitor and pick its restart command. Two consecutive failed
checks trigger it (one blip never restarts anything), then:

1. run the command → 2. wait `RESTART_WAIT_SEC` (15s) → 3. re-check the monitor.

Recovered → Telegram `🔁 RESTARTED OK`; the restart's own re-check is stored as a check but sends no
second alert, and the next scheduled check closes the incident with `🟢 RECOVERED`. Still down and
attempts are left → try again after `cooldown_minutes`. Out of `max_retries` → `🛠 NEEDS MANUAL FIX`
with the AI root cause appended, and the monitor stops being restarted until it comes back by itself.
Attempts are counted inside the current outage (`monitors.down_since`, which a successful check clears),
so the budget is fresh for the next incident and `🛠` is sent once per outage, not once per check.

Every attempt is written to the `restart_log` table with the command, exit code, output, and one of
`recovered` / `still_down` / `gave_up` / `blocked`, and is listed under the incident on the
**Incidents** page.

### The whitelist — how a command is allowed

`RESTART_ALLOW` in `.env` holds the *only* commands the app may execute, `;`-separated:

```bash
RESTART_ALLOW=systemctl restart n8n; systemctl restart workflow-monitor; pm2 restart n8n
```

- The dashboard's restart-command field is a **dropdown built from this list** — there is no free-text box.
- A monitor can't be saved with a command the whitelist would refuse (`POST/PUT /api/monitors` returns 400).
- Before execution the string must match a `RESTART_ALLOW` entry *verbatim*, its first word must be in
  `RESTART_ALLOW_BINS` (default `systemctl service pm2`), its second in `RESTART_ALLOW_VERBS`
  (default `restart start reload reload-or-restart try-restart`), and it must contain no shell
  characters. It is then passed to `execFile` as `[bin, ...args]` — never to a shell — so `;`, `|`,
  `` ` ``, `$(…)` and `>` in a monitor config are inert.
- Anything refused logs `blocked` and sends `⛔ AUTO-RESTART REFUSED` **once per outage**, then stays quiet.

### Permissions

`install.sh` writes one narrow sudoers drop-in so the service can restart units and read the ssh log
without holding root:

```
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart *, /usr/bin/systemctl stop *, /usr/bin/systemctl is-active *, /usr/bin/journalctl *, /usr/sbin/ss *, /usr/bin/ss *, /usr/bin/fail2ban-client *
```

(That file is `/etc/sudoers.d/workflow-monitor`, mode 440; adjust `$RUN_USER` if you changed it.)
`pm2 restart` only works for the PM2 daemon owned by the same user the service runs as.
Non-root users get `sudo -n` prefixed automatically; running the app as root does not.

Try it without a real unit — `scripts/fake-service.js` is a stand-in service that listens on
`FAKE_PORT` (4188) and dies after `FAKE_TTL_SEC` (60s):

```bash
# .env — the verb guard looks at the second word, which for the fixture is the script path:
#   RESTART_ALLOW=node scripts/fake-service.js restart fake; node scripts/fake-service.js restart broken; node scripts/fake-service.js stop
#   RESTART_ALLOW_BINS=node   RESTART_ALLOW_VERBS=scripts/fake-service.js   RESTART_WAIT_SEC=3
# then add a monitor of type "port" on 127.0.0.1:4188 with auto_restart ticked
node scripts/fake-service.js restart fake     # up
node scripts/fake-service.js stop             # the next two failed checks restart it
node scripts/fake-service.js restart broken   # exits 0 but stays dead -> retries, then gives up
```

## Backup monitor

A `backup` monitor points at a folder plus a glob (`*` and `?` only — everything else is escaped, so a
pattern can't traverse out), or straight at one filename. Each check finds the newest match and fails
with a specific reason:

| Detail you'll see | Meaning |
| --- | --- |
| `… does not exist (wrong path or volume not mounted?)` | the folder/file is gone — e.g. the NAS unmounted |
| `no file matching "<glob>" in <dir>` | folder is readable but empty |
| `backup too old: 31.2h > max 26h` | the job stopped running |
| `backup too small: 0.3MB < min 10MB` | it ran but produced nothing |
| `backup shrank 78%: 2.1 MB now vs 9.6 MB in backup-09.tar.gz` | size dropped >50% vs the previous backup — the classic truncated/gzip-abort case |

The last three need `max_age_hours` (default 26) and `min_size_mb` on the monitor; the shrink check
compares against the second-newest file in the folder, and falls back to the stored history so it also
works when your job overwrites one rolling filename.

Set `at_hour` (0–23) to run the check once at that hour instead of every `interval_sec` — useful for a
nightly dump. Leave it blank for the normal interval.

The Overview page gets a backup card with the newest file name, its size, when it was written and the
monitor's rules, plus a 7-slot bar chart of that monitor's recorded backup sizes (`GET /api/backups`,
one history row per distinct file). It highlights a failing monitor when there is one, otherwise the
newest, and the footnote counts all enabled backup monitors and how many are failing. Reading a backup
folder needs no extra permissions beyond filesystem read access for the service user.

## Security watch

One scan every `SECURITY_INTERVAL_SEC` (60s) on the hub box; agents do not report security. It reads
`AUTH_LOG_SOURCE`, which is one of `/var/log/auth.log`, `journalctl:ssh` (tries `ssh` then `sshd`), or
`file:/path` for testing. On first run it seeds the cursor at the *end* of the log, so history already
in the file is not replayed as fresh alerts, and it tracks the byte offset between scans (a rotated,
shorter file restarts the cursor at 0).

Alerts, each on its own `SECURITY_COOLDOWN_MIN` cooldown:

- **🚨 SSH BRUTE FORCE** — more than `SSH_FAILED_LIMIT` (10) failures from one IP inside
  `SSH_FAILED_WINDOW_MIN` (10 min). Failures are stored aggregated per IP per scan, so an attack
  floods the log but not the table.
- **🔑 NEW SSH LOGIN** — a successful login from an IP that has never been seen before (`sec_known_ip`).
- **👑 ROOT SSH LOGIN** — any accepted login as `root`, flagged even from a known IP.
- **🚪 NEW LISTENING PORT / 🚫 PORT STOPPED LISTENING** — `ss -tuln` diffed against the saved
  baseline in `sec_port`. The very first scan seeds silently; later changes alert.
- **🛡 FAIL2BAN BANNED** — when `FAIL2BAN_JAILS` is set, `fail2ban-client status <jail>` per jail; a
  newly banned IP alerts once. No fail2ban installed, or no binary at all, just degrades quietly.

Missing binaries never alert: `ss` and `fail2ban-client` are handled (`ss unavailable (ENOENT)`,
`fail2ban-client not installed`) and an unreadable `/var/log/auth.log` is reported on the Security
page instead of pinging you every minute.

**Security** tab: recent logins, top attacking IPs (7 days), open/closed ports with the baseline,
known IPs, fail2ban jails, and the alert feed. **Scan now** runs one pass immediately; **Set current
as baseline** clears `sec_port` so the next scan silently accepts whatever is listening — use it after
a planned change (installing a service, opening a port) to stop the alert.

### Permissions

- `auth.log`: add the service user to `adm` (install.sh does `usermod -aG adm ubuntu`).
  Otherwise use `AUTH_LOG_SOURCE=journalctl:ssh` and the `journalctl` line in the sudoers rule above.
- `ss` and `fail2ban-client`: read-only here, covered by the same drop-in
  (`/usr/sbin/ss *, /usr/bin/ss *, /usr/bin/fail2ban-client *`).

Test the rules anywhere with a fixture log — the parser is pure and `file:` source is supported:

```bash
printf 'Oct 22 10:00:01 box sshd[1]: Failed password for root from 203.0.113.9 port 42 ssh2\n' > /tmp/auth
# AUTH_LOG_SOURCE=file:/tmp/auth  SECURITY_INTERVAL_SEC=5  SSH_FAILED_LIMIT=3
# -> after 4 failures from the same IP you get the brute-force alert; add an "Accepted … for root"
#    line for the root alert and a normal "Accepted password for ubuntu from <new ip>" for new-IP.
```

## Log viewer

A **Logs** page (`#/logs`) for reading service logs in the browser without giving the browser a shell.
Sources come from `LOG_SOURCES` in `.env` and nowhere else — three kinds, `;`-separated:

```bash
LOG_SOURCES=n8n=journal:n8n;api=pm2:api;nginx=journal:nginx;nightly=file:/var/log/rsync-nightly.log
```

The dropdown lists the **names** (`n8n · journal`, `api · pm2`, …). A request carries only that name;
the server looks it up in the whitelist and builds a fixed argv array — `journalctl -u <unit> -n <lines>
--no-pager`, the PM2 app's own `~/.pm2/logs/<app>-{out,error}.log` files (falling back to
`pm2 logs <app> --lines <n> --nostream --raw` when they are not there), or a byte-offset read of the
file — and runs it with `execFile`/`spawn` and **no shell**. A name that is not in `LOG_SOURCES` is a
400, so `; rm -rf`, `../../etc/passwd` and a hand-typed path are all equally refused, and an absolute
host path never appears in any response (sources, snapshot, tail marker or error text carry names
only). It is read-only: nothing in this page writes, and the level/search/download paths all re-read
through the same whitelist.

- **Live tail** over SSE (`/api/logs/stream`): `journalctl -f` / `pm2 logs -f` as a child process, a
  `LOG_POLL_MS` (1s) byte-offset poller for files. Pause/resume keeps the buffer, auto-scroll sticks
  to the bottom, and the marker line tells you where the tail started (`— tailing n8n from 12 KB —`).
  At most `LOG_STREAM_MAX` (2) streams run box-wide — a third is refused with a clear message — and a
  stream nobody reads for `LOG_IDLE_MIN` (10) minutes is closed by the server. Closing the tab,
  navigating away, or `Ctrl-C` on the service all tear the child down.
- **Controls**: 50 / 200 / 1000 lines (clamped to `LOG_MAX_LINES`), a search box, and an
  All / Error / Warn / Info filter. Levels are classified from the line text (`error`, `failed`,
  `denied`, `refused`, `exception`, … against `warn`, `retry`, `timeout`, `slow`, …) and colour-coded
  with a left rule; search highlights hits in place.
- **Download last N** hands the same filtered view to the server (`format=text`) and downloads a plain
  `.log`, so what you save is what you saw.
- **Explain with AI** sends the *error* lines (last 50) of what you have on screen — or the last 50
  lines when there is no error — to the existing AI layer, and shows the answer in a side panel with a
  count of what was sent. The monitor form's log source feeds the same prompt for automatic root causes.
- **View logs** appears in each monitor row's menu and in the incident modal when the monitor's name
  (or its `unit` / `service` / `log.name` config) matches a whitelisted source; it opens
  `#/logs?src=<name>` for that service.
- **Secrets are masked before they leave the server** — for the browser, the download, the AI prompt and
  the push body: `token|secret|password|key|api_key|authorization…=value`, `bearer`/`basic` tokens,
  `user:pass@host` URLs, and known token shapes (`sk-…`, `ghp_…`, `AKIA…`), plus the literal values of
  `AI_API_KEY`, `N8N_API_KEY`, `TELEGRAM_BOT_TOKEN`, `PASSWORD` and `SESSION_SECRET`.

`journal:` sources work out of the box on a box installed by `install.sh` — the sudoers drop-in already
allows `/usr/bin/journalctl *`. `pm2:` sources only see a daemon owned by the same user the service runs
as. `file:` sources need ordinary read access for that user.

Test it on any OS with a file you append to — no systemd needed:

```bash
# .env:  LOG_SOURCES=demo=file:/tmp/demo.log   (or %TEMP%\demo.log on Windows)
node -e 'setInterval(()=>fs.appendFileSync("/tmp/demo.log",`${Date.now()} ERROR worker died token=sk-abc123\n`),1500)'
# open #/logs, pick "demo", press Live tail: lines stream in, the token shows as token=***
```

## Phone app (PWA)

The dashboard installs as an app on a phone home screen and opens offline. Nothing to configure for the
shell — `public/manifest.webmanifest` and `public/sw.js` are always served (`no-store`, so an update
lands on the next cold open):

- **Manifest**: name `Pulse Monitor`, short name `Pulse`, `display: standalone`, `start_url`/`scope` `/`,
  theme and background `#0b1220`, and four icons generated from the pulse-wave SVG in
  `public/icons/app-icon.svg` — `icon-192.png`, `icon-512.png` plus `maskable-192/512.png` for launchers
  that crop, and `apple-touch-icon.png` for iOS.
- **Service worker**: the app shell (HTML, CSS, every JS module, Chart.js, icons) is cached
  cache-first with a background refresh, so a cold phone opens the dashboard with no network. `/api/*`
  is network-first, and the last good JSON response per URL is kept as the offline fallback — an
  offline reload shows your real numbers with a **"You are offline, showing last data"** bar instead of
  a browser error. Live log tails (SSE) and every non-GET request bypass the worker.
- **Mobile layout** (below 760px): the sidebar becomes a bottom tab bar — Overview, Monitors,
  Incidents, Logs, **More** (the remaining pages in a sheet) — cards stack in one column, tables turn
  into labelled cards (each cell shows its column name), tap targets are at least 44px, and the header,
  tab bar and offline bar all respect `env(safe-area-inset-*)` for notched phones.
- **Install**: Chrome/Edge fire `beforeinstallprompt` and the topbar grows an **Install app** button
  (the listener is attached while the app is still loading, so a prompt that arrives early is not lost).
  Safari on iOS has no prompt, so the app shows a dismissible *Share → Add to Home Screen* hint instead.
- **Pull to refresh** on Overview: drag down from the top and the dashboard re-reads the API.
- **Web push** (optional, off until you add keys): Telegram stays the primary channel; push is a bonus
  on top of it. Generate a VAPID pair and put it in `.env`:

  ```bash
  node scripts/gen-vapid.mjs     # prints VAPID_PUBLIC_KEY= and VAPID_PRIVATE_KEY=
  ```

  Then **Settings → Phone app → Enable push** subscribes the device and **Send a test** proves the
  round trip. The server signs the request with `node:crypto` only (no dependencies) and pings with an
  **empty body**: the worker wakes, reads `/api/incidents` from your own authenticated server, and shows
  the titles. That keeps log text and secrets out of any third-party push service, and it means the
  notification needs the phone to be online — Telegram still delivers when it is not. Stored endpoints
  are validated (https only, no loopback/private hosts) and pruned when the service answers 404/410.

**Install needs HTTPS** — browsers refuse to install a web app over plain http except on `localhost`.
Put Caddy (`caddy reverse-proxy --from monitor.example.com --to :4180`) or Cloudflare in front, then
open the https address once and install. On the box itself, `http://localhost:4180` installs fine, which
is the easiest way to check the manifest, the worker and the offline banner before you point a domain
at it.

To confirm Chrome agrees the app is installable, open DevTools on that localhost page and check
**Application → Manifest** (no red errors, four icons listed) and **Application → Service worker**
(status activated, "skip waiting" not needed) — or run Lighthouse → PWA, whose installable audit reads the
same manifest. The **Install app** button only appears when Chrome has fired `beforeinstallprompt`, which
is itself the verdict: it does not fire for a manifest that fails.

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather), put the token in `TELEGRAM_BOT_TOKEN`, and
find your chat id by messaging the bot once and reading `https://api.telegram.org/bot<token>/getUpdates`.
Useful once both are set: **Integrations → Send test message**.

`/status` · `/incidents [n]` · `/summary` · `/check` · `/restart n8n.service` · `/restart pm2:api`

`/restart` only runs for ids in `TELEGRAM_OWNER_IDS` (empty = everyone in `TELEGRAM_CHAT_IDS`), and
needs the narrow sudoers rule `install.sh` writes. Restarting another user's PM2 app is not possible.

## Security notes

- Login is a single password behind a signed, `HttpOnly`, `SameSite=Strict` cookie; failed logins are
  throttled per IP (6 → 10 minute lock) and `/logout` revokes every cookie minted before it, even across restarts.
  Change `PASSWORD` and set `SESSION_SECRET`.
- Secrets are stripped from log payloads before they leave the box for the AI call.
- The Logs page reads only what `LOG_SOURCES` names, always as a fixed argv array through
  `execFile`/`spawn` (no shell), and masks `token=`/`password=`/`bearer …`-style secrets on the way out
  to the browser, the download, the AI prompt and the push body. A leaked dashboard password therefore
  reveals log *content* it was already allowed to see — not the filesystem layout, and not your keys.
- Agent keys and ping secrets are bearer credentials: anyone with a ping URL can mark that job healthy.
- Auto-restart executes nothing that is not written in `RESTART_ALLOW`, and never through a shell. A
  leaked dashboard password therefore cannot turn into arbitrary command execution — the password only
  selects from a fixed list. Keep `RESTART_ALLOW` short (one entry per unit you actually want healed).
- The Security tab stores attacker IPs, ports and jail bans in the same SQLite file; nothing is sent
  anywhere except the Telegram alerts you configure.
- SQLite is opened in WAL mode; the `data/` directory holds everything worth backing up
  (`sqlite3 data/monitor.db ".backup backup.db"`).

## Layout

```
server.js              express bootstrap + loops
agent/agent.js         optional remote metric pusher
scripts/fake-service.js  stand-in service for testing auto-restart on any OS
scripts/gen-vapid.mjs    prints a VAPID key pair for web push
src/config.js          .env -> typed settings
src/db.js              schema + queries (better-sqlite3)
src/shell.js           argument-safe command runner
src/notify.js          down/recovered edge + cooldowns
src/collectors/        metrics.js checks.js scheduler.js restart.js backup.js security.js logs.js
src/ai/                explain.js (LLM) logs.js (last 50 lines + secret masking)
src/alerts/            telegram.js push.js (VAPID-signed, payload-free pings)
src/routes/            auth.js monitors.js data.js agent.js security.js logs.js push.js
public/                dashboard (vanilla ES modules + Chart.js served from node_modules)
  index.html           hash-routed shell: #/overview #/monitors #/workflows #/incidents #/logs #/security #/hosts #/integrations #/settings
  manifest.webmanifest sw.js  PWA manifest + app-shell/offline worker (both served no-store)
  icons/               pulse-wave SVG + the 192/512 and maskable PNGs cut from it
  css/pulse.css        design tokens, all component styles, and the phone layout
  js/                  api.js (fetch + store) charts.js components.js modals.js actions.js pwa.js app.js (router)
  js/pages/            one builder per route
```

## Troubleshooting

- `systemd`/`pm2` monitors report "skipped" when the binary or OS does not support them — they never
  alert on a skip.
- Charts empty: the metric loop needs ~30s to fill the first point; check `journalctl -u workflow-monitor`.
- AI says `[AI error] …`: the provider rejected the call — verify `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`.
- Nothing arrives on Telegram: `TELEGRAM_CHAT_IDS` must be numeric chat ids, and polling starts on the
  first alert (or the self test).
- `⛔ AUTO-RESTART REFUSED` on the incident: the monitor's command is not in `RESTART_ALLOW` verbatim
  (a double space is normalised, but a typo is not) — fix `.env`, restart, re-save the monitor.
- Auto-restart runs but the unit never comes back and the log says `sudo: a password is required` (or
  `command not found`): the sudoers drop-in is missing/stale — re-run `sudo bash install.sh`, then
  `sudo systemctl restart workflow-monitor`.
- Backup monitor says `does not exist` for a path you can see yourself: the service user can't read it
  (`ls -ld` the folder; systemd runs as `$RUN_USER`, not root).
- Security page shows `… not readable (is the service user in the adm group?)`: run
  `sudo usermod -aG adm ubuntu && sudo systemctl restart workflow-monitor`, or switch to
  `AUTH_LOG_SOURCE=journalctl:ssh`.
- Port alerts right after an install/upgrade: expected — every new listener is a diff. Once it's meant
  to be there, press **Set current as baseline**.
- Logs page says `unknown log source` — the name after `?src=` (or in the dropdown) is not in
  `LOG_SOURCES`; edit `.env` and restart, since the whitelist is read at boot.
- `journalctl needs Linux (running on win32)` in a `journal:` source: expected when you develop on
  Windows — use a `file:` source there. `sudo: a password is required` instead means the sudoers
  drop-in is missing; re-run `sudo bash install.sh`.
- `2 live tail streams are already open` — someone else's tab (or a phone left on Live) holds a slot;
  press Pause there, or raise `LOG_STREAM_MAX`.
- No **Install app** button: the page must be https (or localhost), the service worker must register
  (check `chrome://serviceworker-internals` or DevTools → Application), and Chrome only fires the prompt
  after it has seen the manifest, the worker and a bit of engagement. iOS never fires it — use
  Share → Add to Home Screen.
- Offline shows the shell but stale numbers: that is the design — the API cache keeps the last good
  response per URL, so anything you never opened while online cannot be there. Push-to-refresh, or a
  reload once you are back online, updates it.
- `Settings → Phone app` says *VAPID keys missing*: push is off until both `VAPID_PUBLIC_KEY` and
  `VAPID_PRIVATE_KEY` are set (`node scripts/gen-vapid.mjs`), then restart the service.
