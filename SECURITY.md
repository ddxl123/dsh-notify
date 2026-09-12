# Security

## Reporting

Open a private security advisory on the repository, or email the maintainer. Please do
not file a public issue for a credential leak.

## Handling of secrets

- The SMTP password is never written to the outbox, the logs, or tool output. `notify_status`
  reports the host, port, sender and the *name* of the secret source only.
- Preferred secret sources, in order: an environment variable (`email.passEnv`, default
  `DSH_SMTP_PASSWORD`), a command whose stdout is the secret (`email.passCommand`, e.g. a
  Keychain lookup), then a literal in the settings document.
- `email.requireTls` defaults to `true`: the client refuses to authenticate over a cleartext
  link, and falls back to another submission port instead.
- An alert record lives in `~/.dsh/dsh-notify-long/outbox.json` and contains only the notification
  text (session title, working directory, model output preview) — no credentials.

## Command execution

Two places spawn a process, and both use an argument vector rather than a shell:

- the sound player, restricted to an allowlist of player names (`afplay`, `paplay`, `pw-play`,
  `aplay`, `ffplay`, `powershell`, `pwsh`);
- `email.passCommand`, which is operator-configured and therefore trusted like any other
  settings value.

Model-authored text (an alert title or body) is sanitized — CR/LF and control characters are
stripped — before it reaches a mail header, an AppleScript literal, or a PowerShell script, so
it cannot inject a header or a second command.
