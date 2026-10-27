#!/usr/bin/env node
// install.js: installs crosscheck for Claude Code (DESIGN.md section 11).
//   node install.js [--yes]            check the prerequisites, show the changes, ask, then install
// Writing settings.json is the switch, so it comes last; a failure on the way puts back everything written.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const state = require('./src/state');
const { registration, runsScript } = require('./src/hook');
const { npmRoot, claudeVersion, MIN_CLAUDE, olderThan } = require('./src/doctor');

const DOCS_TOOLS = ['mql5_find', 'mql5_read'];
// (a hook command is ours when node runs crosscheck's hook.js; any other command is kept)
const OURS = runsScript('crosscheck[\\\\/]hook\\.js');

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const paths = (claude = claudeDir()) => ({
  settings: path.join(claude, 'settings.json'), claudeMd: path.join(claude, 'CLAUDE.md'), agent: path.join(claude, 'agents', 'fallback-reviewer.md'),
  code: path.join(claude, 'crosscheck'), personal: path.join(state.HOME, 'personal.md'),
});
const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 600000 });

// ---- What install needs ----

// The Codex launcher: config.json's, else the one npm installed globally.
function findCodex() {
  const saved = state.config().codexJs;
  if (saved && fs.existsSync(saved)) return saved;
  const root = npmRoot();
  const found = root && path.join(root, '@openai', 'codex', 'bin', 'codex.js');
  return found && fs.existsSync(found) ? found : null;
}

// The prerequisites' problems (none when all hold), the Codex launcher and the Claude Code command found.
function prerequisites() {
  const problems = [];
  if (Number(process.versions.node.split('.')[0]) < 22) problems.push(`Node 22 or newer is needed (this is ${process.versions.node})`);
  if (run('git', ['--version']).status !== 0) problems.push('git is not installed');
  const codexJs = findCodex();
  if (!codexJs) problems.push('the Codex CLI is not installed (npm install -g @openai/codex)');
  else if (run(process.execPath, [codexJs, 'login', 'status']).status !== 0) problems.push('Codex is not logged in (codex login)');
  const claude = claudeVersion();
  if (!claude.version || olderThan(claude.version, MIN_CLAUDE)) problems.push(`Claude Code ${MIN_CLAUDE.join('.')} or newer is needed (${claude.text ? `found ${claude.text}` : `not found: ${claude.why}`})`);
  return { problems, codexJs, claude: claude.command };
}

