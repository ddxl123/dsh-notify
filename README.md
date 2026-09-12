# dsh-notify-long

[简体中文](README.zh.md) | English

Give [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) an ear and a phone line: **when a task finishes, fails, or needs your answer, you get a system sound, a desktop banner, and an email** — no more babysitting the terminal.

```
task finished   →  🔔 sound + banner + email  "Finished: nightly build"
needs a choice  →  🔔 a different sound + email  "Needs your input: which database?"
failure         →  🔔 alert tone + email  "Error: model route exploded …"
approval needed →  🔔 sound + email  "Approval needed: bash"
```

- **Zero runtime dependencies** — Node built-ins only, with its own SMTP client. No `nodemailer`, no transitive tree.
- **Zero build step** — plain JavaScript ESM; clone it and install it into a profile.
- **Nothing gets lost** — every alert is written to a durable outbox before any channel is contacted, then retried with backoff and resumed after a restart.
- **Not noisy** — per-event deduplication, per-fingerprint error cooldown, sound burst collapsing, and quiet hours (email still goes out).
- **Adjustable live** — channel routing lives in `settings.yaml` and hot-reloads without a restart.

---

## Contents

- [Install](#install)
- [Configure](#configure)
- [What triggers an alert](#what-triggers-an-alert)
- [Tools the model can call](#tools-the-model-can-call)
- [Full configuration reference](#full-configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Design notes](#design-notes)

---

## Install

Requires Node.js ≥ 20.11 and a working `dsh` (this plugin targets the web profile — the GUI you are probably reading this in).

```bash
git clone https://github.com/ddxl123/dsh-notify-long.git
cd dsh-notify-long
node scripts/install.mjs --profile web
```

The installer does two idempotent things:

1. links this repository into `~/.dsh/profiles/web/node_modules/dsh-notify-long`
   (the Cordis loader resolves bare package names from the profile directory, so the link must live there);
2. appends one plugin row to `~/.dsh/profiles/web/cordis.patch.yml`, preserving whatever is already in that file.

Then **restart the profile**:

```bash
dsh --profile web
```

> `cordis.patch.yml` is hot-reloaded, but a newly added plugin *package* has to be imported by the process before it can register its tools, so the first install needs one restart. Configuration changes afterwards do not.
>
> For another profile (`headless`, …) pass its name; `--dry-run` previews the change, `--uninstall` reverses it.

## Configure

Configuration resolves in layers, later wins:

| Layer | Where | Use it for |
| --- | --- | --- |
| Composition row | `config:` inside `~/.dsh/profiles/web/cordis.patch.yml` | Install-time defaults |
| Settings document (live) | the `dsh-notify-long:` section of `~/.dsh/settings.yaml` | Day-to-day changes, applied on save |
| Environment | `DSH_SMTP_PASSWORD`, … | Secrets only |

### 1. Email (use a provider preset)

Add this to `~/.dsh/settings.yaml`:

```yaml
dsh-notify-long:
  email:
    preset: gmail              # fills in host / port / transport, see the list below
    user: you@gmail.com        # login account
    from: "DSH <you@gmail.com>"
    to: [you@gmail.com]        # one or more recipients
```

`preset` accepts `qq`, `qq-exmail`, `163`, `163-enterprise`, `aliyun`, `gmail`, `outlook`, `office365`, `icloud`, `zoho`, `yahoo`, `sendgrid`, `mailgun`, `resend`, `brevo`.
Without a preset, set `host` / `port` / `tls` yourself (`implicit` = TLS from the first byte, port 465; `starttls` = upgrade, port 587; `plain` = cleartext).

Provider gotchas:

- **QQ / 163 mail require an app-specific SMTP code**, not your login password — enable SMTP in the mailbox settings and generate one.
- Gmail needs an App Password; your account password is rejected.
- A dead port falls back to 465 / 587 / 25 automatically (`allowPortFallback: false` disables that).
- `requireTls: true` by default: credentials are never sent over a cleartext link.

### 2. Where the password lives

Resolved in this order — **never commit it**:

```bash
# 1. environment variable (recommended)
export DSH_SMTP_PASSWORD='your-app-password'

# 2. a literal in the composition/settings document (convenient, but plain text)
#    email: { pass: "…" }

# 3. a command whose stdout is the secret (Keychain / pass / 1Password CLI)
#    email: { passCommand: "security find-generic-password -s dsh-smtp -w" }
```

The bundled CLI uses the same layers, so you can verify before restarting:

```bash
node scripts/test-alert.mjs --channel email
node scripts/test-alert.mjs --channel sound --kind error   # audition the failure tone
```

### 3. Verify

Ask the agent:

> Run notify_status to check the alert setup, then notify_test against every channel.

`notify_status` reports which channels are active, whether email is usable (host/port/sender only — **never the password**), quiet hours, and how many alerts are queued.

### 4. Quiet hours and per-event switches

```yaml
dsh-notify-long:
  quietHours:
    start: '23:00'
    end: '07:00'      # inside the window: no sound, no banner, email still sent
  alerts:
    channels: [sound, desktop, email]
    kinds:
      completed: { enabled: true }
      question:  { enabled: true, channels: [sound, desktop, email] }  # per-kind override
      error:     { enabled: true }
      subagent:  { enabled: false }   # child agents are opt-in (they are chatty)
  sound:
    perKind:
      completed: Glass
      error: Basso
      question: Ping
  desktop:
    titlePrefix: "[dsh]"   # useful when you run several machines
    sound: none            # banner sound; turn it off when the sound channel already plays
```

## What triggers an alert

| Event | Fires when | Default channels | Contents |
| --- | --- | --- | --- |
| `completed` | a turn ends normally and the session goes idle | all | last assistant reply plus tool-call, failure, and turn counts |
| `question` | the agent calls `ask_user_question` (including plan review) | all | the questions and their options |
| `approval` | an action needs your permission | all | tool name and reason |
| `error` | a turn/step failed, or a session-level error | all | the failure message and code, cooled down per fingerprint |
| `subagent` | a child agent settled (off by default) | off | the child's final output |
| `manual` | the model calls `notify_user` | all | your own title and body |
| `test` | `notify_test` self-check | all | per-channel results |

Decision details:

- **One alert per turn.** If the turn already alerted for a question, approval, or error, the idle transition does not add a "finished" notice.
- **Empty turns are skipped.** A turn that entered no steps and produced no reply (empty input, immediate cancellation) is not announced.
- **Child sessions do not nag.** A subagent child is not a "task finished" unless `subagent.enabled` is on.
- **Never blocks the agent.** Delivery happens in the background; a failure is logged and retried, never thrown back into the loop.

## Tools the model can call

| Tool | Purpose |
| --- | --- |
| `notify_user` | Alert you explicitly: title, message, `urgency` (`info` / `action` / `error`), optional `sound`. |
| `notify_test` | Exercise each configured channel and report the real per-channel result. |
| `notify_status` | Report active channels, redacted email readiness, quiet hours, queue depth, and this run's success/failure counts. |
| `notify_flush` | Retry everything waiting in the outbox (for example after fixing a password). |

State lives in `~/.dsh/dsh-notify-long/outbox.json` — atomic writes, removed on success, at most 5 attempts, abandoned after 6 hours.

## Full configuration reference

Every field is optional; defaults are in parentheses.

```yaml
dsh-notify-long:
  enabled: true                # master switch

  sound:
    enabled: true
    file:                      # global audio file (empty = per-kind default)
    player:                    # afplay (macOS) / paplay, pw-play, aplay, ffplay (Linux)
    perKind: {}                # kind → sound name or file path
    timeoutMs: 10000

  desktop:
    enabled: true
    titlePrefix:
    sound:                     # macOS banner sound name; `none` to stay silent

  email:
    enabled: true
    preset:                    # qq / gmail / outlook / sendgrid / … (fills host, port, tls)
    host:
    port: 465
    tls:                       # implicit | starttls | plain (inferred from the port otherwise)
    user:
    pass:                      # literal secret (not recommended)
    passEnv: DSH_SMTP_PASSWORD # environment variable holding the secret
    passCommand:               # command whose stdout is the secret
    from:
    to: []
    cc: []
    subjectPrefix: "[DSH]"
    html: true                 # attach an HTML alternative
    requireTls: true           # never authenticate over cleartext
    verifyCert: true
    preferPlain: true          # prefer AUTH PLAIN, else LOGIN / CRAM-MD5
    allowPortFallback: true    # try 465/587/25 when the configured port fails
    heloName:                  # EHLO name, defaults to this host
    timeoutMs: 20000

  quietHours:
    start:                     # 'HH:MM'
    end:                       # 'HH:MM' (midnight wrap handled: 23:00 → 07:00)

  alerts:
    channels: [sound, desktop, email]
    dedupeWindowMs: 300000     # same event alerts once per 5 minutes
    errorCooldownMs: 600000    # same failure fingerprint cools down for 10 minutes
    channelCooldownMs: 15000   # sound burst collapse window
    kinds: {}                  # { <kind>: { enabled, channels } }

  outbox:
    path:                      # default ~/.dsh/dsh-notify-long/outbox.json
    flushOnStart: true         # deliver anything left over at boot

  tools:
    enabled: true              # register the notify_* tools

  log:
    delivered: true

  debug: false                 # log the state directory and queue recovery
```

## Troubleshooting

**A configuration change did nothing.** `settings.yaml` hot-reloads; `config:` inside `cordis.patch.yml` needs a restart. `notify_status` shows what is actually in effect.

**No sound.** `node scripts/test-alert.mjs --channel sound` prints the exact command it runs. macOS needs `/System/Library/Sounds/*.aiff` (shipped); Linux needs one of `paplay` / `pw-play` / `aplay` / `ffplay`; containers and remote hosts usually have no audio device — use email there.

**Email is not arriving.** Check the `email` line from `notify_status`; failures also appear in `notify_flush` output and the logs. Usual causes: a login password instead of an app password, port 465 blocked by a firewall (try `port: 587` with `tls: starttls`), a sender outside the authenticated domain, or a self-signed certificate (`verifyCert: false` temporarily).

**Too many alerts.** Raise `alerts.dedupeWindowMs`, disable `alerts.kinds.subagent.enabled`, or set `quietHours`.

**Does it slow the agent down?** No: every channel is an async subprocess or socket call with a hard timeout, failures are queued rather than raised, and nothing blocks the turn.

## Development

```bash
node --test test/          # 82 tests: policy, rendering, SMTP (local fake server), queue, engine, profile-patch editing, boot-level mount
node scripts/test-alert.mjs --channel all --json
```

Layout:

```
src/index.js              Cordis plugin entry: read services, subscribe, register tools (thin wiring)
lib/core/                 Harness-free decisions: policy, text, event folding, queue, engine, profile-patch editing
lib/channels/             The three delivery channels: sound, desktop, email
lib/email/                Hand-written SMTP client plus RFC 5322 / MIME construction
lib/runtime/handlers.js   Harness events → alert decisions (pure, unit-tested)
scripts/install.mjs       Idempotent install / uninstall
scripts/test-alert.mjs    Channel self-check outside the harness
test/                     Unit tests, a fake SMTP server, and a fake-harness mount test
```

## Design notes

- **Why not a dynamic Cordis plugin?** A dynamic plugin lives in one session's process memory, disappears on restart, and runs under a restricted capability surface. "Tell me when the task is done" must cover every session and survive a restart, so this is a real npm package mounted in the host plane.
- **Why a hand-written SMTP client?** Zero runtime dependencies means no install step and no transitive surprises. The submission subset actually needed (EHLO, STARTTLS, AUTH PLAIN/LOGIN/CRAM-MD5, MAIL, RCPT, DATA) is a few hundred lines, fully covered by tests against a local server.
- **Why write to disk before sending?** An alert is only useful if it arrives. The outbox is written first and the record is removed only after a channel succeeds, so a crash, a reload, or a network drop cannot swallow "your task finished".

---

MIT License.
