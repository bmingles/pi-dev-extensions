# pi caffeinate extension

A [pi](https://github.com/earendil-works) coding-agent extension that runs
macOS's `caffeinate` on the **host** for exactly as long as an agent run is
active, so the Mac doesn't idle-sleep out from under an unattended agent — and
stops it the moment the agent goes idle. A footer status indicator shows
whether it's currently holding the machine awake.

## What it does

- On `agent_start`, spawns `caffeinate -i` (prevents idle sleep) if it isn't
  already running.
- On `agent_settled` — the point at which pi is truly done and won't
  auto-retry, auto-compact, or continue with a queued message — kills it.
- Also stops it on `session_shutdown`, so a live `caffeinate` process never
  outlives the session it was started for.
- Shows a `caffeinate: ⠋ awake` footer status (via `ctx.ui.setStatus`) while
  active — a fixed-width braille spinner (same as the devcontainer extension's
  startup indicator), so it never shifts surrounding footer layout — cleared
  when stopped.
- `/caffeinate` reports whether it's currently active (with pid and args) or
  idle.

macOS-only: on any other platform, it no-ops and shows a
`caffeinate: unsupported (not macOS)` status once, instead of failing. This
matters for this repo in particular — `pi -e pi-extensions/devcontainer`
(see [`../devcontainer`](../devcontainer)) runs pi on the host with tools
routed into a devcontainer; this extension is meant to stack alongside it
(`pi -e ... -e ...`, both on the host) rather than replace it. If `caffeinate`
itself is missing or fails to spawn, the failure is reported via the status
line only — it never breaks the agent run.

## Usage

```bash
cd /path/to/project
pi -e /path/to/agent-tools/pi-extensions/caffeinate
```

Stack it with another extension by repeating `-e`:

```bash
pi -e /path/to/agent-tools/pi-extensions/devcontainer -e /path/to/agent-tools/pi-extensions/caffeinate
```

For auto-discovery / `/reload`, copy or symlink it into
`~/.pi/agent/extensions/` instead.

### Overriding the `caffeinate` flags

The default is `-i` (prevent idle sleep only — doesn't force the display on or
override an explicit lid-close/battery choice). Override with
`$PI_CAFFEINATE_ARGS` (whitespace-split), e.g.:

```bash
PI_CAFFEINATE_ARGS="-d -i -s" pi -e /path/to/agent-tools/pi-extensions/caffeinate
```

`-d` also keeps the display on; `-s` also holds system sleep while on AC power.

## Requirements

- **macOS** — `caffeinate` is a macOS-only binary. On other platforms the
  extension loads fine but never spawns anything.
- **Node.js ≥ 26.5.0** — the repo-root `.nvmrc` pins the version. Native `.ts`
  type-stripping means there is no build step.

## Development

Part of the repo-root npm workspace (see the root README's
"`pi-extensions/` packaging" section) — `npm install` here works standalone,
but a single `npm install` from the repo root covers all four packages at
once.

```bash
npm install        # install pi (types) + typescript + @types/node (dev only)
npm run typecheck  # tsc --noEmit against pi's real types
npm test           # node --test (unit tests, injected spawn — no real caffeinate/macOS needed)
```

The unit tests inject a fake spawn, so they run on any platform without a real
`caffeinate` binary. The real end-to-end check is manual, on a Mac: run
`pi -e …`, send the agent a long-running prompt, and confirm `/caffeinate`
reports active with a real pid (cross-check with `ps aux | grep caffeinate`)
while it runs, and idle again once the agent settles.