// The MQL5 docs server as Codex itself reads it from its config (`codex mcp get mql5-docs --json`; a hand-made TOML
// reader missed valid spellings and dropped settings), only when the driver can pass all of it on: an enabled stdio
// server with a command, args and string env settings, and no working folder or variables taken from Codex's own
// environment. Anything else, or no answer, leaves the docs off.
function docsServer(codexJs) {
  if (!codexJs) return null;
  const r = run(process.execPath, [codexJs, 'mcp', 'get', 'mql5-docs', '--json']);
  let got = null;
  try {
    got = r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
  const t = (got && got.transport) || {};
  const args = t.args || [];
  const env = t.env || {};
  if (got === null || got.name !== 'mql5-docs' || got.enabled !== true || t.type !== 'stdio' || typeof t.command !== 'string' || t.cwd != null
    || (t.env_vars || []).length || !Array.isArray(args) || args.some(a => typeof a !== 'string') || typeof env !== 'object' || Array.isArray(env)) return null;
  // (each env name becomes part of a Codex setting's name, so only a plain variable name may: a dot, quote or = could
  // set something else)
  if (Object.entries(env).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string')) return null;
  return { command: t.command, args, env: { ...env }, tools: DOCS_TOOLS };
}

// Why install must wait, or null: a review running in any project, or a project state that can't be read.
function busy() {
  for (const dir of fs.existsSync(state.HOME) ? fs.readdirSync(state.HOME) : []) {
    const file = path.join(state.HOME, dir, 'state.json');
    if (!fs.existsSync(file)) continue;
    const s = state.read(file);
    if (s.unreadable) return `${file} can't be read (${s.unreadable})`;
    if (Object.values(s.data.running || {}).some(r => state.alive(r.pid))) return `a review is running (${dir})`;
  }
  return null;
}

// ---- The hooks ----

const ourHooks = code => registration(path.join(code, 'hook.js')); // (the list doctor checks too)

// `hooks` without crosscheck's commands; a group left with no command goes.
function withoutOurs(hooks = {}) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !OURS.test(String(h.command || ''))) })).filter(g => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

const addHooks = (hooks, extra) => Object.fromEntries([...new Set([...Object.keys(hooks), ...Object.keys(extra)])]
  .map(event => [event, [...(hooks[event] || []), ...(extra[event] || [])]]));

// ---- Install ----

// CLAUDE.md: crosscheck's import line, then the user's personal lines. One that already starts with that line is never
// written (null), since its personal lines may have been changed there, even while install runs; any other is written
// from personal.md.
function claudeMdText(p) {
  const importLine = `@${path.join(p.code, 'RULES.md').replace(/\\/g, '/')}`;
  if (readOr(p.claudeMd, '').split(/\r?\n/)[0] === importLine) return null;
  const personal = readOr(p.personal, '').trim();
  return `${importLine}\n${personal ? `\n${personal}\n` : ''}`;
}

// Writes `files` ([[path, text, or null to delete]]) so that a failure on any of them puts every one back. Each
// original stays in place until its replacement is renamed over it, and is kept aside as a hard link (no copy of its
// bytes, so a full disk can't stop the rollback; a copy where links aren't possible) until all are in place.
function writeAll(files) {
  const moved = [];
  try {
    for (const [file, text] of files) {
      const aside = fs.existsSync(file) ? `${file}.crosscheck-before` : null;
      if (aside) {
        fs.rmSync(aside, { force: true }); // (left by an install that was killed)
        try { fs.linkSync(file, aside); } catch { fs.copyFileSync(file, aside); }
      }
      moved.push([file, aside]);
      if (text === null) fs.rmSync(file, { force: true });
      else writeAtomic(file, text);
    }
  } catch (e) {
    const lost = [];
    for (const [file, aside] of moved.reverse()) {
      try {
        if (aside) fs.renameSync(aside, file);
        else fs.rmSync(file, { force: true });
      } catch {
        lost.push(file);
      }
    }
    if (lost.length) e.message += `; not put back (each previous version is next to it, as .crosscheck-before): ${lost.join(', ')}`;
    throw e;
  }
  for (const [, aside] of moved) if (aside) fs.rmSync(aside, { force: true });
}

// Installs; `checks: false` (tests only) skips the prerequisites and the test run.
async function install({ yes = false, checks = true, ask = confirm, say = text => process.stdout.write(`${text}\n`) } = {}) {
  const p = paths();
  const notReadable = config => ({ code: 1, text: `Not installed: ${state.files.config()} can't be read (${config.unreadable}).` });
  const before = state.read(state.files.config());
  if (before.unreadable) return notReadable(before);
  const found = checks ? prerequisites() : null;
  if (found && found.problems.length) return { code: 1, text: `Not installed:\n- ${found.problems.join('\n- ')}` };
  const waiting = busy();
  if (waiting) return { code: 1, text: `Not installed: ${waiting}. Run install again once nothing is running.` };
  say([`crosscheck will be installed into ${p.code}.`,
    `settings.json: any earlier crosscheck hooks are replaced by crosscheck's (${Object.keys(ourHooks(p.code)).join(', ')}); every other hook and setting stays.`,
    claudeMdText(p) === null ? 'CLAUDE.md stays as it is: it already imports the rules.' : `CLAUDE.md becomes:\n${claudeMdText(p)}`,
    `the fallback agent: ${p.agent}`].join('\n'));
  if (!yes && !(await ask('Install? [y/N] '))) return { code: 1, text: 'Nothing was changed.' };
  if (checks) {
    const tests = run(process.execPath, ['--test'], __dirname);
    if (tests.status !== 0) return { code: 1, text: `Not installed: the tests failed.\n${String(tests.stdout).split('\n').slice(-30).join('\n')}` };
  }
  const docs = docsServer(found ? found.codexJs : state.config().codexJs); // (before the lock: it asks Codex)
  const settings = JSON.parse(readOr(p.settings, '{}')); // (read again now, so a hook added meanwhile stays)
  const waitingNow = busy();
  if (waitingNow) return { code: 1, text: `Not installed: ${waitingNow}. Run install again once nothing is running.` };
  // config.json is read again under its lock, held until everything is written: what changed while install asked stays
  // (a verification doctor took away included), and nothing changes it meanwhile
  const locked = state.withLock(state.files.config(), () => {
    const now = state.read(state.files.config());
    if (now.unreadable) return notReadable(now);
    // (what install found replaces only a value nobody changed while it asked)
    const discovered = { ...(found ? { codexJs: found.codexJs, claude: found.claude } : {}), mql5Docs: docs };
    for (const k of Object.keys(discovered)) if (JSON.stringify(now.data[k]) !== JSON.stringify(before.data[k])) delete discovered[k];
    const config = { ...now.data, ...discovered, model: now.data.model || state.config().model };
    const code = fs.readdirSync(path.join(__dirname, 'src')).map(f => [path.join(p.code, f), fs.readFileSync(path.join(__dirname, 'src', f), 'utf8')]);
    const claudeMd = claudeMdText(p); // (read again now: a CLAUDE.md changed while install asked keeps its change)
    writeAll([...code,
      [path.join(p.code, 'RULES.md'), fs.readFileSync(path.join(__dirname, 'RULES.md'), 'utf8')],
      [p.agent, fs.readFileSync(path.join(__dirname, 'agents', 'fallback-reviewer.md'), 'utf8')],
      [state.files.config(), JSON.stringify(config, null, 2)],
      ...(claudeMd === null ? [] : [[p.claudeMd, claudeMd]]), // (null: left out, since writeAll's null deletes)
      [p.settings, JSON.stringify({ ...settings, hooks: addHooks(withoutOurs(settings.hooks), ourHooks(p.code)) }, null, 2)], // (the switch)
    ]);
    return null;
  });
  if (locked && locked.ok === false) return { code: 1, text: `Not installed: ${locked.why}.` };
  if (locked) return locked;
  return { code: 0, text: `crosscheck is installed. Restart Claude Code, then run: node "${path.join(p.code, 'crosscheck.js')}" doctor --live` };
}

// Asks yes or no; input that ends without an answer is a no, never a silent success.
function confirm(question, input = process.stdin) {
  const rl = readline.createInterface({ input, output: process.stdout });
  return new Promise(resolve => {
    let answered = false;
    rl.on('close', () => { if (!answered) resolve(false); });
    rl.question(question, a => { answered = true; rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const unknown = argv.filter(a => a !== '--yes');
  const job = unknown.length ? Promise.resolve({ code: 2, text: `Usage: node install.js [--yes] (not ${unknown.join(' ')})` })
    : install({ yes: argv.includes('--yes') });
  job.then(({ code, text }) => { process.stdout.write(`${text}\n`); process.exitCode = code; },
    e => { process.stdout.write(`install failed: ${e.message}\n`); process.exitCode = 1; });
}

module.exports = { install, docsServer, confirm };
