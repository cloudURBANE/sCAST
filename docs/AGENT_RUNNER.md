# Agent command runner (`agent-run` / `agent-show`)

A small, auditable, **repo-local** command runner for AI agents (and humans).
It reduces noisy terminal output **without hiding information needed to fix a
problem**, and always keeps the full (redacted) logs on disk so you can look
deeper whenever the summary is not enough.

- `scripts/agent-run.mjs` — runs a command, then prints a reliability-first
  summary and saves the raw logs.
- `scripts/agent-show.mjs` — re-reads a saved run so you can grep/tail/inspect.
- `.agent/config.json` — conservative defaults (line counts, caps, redaction).
- `.agent/runs/` — saved runs (git-ignored).

No runtime dependencies. **Node.js built-ins only.** Works on Windows, macOS,
and Linux. These scripts are dev tooling — they are never imported by the app
and never touch production runtime code.

## What it is

When an agent runs `pnpm build` and it succeeds with 4,000 lines of progress
spam, that spam costs tokens and tells you nothing. When it *fails*, every one
of those lines might matter. This runner treats the two cases differently:

- **Success** → compress: show the command, exit code, duration, warnings, and
  the last ~50 lines. The full log is saved, not dumped.
- **Failure** → preserve: show the first ~80 lines, **all** TypeScript and
  ESLint diagnostics, failed tests, stack traces, exact error lines, and the
  last ~220 lines.
- **Unknown / low confidence** → prefer showing more raw output over pretending
  to summarize.

## Why it exists / why it is safer than aggressive compression

Aggressive "token reducers" can throw away the one stack frame or the one
`error TS2322` line you needed. The core principle here is the opposite:

> **Never compress away information needed to fix a problem.** Compress
> successful noise. Preserve failed detail. Always save redacted raw logs
> locally so more can be inspected on demand.

It is deliberately conservative: TypeScript diagnostics are **never** capped in
normal use, failures err on the side of showing more, and the complete log is
one command away (`agent:show`).

## How to run commands

Everything after `--` is the command, run **verbatim** (the runner never
rewrites your command into a different one):

```bash
pnpm agent:run -- pnpm build
pnpm agent:run -- pnpm lint
pnpm agent:run -- git status --short
pnpm agent:run -- node -e "console.log('hello')"
```

> In this repo the package manager is invoked as **`corepack pnpm`** (`pnpm` is
> not on `PATH`). The convenience scripts below use `corepack pnpm` for that
> reason. If you call `pnpm` directly through the runner and it is not on your
> `PATH`, the runner reports a clean spawn error rather than hanging.

Convenience scripts (in `package.json`):

| Script | Runs |
| --- | --- |
| `pnpm agent:run -- <cmd>` | any command |
| `pnpm agent:show -- <target>` | inspect a saved run |
| `pnpm agent:last` | `agent:show -- latest` |
| `pnpm agent:build` | `corepack pnpm build` via the runner |
| `pnpm agent:lint` | `corepack pnpm lint` via the runner |
| `pnpm agent:test` | `corepack pnpm test` via the runner |
| `pnpm agent:status` | `git status --short` via the runner |

### Flags (place them before `--`)

| Flag | Effect |
| --- | --- |
| `--raw` | After the summary, also print the full redacted combined output. Still saves logs (unless `--no-save`). |
| `--no-save` | Do not create a run directory. Still prints the summary. |
| `--json` | Print a machine-readable JSON summary instead of markdown. |
| `--head N` | Override the number of first lines shown on failure. |
| `--tail N` | Override the number of final lines shown. |
| `--max-errors N` | Cap extracted generic (non-TS/non-ESLint) error lines. |
| `--max-warnings N` | Cap extracted warning lines. |
| `--allow-dangerous` | Allow a command that matches the dangerous-command blocklist. |

Example:

```bash
pnpm agent:run --tail 300 --json -- pnpm test
```

> **pnpm arg note:** `pnpm` often consumes the first `--`. The runner handles
> both shapes — flags before `--` with the command after, and the no-`--` form
> where the first non-flag token starts the command. If a flag is being eaten
> by pnpm, you can always call the script directly:
> `node scripts/agent-run.mjs --raw -- pnpm build`.

## How to inspect full logs

```bash
pnpm agent:show -- latest                      # summary.md + pointer to combined.log
pnpm agent:show -- latest --tail 300            # last 300 lines of combined.log
pnpm agent:show -- latest --head 80             # first 80 lines
pnpm agent:show -- latest --grep "error"        # plain-text, case-insensitive filter
pnpm agent:show -- latest --grep "TS2322" --context 40
pnpm agent:show -- latest --json                # meta.json + selected slices
pnpm agent:show -- 2026-06-19T04-52-30-123Z-pnpm-build   # a specific run id or path
```

