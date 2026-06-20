#!/usr/bin/env node
// agent-run.mjs
// Reliability-first local command runner for AI agents.
//
// Goal: reduce noisy terminal output WITHOUT hiding information needed to fix a
// problem. Successful noisy output is compressed; failed output is preserved in
// detail. Full (redacted) logs are always saved locally so they can be inspected
// later with agent-show.mjs.
//
// No dependencies. Node built-ins only. Works on Windows, macOS, and Linux.
// This file is a developer/agent tool: it is never imported by the app.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const REDACTED = "***REDACTED***";

// Conservative built-in defaults; overridden by .agent/config.json if present.
const DEFAULT_CONFIG = {
  version: 1,
  runsDir: ".agent/runs",
  defaultHead: 80,
  defaultSuccessTail: 50,
  defaultFailureTail: 220,
  defaultGrepContext: 20,
  maxErrors: 200,
  maxWarnings: 100,
  redaction: { enabled: true },
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
// Two supported shapes (both produced by `pnpm`/`corepack pnpm` script forms):
//   1. A `--` separator: tokens before it are runner flags, tokens after it are
//      the command to run verbatim.       e.g.  --raw -- pnpm build
//   2. No `--` separator (pnpm often consumes the first `--`): leading known
//      flags are parsed, the first non-flag token begins the command.
// Once the command starts, NO further tokens are treated as runner flags — the
// command and its own arguments are passed through untouched.
const VALUE_FLAGS = new Set(["--head", "--tail", "--max-errors", "--max-warnings"]);
const BOOL_FLAGS = new Set(["--raw", "--no-save", "--json", "--allow-dangerous"]);

function parseArgs(argv) {
  const flags = {
    raw: false,
    save: true,
    json: false,
    allowDangerous: false,
    head: null,
    tail: null,
    maxErrors: null,
    maxWarnings: null,
  };

  const dd = argv.indexOf("--");
  let flagTokens;
  let command;

  if (dd !== -1) {
    flagTokens = argv.slice(0, dd);
    command = argv.slice(dd + 1);
  } else {
    // Walk leading flags; stop at the first token that is not a known flag.
    flagTokens = [];
    let i = 0;
    while (i < argv.length) {
      const tok = argv[i];
      if (BOOL_FLAGS.has(tok) || VALUE_FLAGS.has(tok)) {
        flagTokens.push(tok);
        if (VALUE_FLAGS.has(tok)) {
          flagTokens.push(argv[i + 1]);
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      break;
    }
    command = argv.slice(i);
  }

  for (let i = 0; i < flagTokens.length; i++) {
    const tok = flagTokens[i];
    switch (tok) {
      case "--raw": flags.raw = true; break;
      case "--no-save": flags.save = false; break;
      case "--json": flags.json = true; break;
      case "--allow-dangerous": flags.allowDangerous = true; break;
      case "--head": flags.head = toPositiveInt(flagTokens[++i]); break;
      case "--tail": flags.tail = toPositiveInt(flagTokens[++i]); break;
      case "--max-errors": flags.maxErrors = toPositiveInt(flagTokens[++i]); break;
      case "--max-warnings": flags.maxWarnings = toPositiveInt(flagTokens[++i]); break;
      default:
        // Unknown leading token before the command: surface it instead of
        // silently swallowing it.
        process.stderr.write(`agent-run: ignoring unknown flag "${tok}"\n`);
    }
  }

  return { flags, command };
}

function toPositiveInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(cwd) {
  const file = path.join(cwd, ".agent", "config.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed, redaction: { ...DEFAULT_CONFIG.redaction, ...(parsed.redaction || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Redaction (best effort, applied before anything is written or printed)
// ---------------------------------------------------------------------------
// Each entry is auditable: a named regex + replacement. We redact secret VALUES
// while keeping their keys/labels visible, so debugging context is preserved.
const REDACTORS = [
  {
    name: "private-key-block",
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replace: `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`,
  },
  // JWT-like: three base64url segments starting with the "eyJ" header.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, replace: "***REDACTED.JWT***" },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: "***REDACTED.GH_TOKEN***" },
  // npm automation/publish tokens
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{16,}\b/g, replace: "***REDACTED.NPM_TOKEN***" },
  // Credentials embedded in URLs: scheme://user:pass@host  -> keep user, hide pass
  { name: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s:@/]+)@/gi, replace: `$1$2:${REDACTED}@` },
  // Authorization: Bearer/Basic/Token <secret>
  { name: "authorization-header", re: /(authorization\s*[:=]\s*)["']?(bearer|basic|token)\s+[^\s"']+/gi, replace: `$1$2 ${REDACTED}` },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, replace: `Bearer ${REDACTED}` },
  { name: "basic", re: /\bBasic\s+[A-Za-z0-9+/]{8,}=*/g, replace: `Basic ${REDACTED}` },
  // JSON-style secret properties: "apiKey": "value"  (single or double quoted)
  {
    name: "json-secret-prop",
    re: /(["'])([A-Za-z0-9_]*(?:token|api[_-]?key|secret|password|passwd|pass|auth|cookie|session|credential|service_role|access[_-]?token|refresh[_-]?token|private[_-]?key|database_url)[A-Za-z0-9_]*)\1(\s*:\s*)(["'])([^"']*)\4/gi,
    replace: `$1$2$1$3$4${REDACTED}$4`,
  },
  // .env / shell assignment: SECRET_KEY=value  -> keep key, hide value.
  // The prefix is zero-or-more so a key that *is* the sensitive token (e.g.
  // API_KEY, SECRET, TOKEN) still matches at the start.
  {
    name: "env-assignment",
    re: /\b([A-Za-z0-9_]*(?:TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASSWD|PASS|AUTH|COOKIE|SESSION|CREDENTIAL|SERVICE_ROLE|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|DATABASE_URL)[A-Za-z0-9_]*)(\s*=\s*)("?)([^\s"']+)\3/gi,
    replace: `$1$2$3${REDACTED}$3`,
  },
];

function redact(text, enabled) {
  if (!enabled || !text) return text;
  let out = text;
  for (const r of REDACTORS) out = out.replace(r.re, r.replace);
  return out;
}

// ---------------------------------------------------------------------------
// Dangerous command blocking
// ---------------------------------------------------------------------------
// Inspects the parsed command (tokens) plus the joined string. Returns a reason
// string when the command should be blocked, otherwise null. Designed to be
// conservative and readable rather than exhaustive.
function isDangerousCommand(command) {
  const tokens = command.map((t) => String(t));
  const lower = tokens.map((t) => t.toLowerCase());
  const joined = lower.join(" ");
  const bin = path.basename(lower[0] || "");

  const has = (t) => lower.includes(t);

  // rm -rf <dangerous target>
  if (bin === "rm" || lower[0] === "rm") {
    const flagToks = lower.filter((t) => t.startsWith("-"));
    const recursive = flagToks.some((t) => /^-[a-z]*r/.test(t)) || has("--recursive");
    const force = flagToks.some((t) => /^-[a-z]*f/.test(t)) || has("--force");
    const dangerTargets = new Set(["/", ".", "./", "*", "~", "/*", "./*", "~/", ".."]);
    const hasDangerTarget = lower.slice(1).some((t) => !t.startsWith("-") && dangerTargets.has(t));
    if (recursive && force && hasDangerTarget) {
      return "recursive force-delete of a root/cwd/glob target (rm -rf)";
    }
  }

  // git reset --hard
  if (bin === "git" && has("reset") && has("--hard")) return "git reset --hard discards working-tree changes";
  // git clean with a force flag (e.g. -fdx)
  if (bin === "git" && has("clean") && lower.some((t) => /^-[a-z]*f/.test(t))) return "git clean -f deletes untracked files";

  // publish to a registry
  if (["npm", "pnpm", "yarn"].includes(bin) && has("publish")) return `${bin} publish pushes a package to a registry`;

  // production deploys
  if (bin === "vercel" && has("--prod")) return "vercel production deploy";
  if (bin === "netlify" && has("--prod")) return "netlify production deploy";
  if (bin === "railway" && has("up")) return "railway up deploys to Railway";

  // docker host-wide prune
  if (bin === "docker" && has("system") && has("prune")) return "docker system prune wipes Docker resources";

  // curl|sh / wget|bash pipe-to-shell (only meaningful if a shell is involved)
  if (/(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(joined)) {
    return "piping a download straight into a shell (curl|sh)";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Run naming
// ---------------------------------------------------------------------------
function makeTimestamp(d = new Date()) {
  // 2026-06-19T04:52:30.123Z -> 2026-06-19T04-52-30-123Z
  return d.toISOString().replace(/[:.]/g, "-");
}

function slugify(command) {
  const slug = command
    .slice(0, 4)
    .map((t) =>
      String(t)
        .replace(/^-+/, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
    )
    .filter(Boolean)
    .join("-")
    .slice(0, 48);
  return slug || "command";
}

function makeRunDirName(command, ts) {
  return `${ts}-${slugify(command)}`;
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------
function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  // Drop a single trailing empty line caused by a final newline.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function headLines(lines, n) { return lines.slice(0, n); }
function tailLines(lines, n) { return n >= lines.length ? lines.slice() : lines.slice(lines.length - n); }

// ---------------------------------------------------------------------------
// Extraction (simple, auditable regex/string matching — no AI summarization)
// ---------------------------------------------------------------------------
const TS_RE = /(?:^|\s)(?:error|warning)\s+TS\d+\b/;
const ESLINT_STYLISH_RE = /^\s+\d+:\d+\s+(error|warning)\b/i;       // "  10:5  error  msg  rule"
const ESLINT_COMPACT_RE = /^.+:\d+:\d+:\s+(error|warning)\b/i;       // "file.js:10:5: error msg"
const ESLINT_LEGACY_RE = /^.+:\s+line\s+\d+,\s+col\s+\d+,\s+(error|warning)\b/i; // compact formatter
const TEST_FAIL_HEAD_RE = /(?:^|\s)(?:✕|✗|×|✖|✘|FAIL\b|FAILED\b|not ok\b|●\s)/;
const TEST_DETAIL_RE = /^\s*(?:expected|received|assert|AssertionError|Expected|Received)\b|AssertionError|expected .* (?:to|but)\b/;
const MOCHA_FAIL_RE = /^\s*\d+\)\s+\S/;
const STACK_HEADER_RE = /^\s*(?:[\w.$]+\.)?(?:Error|Exception):/;
const STACK_SPECIAL_RE = /\b(?:AggregateError|unhandledRejection|uncaughtException|UnhandledPromiseRejection|Caused by:)\b/;
const STACK_FRAME_RE = /^\s+at\s+/;
const WARN_RE = /\b(?:warning|warn|deprecated|deprecation|peer dependency|unmet peer|vulnerabilit\w*|audit|experimental|unsupported engine|missing env|failed to resolve sourcemap)\b/i;
const GENERIC_ERR_RE = /(?:^|\s)(?:error\b|err!|fatal\b|panic\b)/i;

// A very large safety ceiling: we keep ALL TypeScript diagnostics unless the
// output is pathologically huge, per the project's reliability-first policy.
const TS_SAFETY_CEILING = 5000;

function extractDiagnostics(combined, config, flags) {
  const lines = splitLines(combined);
  const maxErrors = flags.maxErrors ?? config.maxErrors;
  const maxWarnings = flags.maxWarnings ?? config.maxWarnings;

  const typescript = [];
  const eslint = [];
  const failedTests = [];
  const stackTraces = [];
  const warnings = [];
  const genericErrors = [];

  let testCount = 0;
  let stackCount = 0;

  let lastPathHeader = null; // for eslint stylish blocks

  for (const line of lines) {
    // Track a likely file-path header for stylish ESLint output.
    if (!/\s/.test(line.trim().slice(0, 1)) && /[\\/].+\.\w+$/.test(line.trim()) && !/:\d+:\d+/.test(line)) {
      lastPathHeader = line;
    }

    if (TS_RE.test(line)) {
      if (typescript.length < TS_SAFETY_CEILING) typescript.push(line);
      continue;
    }
    if (ESLINT_STYLISH_RE.test(line)) {
      if (lastPathHeader && (eslint.length === 0 || eslint[eslint.length - 1] !== lastPathHeader)) {
        eslint.push(lastPathHeader);
        lastPathHeader = null;
      }
      eslint.push(line);
      continue;
    }
    if (ESLINT_COMPACT_RE.test(line) || ESLINT_LEGACY_RE.test(line)) {
      eslint.push(line);
      continue;
    }
    if (TEST_FAIL_HEAD_RE.test(line) || MOCHA_FAIL_RE.test(line)) {
      failedTests.push(line);
      testCount++;
      continue;
    }
    if (TEST_DETAIL_RE.test(line)) {
      failedTests.push(line);
      continue;
    }
    if (STACK_HEADER_RE.test(line) || STACK_SPECIAL_RE.test(line)) {
      stackTraces.push(line);
      stackCount++;
      continue;
    }
    if (STACK_FRAME_RE.test(line)) {
      stackTraces.push(line);
      continue;
    }
    if (WARN_RE.test(line)) {
      if (warnings.length < maxWarnings) warnings.push(line);
      continue;
    }
    if (GENERIC_ERR_RE.test(line)) {
      if (genericErrors.length < maxErrors) genericErrors.push(line);
      continue;
    }
  }

  return {
    typescript,
    eslint,
    failedTests,
    stackTraces,
    warnings,
    genericErrors,
    counts: {
      typescriptDiagnostics: typescript.length,
      eslintDiagnostics: eslint.length,
      failedTests: testCount,
      stackTraces: stackCount,
      warnings: warnings.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Summary formatting (markdown; printed to terminal and saved to summary.md)
// ---------------------------------------------------------------------------
function section(title, bodyLines) {
  if (!bodyLines || bodyLines.length === 0) return [];
  return ["", `## ${title}`, "", "```", ...bodyLines, "```"];
}

function formatSummary(meta, extracted, config, flags) {
  const { status } = meta.summary;
  const lines = [];
  const head = flags.head ?? config.defaultHead;
  const tail =
    flags.tail ?? (status === "success" ? config.defaultSuccessTail : config.defaultFailureTail);

  const statusIcon =
    status === "success" ? "✅ success" :
    status === "failure" ? "❌ failure" :
    status === "blocked" ? "⛔ blocked" : "⚠️ spawn error";

  lines.push(`# agent-run — ${statusIcon}`);
  lines.push("");
  lines.push(`- command: \`${meta.commandString}\``);
  lines.push(`- exit code: ${meta.exitCode}${meta.signal ? ` (signal ${meta.signal})` : ""}`);
  lines.push(`- duration: ${meta.durationMs} ms`);
  if (meta.saved) lines.push(`- raw logs: ${meta.runDir}`);
  else lines.push(`- raw logs: (not saved — --no-save)`);

  if (status === "blocked") {
    lines.push("");
    lines.push(`**Blocked:** ${meta.blockedReason}`);
    lines.push("");
    lines.push("This command matched the dangerous-command blocklist and was NOT executed.");
    lines.push("Re-run with `--allow-dangerous` if you are certain.");
    lines.push("");
    lines.push(showHint(meta));
    return lines.join("\n");
  }

  const combinedLines = splitLines(meta._combined || "");

  if (status === "success") {
    // Compressed view: counts + warnings + tail. Full log is on disk.
    lines.push("");
    lines.push(`- output lines: ${combinedLines.length} (stdout ${meta.stdoutLines}, stderr ${meta.stderrLines})`);
    lines.push(`- warnings: ${extracted.counts.warnings}`);
    if (extracted.counts.typescriptDiagnostics) lines.push(`- typescript diagnostics: ${extracted.counts.typescriptDiagnostics}`);
    if (extracted.counts.eslintDiagnostics) lines.push(`- eslint diagnostics: ${extracted.counts.eslintDiagnostics}`);

    lines.push(...section(`Warnings (showing up to ${flags.maxWarnings ?? config.maxWarnings})`, extracted.warnings));
    lines.push(...section(`Last ${Math.min(tail, combinedLines.length)} lines`, tailLines(combinedLines, tail)));
  } else {
    // Failure / spawn error: preserve detail.
    lines.push("");
    lines.push(`- output lines: ${combinedLines.length} (stdout ${meta.stdoutLines}, stderr ${meta.stderrLines})`);
    lines.push(`- typescript diagnostics: ${extracted.counts.typescriptDiagnostics}`);
    lines.push(`- eslint diagnostics: ${extracted.counts.eslintDiagnostics}`);
    lines.push(`- failed tests (markers): ${extracted.counts.failedTests}`);
    lines.push(`- stack traces: ${extracted.counts.stackTraces}`);
    lines.push(`- warnings: ${extracted.counts.warnings}`);

    lines.push(...section(`First ${Math.min(head, combinedLines.length)} lines`, headLines(combinedLines, head)));
    lines.push(...section("TypeScript diagnostics (all preserved)", extracted.typescript));
    lines.push(...section("ESLint diagnostics (all preserved)", extracted.eslint));
    lines.push(...section("Failed tests / assertions", extracted.failedTests));
    lines.push(...section("Stack traces", extracted.stackTraces));
    lines.push(...section(`Other error lines (up to ${flags.maxErrors ?? config.maxErrors})`, extracted.genericErrors));
    lines.push(...section(`Last ${Math.min(tail, combinedLines.length)} lines`, tailLines(combinedLines, tail)));
  }

  lines.push("");
  lines.push(showHint(meta));
  return lines.join("\n");
}

function showHint(meta) {
  if (!meta.saved) {
    return "_Logs were not saved (--no-save). Re-run without --no-save to inspect full output later._";
  }
  return [
    "---",
    "To inspect the full (redacted) logs:",
    "```",
    "pnpm agent:show -- latest",
    "pnpm agent:show -- latest --tail 300",
    'pnpm agent:show -- latest --grep "error"',
    'pnpm agent:show -- latest --grep "TS2322" --context 40',
    "```",
  ].join("\n");
}

function buildJsonSummary(meta, extracted) {
  return {
    status: meta.summary.status,
    command: meta.command,
    commandString: meta.commandString,
    exitCode: meta.exitCode,
    signal: meta.signal,
    durationMs: meta.durationMs,
    blocked: meta.blocked,
    blockedReason: meta.blockedReason || null,
    saved: meta.saved,
    runDir: meta.runDir,
    counts: extracted.counts,
    typescriptDiagnostics: extracted.typescript,
    eslintDiagnostics: extracted.eslint,
    failedTests: extracted.failedTests,
    stackTraces: extracted.stackTraces,
    warnings: extracted.warnings,
  };
}

// ---------------------------------------------------------------------------
// Persist a run to disk
// ---------------------------------------------------------------------------
function writeRunFiles(runDir, { stdout, stderr, combined, summary, meta }) {
  ensureDir(runDir);
  fs.writeFileSync(path.join(runDir, "stdout.log"), stdout, "utf8");
  fs.writeFileSync(path.join(runDir, "stderr.log"), stderr, "utf8");
  fs.writeFileSync(path.join(runDir, "combined.log"), combined, "utf8");
  fs.writeFileSync(path.join(runDir, "summary.md"), summary, "utf8");
  fs.writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Spawn helpers (cross-platform)
// ---------------------------------------------------------------------------
const WIN_CMD_SHIMS = new Set(["pnpm", "npm", "yarn", "npx", "pnpx", "corepack", "tsc", "eslint", "vitest", "jest"]);

function quoteWinArg(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(s)) return s;
  return `"${s.replace(/(["])/g, '\\$1')}"`;
}

// Decide how to invoke a command on the current platform.
// On Windows, .cmd/.bat shims (pnpm, npm, corepack, …) must run through cmd.exe;
// real .exe programs (node, git, …) are spawned directly. On POSIX everything is
// spawned directly without a shell.
function resolveSpawn(command, viaCmd) {
  const file = command[0];
  const args = command.slice(1);
  if (process.platform !== "win32") {
    return { file, args, options: {} };
  }
  const lc = String(file).toLowerCase();
  const needsCmd = viaCmd || WIN_CMD_SHIMS.has(lc) || lc.endsWith(".cmd") || lc.endsWith(".bat");
  if (!needsCmd) {
    return { file, args, options: {} };
  }
  const line = command.map(quoteWinArg).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", line],
    options: { windowsVerbatimArguments: true },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cwd = process.cwd();
  const { flags, command } = parseArgs(process.argv.slice(2));
  const config = loadConfig(cwd);
  const redactionEnabled = config.redaction && config.redaction.enabled !== false;

  if (command.length === 0) {
    process.stderr.write(
      [
        "agent-run: no command given.",
        "",
        "Usage: pnpm agent:run -- <command...>",
        "Examples:",
        "  pnpm agent:run -- pnpm build",
        "  pnpm agent:run -- git status --short",
        '  pnpm agent:run -- node -e "console.log(\'hi\')"',
        "",
        "Flags (before --): --raw --no-save --json --head N --tail N --max-errors N --max-warnings N --allow-dangerous",
        "",
      ].join("\n")
    );
    process.exit(2);
  }

  const commandString = redact(command.join(" "), redactionEnabled);
  const redactedCommand = command.map((t) => redact(String(t), redactionEnabled));
  const ts = makeTimestamp();
  const runDirRel = path.join(config.runsDir, makeRunDirName(command, ts));
  const runDirAbs = path.join(cwd, runDirRel);

  // ---- Dangerous command gate (before any execution) ----
  const dangerReason = isDangerousCommand(command);
  if (dangerReason && !flags.allowDangerous) {
    const startedAt = new Date(Date.now());
    const meta = {
      version: 1,
      command: redactedCommand,
      commandString,
      cwd,
      startedAt: startedAt.toISOString(),
      endedAt: startedAt.toISOString(),
      durationMs: 0,
      exitCode: 2,
      signal: null,
      blocked: true,
      blockedReason: dangerReason,
      saved: flags.save,
      runDir: flags.save ? runDirRel : null,
      stdoutBytes: 0,
      stderrBytes: 0,
      combinedBytes: 0,
      stdoutLines: 0,
      stderrLines: 0,
      combinedLines: 0,
      summary: { status: "blocked", typescriptDiagnostics: 0, eslintDiagnostics: 0, failedTests: 0, stackTraces: 0, warnings: 0 },
      _combined: "",
    };
    const extracted = extractDiagnostics("", config, flags);
    const summary = formatSummary(meta, extracted, config, flags);
    const metaForDisk = { ...meta };
    delete metaForDisk._combined;

    if (flags.save) writeRunFiles(runDirAbs, { stdout: "", stderr: "", combined: "", summary, meta: metaForDisk });

    if (flags.json) process.stdout.write(JSON.stringify(buildJsonSummary(meta, extracted), null, 2) + "\n");
    else process.stdout.write(summary + "\n");

    process.exit(2);
  }

  // ---- Execute ----
  const startedAt = new Date();
  const t0 = Date.now();

  let stdoutBuf = "";
  let stderrBuf = "";
  let combinedBuf = "";

  const result = await runChild(command, {
    cwd,
    onStdout: (s) => { stdoutBuf += s; combinedBuf += s; },
    onStderr: (s) => { stderrBuf += s; combinedBuf += s; },
  });

  const endedAt = new Date();
  const durationMs = Date.now() - t0;

  // Redact every captured stream before it is written or shown.
  const stdoutR = redact(stdoutBuf, redactionEnabled);
  const stderrR = redact(stderrBuf, redactionEnabled);
  let combinedR = redact(combinedBuf, redactionEnabled);

  // For spawn errors there is no child output; surface the spawn error itself.
  let status;
  let exitCode;
  if (result.spawnError) {
    status = "spawn_error";
    exitCode = result.spawnError.code === "ENOENT" ? 127 : 1;
    const msg = `agent-run: failed to start command: ${result.spawnError.message}`;
    combinedR = combinedR ? combinedR + "\n" + msg : msg;
  } else if (result.signal) {
    status = "failure";
    exitCode = result.signal === "SIGINT" ? 130 : result.signal === "SIGTERM" ? 143 : 1;
  } else {
    exitCode = result.code ?? 0;
    status = exitCode === 0 ? "success" : "failure";
  }

  const extracted = extractDiagnostics(combinedR, config, flags);

  const meta = {
    version: 1,
    command: redactedCommand,
    commandString,
    cwd,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs,
    exitCode,
    signal: result.signal || null,
    blocked: false,
    saved: flags.save,
    runDir: flags.save ? runDirRel : null,
    stdoutBytes: Buffer.byteLength(stdoutR, "utf8"),
    stderrBytes: Buffer.byteLength(stderrR, "utf8"),
    combinedBytes: Buffer.byteLength(combinedR, "utf8"),
    stdoutLines: splitLines(stdoutR).length,
    stderrLines: splitLines(stderrR).length,
    combinedLines: splitLines(combinedR).length,
    summary: {
      status,
      typescriptDiagnostics: extracted.counts.typescriptDiagnostics,
      eslintDiagnostics: extracted.counts.eslintDiagnostics,
      failedTests: extracted.counts.failedTests,
      stackTraces: extracted.counts.stackTraces,
      warnings: extracted.counts.warnings,
    },
    _combined: combinedR, // internal, not written to meta.json
  };

  const summary = formatSummary(meta, extracted, config, flags);

  const metaForDisk = { ...meta };
  delete metaForDisk._combined;

  if (flags.save) {
    writeRunFiles(runDirAbs, { stdout: stdoutR, stderr: stderrR, combined: combinedR, summary, meta: metaForDisk });
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(buildJsonSummary(meta, extracted), null, 2) + "\n");
  } else {
    process.stdout.write(summary + "\n");
    if (flags.raw) {
      process.stdout.write("\n----- RAW COMBINED OUTPUT (redacted) -----\n");
      process.stdout.write(combinedR + (combinedR.endsWith("\n") ? "" : "\n"));
    }
  }

  process.exit(exitCode);
}

// Spawn the child, capture streams, forward signals, resolve with the outcome.
function runChild(command, { cwd, onStdout, onStderr }) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    const attempt = (viaCmd) => {
      const { file, args, options } = resolveSpawn(command, viaCmd);
      let child;
      try {
        child = spawn(file, args, {
          cwd,
          // stdin inherited so non-interactive prompts don't hard-fail; stdout
          // and stderr piped so we can capture and (later) compress them.
          stdio: ["inherit", "pipe", "pipe"],
          windowsHide: true,
          ...options,
        });
      } catch (err) {
        finish({ spawnError: err });
        return;
      }

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);

      const forward = (sig) => { try { child.kill(sig); } catch {} };
      const onSigint = () => forward("SIGINT");
      const onSigterm = () => forward("SIGTERM");
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);

      const cleanup = () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };

      child.on("error", (err) => {
        cleanup();
        // On Windows a bare ENOENT for a shim may still resolve through
        // cmd.exe. A failed spawn also emits a stray "close"; detach this dead
        // child's listeners so it can't race the retry and resolve first.
        if (err.code === "ENOENT" && process.platform === "win32" && !viaCmd) {
          child.removeAllListeners("close");
          attempt(true);
          return;
        }
        finish({ spawnError: err });
      });

      child.on("close", (code, signal) => {
        cleanup();
        finish({ code, signal });
      });
    };

    attempt(false);
  });
}

main().catch((err) => {
  process.stderr.write(`agent-run: unexpected error: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
