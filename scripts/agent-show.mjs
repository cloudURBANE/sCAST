#!/usr/bin/env node
// agent-show.mjs
// Inspect saved runs produced by agent-run.mjs. Reads the (already redacted)
// logs under .agent/runs/ — it never re-runs anything and never edits files.
//
// No dependencies. Node built-ins only. Cross-platform.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONFIG = {
  runsDir: ".agent/runs",
  defaultGrepContext: 20,
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
// Usage:
//   pnpm agent:show -- latest
//   pnpm agent:show -- latest --tail 300
//   pnpm agent:show -- latest --grep "error"
//   pnpm agent:show -- latest --grep "TS2322" --context 40
//   pnpm agent:show -- <run-id-or-path>
//
// A leading `--` (from the npm/pnpm script form) is ignored. The first non-flag
// token is the target; everything else is flags. --grep is PLAIN TEXT by
// default (not regex) and case-INSENSITIVE by default; add --case-sensitive for
// exact case, or --regex to treat the pattern as a JS regular expression.
function parseArgs(argv) {
  const tokens = argv[0] === "--" ? argv.slice(1) : argv.slice();
  const out = {
    target: null,
    tail: null,
    head: null,
    grep: null,
    context: null,
    json: false,
    regex: false,
    caseSensitive: false,
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok) {
      case "--tail": out.tail = toPositiveInt(tokens[++i]); break;
      case "--head": out.head = toPositiveInt(tokens[++i]); break;
      case "--grep": out.grep = tokens[++i] ?? ""; break;
      case "--context":
      case "-C": out.context = toPositiveInt(tokens[++i]); break;
      case "--json": out.json = true; break;
      case "--regex": out.regex = true; break;
      case "--case-sensitive": out.caseSensitive = true; break;
      default:
        if (tok.startsWith("--")) {
          process.stderr.write(`agent-show: ignoring unknown flag "${tok}"\n`);
        } else if (out.target === null) {
          out.target = tok;
        } else {
          process.stderr.write(`agent-show: ignoring extra argument "${tok}"\n`);
        }
    }
  }
  if (out.target === null) out.target = "latest";
  return out;
}

function toPositiveInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function loadConfig(cwd) {
  const file = path.join(cwd, ".agent", "config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Run resolution
// ---------------------------------------------------------------------------
function listRunDirs(runsDirAbs) {
  let entries;
  try {
    entries = fs.readdirSync(runsDirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(); // timestamp-prefixed names sort chronologically
}

function resolveRunDir(cwd, config, target) {
  const runsDirAbs = path.join(cwd, config.runsDir);

  if (target === "latest") {
    const dirs = listRunDirs(runsDirAbs);
    if (dirs.length === 0) return { error: `no runs found under ${config.runsDir}` };
    return { dir: path.join(runsDirAbs, dirs[dirs.length - 1]) };
  }

  // Absolute or relative path that exists as a directory.
  const asPath = path.isAbsolute(target) ? target : path.join(cwd, target);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
    return { dir: asPath };
  }

  // Treat as a run id under runsDir.
  const asId = path.join(runsDirAbs, target);
  if (fs.existsSync(asId) && fs.statSync(asId).isDirectory()) {
    return { dir: asId };
  }

  return { error: `run not found: "${target}" (looked under ${config.runsDir} and as a path)` };
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------
function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function grepLines(lines, pattern, { regex, caseSensitive, context }) {
  let test;
  if (regex) {
    const re = new RegExp(pattern, caseSensitive ? "" : "i");
    test = (line) => re.test(line);
  } else if (caseSensitive) {
    test = (line) => line.includes(pattern);
  } else {
    const needle = pattern.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  }

  const matchIdx = [];
  for (let i = 0; i < lines.length; i++) if (test(lines[i])) matchIdx.push(i);
  if (matchIdx.length === 0) return { matches: 0, blocks: [] };

  const ctx = context ?? 0;
  // Merge overlapping context windows into blocks.
  const blocks = [];
  let curStart = -1;
  let curEnd = -1;
  for (const idx of matchIdx) {
    const s = Math.max(0, idx - ctx);
    const e = Math.min(lines.length - 1, idx + ctx);
    if (curStart === -1) {
      curStart = s; curEnd = e;
    } else if (s <= curEnd + 1) {
      curEnd = Math.max(curEnd, e);
    } else {
      blocks.push([curStart, curEnd]);
      curStart = s; curEnd = e;
    }
  }
  blocks.push([curStart, curEnd]);

  const rendered = [];
  for (const [s, e] of blocks) {
    if (rendered.length) rendered.push("--");
    for (let i = s; i <= e; i++) {
      const isMatch = matchIdx.includes(i);
      rendered.push(`${String(i + 1).padStart(6)}${isMatch ? ":" : "-"} ${lines[i]}`);
    }
  }
  return { matches: matchIdx.length, blocks: rendered };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function readIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function fail(msg) {
  process.stderr.write(`agent-show: ${msg}\n`);
  process.exit(1);
}

function main() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(cwd);

  const resolved = resolveRunDir(cwd, config, args.target);
  if (resolved.error) fail(resolved.error);
  const dir = resolved.dir;

  const combinedPath = path.join(dir, "combined.log");
  const summaryPath = path.join(dir, "summary.md");
  const metaPath = path.join(dir, "meta.json");

  const relDir = path.relative(cwd, dir) || dir;

  // --json: print meta.json plus any selected slice.
  if (args.json) {
    const metaRaw = readIfExists(metaPath);
    if (!metaRaw) fail(`meta.json missing in ${relDir}`);
    let meta;
    try { meta = JSON.parse(metaRaw); } catch { fail(`meta.json is not valid JSON in ${relDir}`); }
    const combined = readIfExists(combinedPath) || "";
    const lines = splitLines(combined);
    const selected = {};
    if (args.grep !== null) selected.grep = grepLines(lines, args.grep, args).blocks;
    if (args.tail !== null) selected.tail = lines.slice(Math.max(0, lines.length - args.tail));
    if (args.head !== null) selected.head = lines.slice(0, args.head);
    process.stdout.write(JSON.stringify({ runDir: relDir, meta, selected }, null, 2) + "\n");
    return;
  }

  // --grep takes precedence as a focused query.
  if (args.grep !== null) {
    const combined = readIfExists(combinedPath);
    if (combined === null) fail(`combined.log missing in ${relDir}`);
    const ctx = args.context ?? 0;
    const { matches, blocks } = grepLines(splitLines(combined), args.grep, { ...args, context: ctx });
    process.stdout.write(`# grep "${args.grep}" in ${relDir}/combined.log\n`);
    process.stdout.write(`# ${matches} matching line(s)${ctx ? `, ±${ctx} context` : ""}, case-${args.caseSensitive ? "sensitive" : "insensitive"}${args.regex ? ", regex" : ""}\n\n`);
    if (matches === 0) process.stdout.write("(no matches)\n");
    else process.stdout.write(blocks.join("\n") + "\n");
    return;
  }

  // --tail / --head slices of combined.log.
  if (args.tail !== null || args.head !== null) {
    const combined = readIfExists(combinedPath);
    if (combined === null) fail(`combined.log missing in ${relDir}`);
    const lines = splitLines(combined);
    if (args.head !== null) {
      const slice = lines.slice(0, args.head);
      process.stdout.write(`# first ${slice.length} line(s) of ${relDir}/combined.log\n\n`);
      process.stdout.write(slice.join("\n") + "\n");
    }
    if (args.tail !== null) {
      const slice = lines.slice(Math.max(0, lines.length - args.tail));
      process.stdout.write(`# last ${slice.length} line(s) of ${relDir}/combined.log\n\n`);
      process.stdout.write(slice.join("\n") + "\n");
    }
    return;
  }

  // Default: show summary.md, then a pointer to combined.log.
  const summary = readIfExists(summaryPath);
  const combinedExists = fs.existsSync(combinedPath);
  if (summary === null && !combinedExists) {
    fail(`no summary.md or combined.log in ${relDir}`);
  }

  if (summary !== null) {
    process.stdout.write(summary + (summary.endsWith("\n") ? "" : "\n"));
  } else {
    process.stdout.write(`# run ${relDir}\n(no summary.md found)\n`);
  }

  if (combinedExists) {
    const lineCount = splitLines(readIfExists(combinedPath) || "").length;
    process.stdout.write(
      [
        "",
        "---",
        `Full redacted log: ${relDir}/combined.log (${lineCount} lines)`,
        "More:",
        `  pnpm agent:show -- ${args.target} --tail 300`,
        `  pnpm agent:show -- ${args.target} --grep "error"`,
        `  pnpm agent:show -- ${args.target} --grep "TS2322" --context 40`,
        "",
      ].join("\n")
    );
  }
}

try {
  main();
} catch (err) {
  fail(`unexpected error: ${err && err.stack ? err.stack : err}`);
}