`--grep` behavior: **plain text by default** (not regex), **case-insensitive by
default**. Add `--case-sensitive` for exact case, or `--regex` to treat the
pattern as a JavaScript regular expression. `--context N` (alias `-C N`) adds N
lines before and after each match and merges overlapping windows. Matching
lines are shown exactly. Missing logs fail with a clear message and a non-zero
exit.

## Saved run layout

Each saved run lives in `.agent/runs/<timestamp>-<slug>/`, e.g.
`.agent/runs/2026-06-19T04-52-30-123Z-pnpm-build/`:

| File | Contents |
| --- | --- |
| `stdout.log` | redacted stdout |
| `stderr.log` | redacted stderr |
| `combined.log` | redacted stdout+stderr, in observed order (best effort) |
| `summary.md` | the same reliability-first summary printed to the terminal |
| `meta.json` | machine-readable metadata (command, timings, exit code, counts) |

## What gets redacted

Redaction runs **before** anything is written to disk or printed. It redacts
secret *values* while keeping their keys/labels visible, so debugging context
survives. Patterns (best effort):

- `KEY=value` assignments for sensitive keys (`TOKEN`, `API_KEY`, `SECRET`,
  `PASSWORD`/`PASS`, `AUTH`, `PRIVATE_KEY`, `ACCESS_TOKEN`, `REFRESH_TOKEN`,
  `SESSION`, `COOKIE`, `CREDENTIAL`, `SERVICE_ROLE`, `DATABASE_URL`, …).
- JSON secret properties: `"apiKey": "…"`, `"secret": "…"` (single/double quoted).
- `Authorization:` headers, `Bearer <token>`, `Basic <base64>`.
- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and npm tokens (`npm_…`).
- JWT-like strings (`eyJ….….…`).
- Private key blocks (`-----BEGIN … PRIVATE KEY-----`).
- Credentials embedded in URLs (`scheme://user:pass@host` → password hidden).

**Preserved on purpose:** file paths, line/column numbers, error codes, test
names, stack frames, and exact diagnostic messages (with only secret values
removed). The command string itself is also redacted in the summary/meta.

## Dangerous commands that are blocked

Before running anything, the runner inspects the command tokens and blocks the
obviously destructive ones **unless `--allow-dangerous` is passed**:

- `rm -rf` targeting `/`, `.`, `./`, `*`, `~`, `..`
- `git reset --hard`, `git clean -f…`
- `npm publish`, `pnpm publish`, `yarn publish`
- `vercel … --prod`, `netlify … --prod`, `railway up`
- `docker system prune` (and `-a`)
- `curl … | sh` / `wget … | bash` (download piped into a shell)

A blocked command is **not executed**, exits non-zero (code `2`), prints why,
and (if saving is enabled) records a `blocked` run for the audit trail.

## Why failures intentionally show more output

A failed build/test is exactly when you need the details. The runner therefore
preserves, for failures: the first N lines, **all** TypeScript diagnostics
(exact path, line, column, code, message), **all** ESLint diagnostics (path,
line, column, rule, message), failed test names and assertions, full stack
traces, exact error lines, and the last N lines. Counts are reported so you can
tell at a glance how much there is.

## Limitations

- **Not a sandbox.** Commands run with your full permissions.
- **Not a security boundary.** `--allow-dangerous` exists; the blocklist is a
  guardrail, not a wall.
- **Not a replacement for reading raw logs.** When in doubt, `agent:show` or
  open `combined.log`.
- **Optimized for non-interactive commands** (build / lint / test / status).
  stdin is inherited so simple prompts don't immediately break, but this is not
  meant for long interactive sessions or full TUIs.
- **Redaction is best effort.** It will not catch every possible secret format.
  Do not rely on it as your only protection.
- Combined-stream ordering is captured in data-event order, which approximates
  but does not perfectly reproduce terminal interleaving.

## Recommended Claude Code workflow

1. Use `agent:run` for **build / lint / test / status** commands so successful
   noise stays compressed and tokens are saved.
2. Use `agent:show` when the summary is not enough — `--grep`, `--tail`,
   `--context` to drill into the saved `combined.log`.
3. Use `--raw` when debugging strange failures and you want everything inline.
4. **Do not use this to hide logs from yourself.** The full redacted log is
   always there; read it when a fix depends on it.
