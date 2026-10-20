#!/usr/bin/env node
// install.js: installs crosscheck for Claude Code, or switches back (DESIGN.md section 11).
//   node install.js [--yes]            check the prerequisites, show the changes, ask, then install
//   node install.js --restore [--yes]  put back the settings, CLAUDE.md and agent saved by the first install
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

const DOCS_TOOLS = ['mql5_chm_status', 'mql5_chm_lookup_identifiers', 'mql5_chm_search', 'mql5_chm_read', 'mql5_chm_read_image'];
// (a hook command is ours when node runs the old setup's gate.js or crosscheck's hook.js; any other command is kept)
const script = runsScript;
const OURS = script('(?:gpt[\\\\/]gate\\.js|crosscheck[\\\\/]hook\\.js)');
const CROSSCHECK = script('crosscheck[\\\\/]hook\\.js'); // (crosscheck's own, which restore drops)
const GATE = script('gpt[\\\\/]gate\\.js'); // (the old setup's, whose folder holds its state)
const SAVED = { settings: 'settings.json', claudeMd: 'CLAUDE.md', agent: 'fallback-reviewer.md' }; // (what the backup holds)

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const paths = (claude = claudeDir()) => ({
  settings: path.join(claude, 'settings.json'), claudeMd: path.join(claude, 'CLAUDE.md'), agent: path.join(claude, 'agents', 'fallback-reviewer.md'),
  code: path.join(claude, 'crosscheck'), backup: path.join(state.HOME, 'backup'), personal: path.join(state.HOME, 'personal.md'),
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
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

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

// A plain one-line TOML value: a 'literal' or "basic" string, or a list of them, then at most a # comment.
// Returns { value }, or null for anything else.
function tomlValue(text) {
  let i = 0;
  const space = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const string = () => {
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      const s = text.slice(i + 1, end);
      i = end + 1;
      return s;
    }
    const basic = text[i] === '"' && text.slice(i).match(/^"(?:[^"\\\n]|\\.)*"/);
    if (!basic) return undefined;
    i += basic[0].length;
    try { return JSON.parse(basic[0]); } catch { return undefined; }
  };
  space();
  let value;
  if (text[i] === '[') {
    i++;
    value = [];
    for (space(); text[i] !== ']'; space()) {
      const s = string();
      if (s === undefined) return null;
      value.push(s);
      space();
      if (text[i] === ',') i++;
      else if (text[i] !== ']') return null;
    }
    i++;
  } else if ((value = string()) === undefined) return null;
  space();
  return i === text.length || text[i] === '#' ? { value } : null;
}

// The MQL5 docs server from the Codex config's [mcp_servers.mql5-chm], only when it is plain and enabled: a command,
// its args and nothing the driver wouldn't pass on (env, cwd, sub-tables). Anything else leaves the docs off.
function docsServer() {
  const text = readOr(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), '');
  if (/^\s*\[mcp_servers\.(mql5-chm|"mql5-chm")\./m.test(text)) return null;
  const section = text.match(/^\s*\[mcp_servers\.(?:mql5-chm|"mql5-chm")\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m);
  if (!section) return null;
  const got = {};
  for (const line of section[1].split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    const m = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
    if (!m || !['command', 'args', 'enabled', 'required', 'startup_timeout_sec', 'tool_timeout_sec'].includes(m[1])) return null;
    if (m[1] === 'command' || m[1] === 'args') {
      const v = tomlValue(m[2]);
      if (!v) return null; // (a value it can't read leaves the docs off, never with its args silently dropped)
      got[m[1]] = v.value;
    } else if (m[1] === 'enabled') got.enabled = m[2].replace(/#.*$/, '').trim();
  }
  if (got.enabled === 'false' || typeof got.command !== 'string' || !(got.args === undefined || Array.isArray(got.args))) return null;
  return { command: got.command, args: got.args || [], tools: DOCS_TOOLS };
}

// The old setup's project records, in the state folder next to the gate.js its hooks in `settings` run (wherever that
// is): why install must wait (a live review there, or a record that can't be read), and this folder's open work there.
function oldSetup(settings) {
  const out = { wait: null, here: null };
  const gates = commands(settings).map(c => c.match(GATE)).filter(Boolean).map(m => m[2] || m[3]);
  const dirs = [...new Set(gates.map(gate => path.join(path.dirname(gate), 'state')))].filter(d => fs.existsSync(d));
  const root = state.projectRoot(process.cwd());
  for (const [dir, f] of dirs.flatMap(d => fs.readdirSync(d).filter(name => name.endsWith('.json')).map(name => [d, name]))) {
    const s = state.read(path.join(dir, f));
    if (s.unreadable) return { ...out, wait: `the old setup's record ${f} can't be read (${s.unreadable})` };
    if (Object.keys(s.data.running || {}).some(pid => state.alive(Number(pid)))) return { ...out, wait: `a review of the old setup is running (${s.data.root || f})` };
    if (s.data.root && [process.cwd(), root].filter(Boolean).some(d => sameDir(d, s.data.root))) {
      const changes = Object.values(s.data.changes || {}).filter(Boolean);
      const open = changes.filter(c => [].concat(c.openFindings || []).length).length;
      const pending = changes.filter(c => c.at > Math.max(c.reviewedAt || 0, s.data.reviewedAt || 0)).length;
      out.here = `the old setup in ${s.data.root}: ${open} file(s) with open findings, ${pending} pending change(s)`;
    }
  }
  return out;
}

// Why install must wait, or null: a review running in either setup, or a record that can't be read.
function busy(settings) {
  for (const dir of fs.existsSync(state.HOME) ? fs.readdirSync(state.HOME) : []) {
    const file = path.join(state.HOME, dir, 'state.json');
    if (!fs.existsSync(file)) continue;
    const s = state.read(file);
    if (s.unreadable) return `${file} can't be read (${s.unreadable})`;
    if (Object.values(s.data.running || {}).some(r => state.alive(r.pid))) return `a review is running (${dir})`;
  }
  return oldSetup(settings).wait;
}

// ---- The hooks ----

const ourHooks = code => registration(path.join(code, 'hook.js')); // (the list doctor checks too)

// `hooks` without the old setup's and crosscheck's commands; a group left with no command goes.
function withoutOurs(hooks = {}, ours = OURS) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !ours.test(String(h.command || ''))) })).filter(g => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

const addHooks = (hooks, extra) => Object.fromEntries([...new Set([...Object.keys(hooks), ...Object.keys(extra)])]
  .map(event => [event, [...(hooks[event] || []), ...(extra[event] || [])]]));

// The hooks in `now` that `before` doesn't have in any group of the same event and matcher, added to `before` (in
// its first group of that matcher, else in a new group).
function mergeAdded(before, now) {
  const out = JSON.parse(JSON.stringify(before || {}));
  for (const [event, groups] of Object.entries(now)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const same = (out[event] || []).filter(x => (x.matcher || '') === (g.matcher || ''));
        if (same.some(x => x.hooks.some(y => JSON.stringify(y) === JSON.stringify(h)))) continue;
        if (same.length) same[0].hooks.push(h);
        else (out[event] = out[event] || []).push({ ...g, hooks: [h] });
      }
    }
  }
  return out;
}

// ---- Install and restore ----

const markerOf = p => path.join(p.backup, 'done.json');
// The first install's backup record, or null when there is none or it isn't whole (its marker or a saved file).
function backupRecord(p) {
  try {
    const r = JSON.parse(fs.readFileSync(markerOf(p), 'utf8'));
    return Array.isArray(r.absent) && Object.keys(SAVED).every(k => r.absent.includes(k) || fs.existsSync(path.join(p.backup, SAVED[k]))) ? r : null;
  } catch {
    return null;
  }
}

// The first install's backup, once: each file's text, or that it didn't exist; the marker is written last, atomically.
// An incomplete backup is made again, unless crosscheck is installed already (then its files are no originals).
function backupOnce(p, installed) {
  // (a readable marker, whole or not, whose profile isn't known or is another's: its backup is never taken for this
  // profile's, nor written over; only a marker cut off mid-write belongs to an interrupted first install here)
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(markerOf(p), 'utf8')); } catch {}
  if (marker && !(marker.profile && sameDir(marker.profile, claudeDir()))) return { why: `the backup in ${p.backup} belongs to the profile ${marker.profile || '(not recorded)'}, not ${claudeDir()}` };
  if (backupRecord(p)) return { made: false };
  if (fs.existsSync(markerOf(p)) && installed) return { why: `the backup in ${p.backup} is incomplete, and crosscheck is installed already: fix or remove the backup first` };
  fs.mkdirSync(p.backup, { recursive: true });
  const absent = [];
  for (const [key, name] of Object.entries(SAVED)) {
    const text = readOr(p[key], null);
    if (text === null) absent.push(key);
    else writeAtomic(path.join(p.backup, name), text);
  }
  writeAtomic(markerOf(p), JSON.stringify({ at: new Date().toISOString(), absent, profile: claudeDir() }));
  return { made: true };
}

function claudeMdText(p) {
  const personal = readOr(p.personal, '').trim();
  return `@${path.join(p.code, 'RULES.md').replace(/\\/g, '/')}\n${personal ? `\n${personal}\n` : ''}`;
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
  const config = state.read(state.files.config());
  if (config.unreadable) return { code: 1, text: `Not installed: ${state.files.config()} can't be read (${config.unreadable}).` };
  let { codexJs, claude } = state.config();
  if (checks) {
    const found = prerequisites();
    if (found.problems.length) return { code: 1, text: `Not installed:\n- ${found.problems.join('\n- ')}` };
    ({ codexJs, claude } = found);
  }
  const current = JSON.parse(readOr(p.settings, '{}'));
  const waiting = busy(current);
  if (waiting) return { code: 1, text: `Not installed: ${waiting}. Run install again once nothing is running.` };
  const claudeMd = claudeMdText(p);
  say([`crosscheck will be installed into ${p.code}.`,
    `settings.json: the old setup's hooks and any earlier crosscheck hooks are replaced by crosscheck's (${Object.keys(ourHooks(p.code)).join(', ')}); every other hook and setting stays.`,
    `CLAUDE.md becomes:\n${claudeMd}`, `the fallback agent: ${p.agent}`,
    oldSetup(current).here || 'Before the first switch, settle the old setup\'s open findings and pending changes (its own status shows them).'].join('\n'));
  if (!yes && !(await ask('Install? [y/N] '))) return { code: 1, text: 'Nothing was changed.' };
  if (checks) {
    const tests = run(process.execPath, ['--test'], __dirname);
    if (tests.status !== 0) return { code: 1, text: `Not installed: the tests failed.\n${String(tests.stdout).split('\n').slice(-30).join('\n')}` };
  }
  const settings = JSON.parse(readOr(p.settings, '{}')); // (read again now, so a hook added meanwhile stays)
  const waitingNow = busy(settings);
  if (waitingNow) return { code: 1, text: `Not installed: ${waitingNow}. Run install again once nothing is running.` };
  const backup = backupOnce(p, commands(settings).some(c => OURS.test(c) && /crosscheck/i.test(c)));
  if (backup.why) return { code: 1, text: `Not installed: ${backup.why}.` };
  const code = fs.readdirSync(path.join(__dirname, 'src')).map(f => [path.join(p.code, f), fs.readFileSync(path.join(__dirname, 'src', f), 'utf8')]);
  writeAll([...code,
    [path.join(p.code, 'RULES.md'), fs.readFileSync(path.join(__dirname, 'RULES.md'), 'utf8')],
    [p.agent, fs.readFileSync(path.join(__dirname, 'agents', 'fallback-reviewer.md'), 'utf8')],
    [state.files.config(), JSON.stringify({ ...config.data, model: config.data.model || state.config().model, codexJs, claude, mql5Docs: docsServer() }, null, 2)],
    [p.claudeMd, claudeMd],
    [p.settings, JSON.stringify({ ...settings, hooks: addHooks(withoutOurs(settings.hooks), ourHooks(p.code)) }, null, 2)], // (the switch)
  ]);
  return { code: 0, text: `crosscheck is installed${backup.made ? ' (the previous settings.json, CLAUDE.md and agent are saved for --restore)' : ''}. Restart Claude Code, then run: node "${path.join(p.code, 'crosscheck.js')}" doctor --live` };
}
const commands = settings => Object.values(settings.hooks || {}).flatMap(groups => groups.flatMap(g => (g.hooks || []).map(h => String(h.command || ''))));

// Puts the first install's backup back: settings.json without crosscheck's hooks but with every hook added since,
// and CLAUDE.md and the fallback agent as they were; a file that didn't exist is removed. Live state stays.
async function restore({ yes = false, ask = confirm } = {}) {
  const p = paths();
  const record = backupRecord(p);
  if (!record) return { code: 1, text: `Nothing to restore: there is no whole backup in ${p.backup}.` };
  if (!(record.profile && sameDir(record.profile, claudeDir()))) return { code: 1, text: `Not restored: the backup in ${p.backup} belongs to the profile ${record.profile || '(not recorded)'}, not ${claudeDir()}.` };
  const saved = (key, fallback) => (record.absent.includes(key) ? fallback : readOr(path.join(p.backup, SAVED[key]), fallback));
  if (!yes && !(await ask('Restore the settings.json, CLAUDE.md and agent saved by the first install (hooks added since stay)? [y/N] '))) {
    return { code: 1, text: 'Nothing was changed.' };
  }
  const before = JSON.parse(saved('settings', '{}'));
  // (the old setup's hooks come back; a crosscheck hook the backup held doesn't, so the two never run side by side)
  const hooks = mergeAdded(withoutOurs(before.hooks, CROSSCHECK), withoutOurs(JSON.parse(readOr(p.settings, '{}')).hooks));
  // (a settings.json that didn't exist stays away, unless hooks added since need it)
  const settings = record.absent.includes('settings') && !commands({ hooks }).length ? null : JSON.stringify({ ...before, hooks }, null, 2);
  writeAll([[p.agent, saved('agent', null)], [p.claudeMd, saved('claudeMd', null)], [p.settings, settings]]);
  return { code: 0, text: 'The previous setup is back. Restart Claude Code.' };
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
  const unknown = argv.filter(a => a !== '--yes' && a !== '--restore');
  const job = unknown.length ? Promise.resolve({ code: 2, text: `Usage: node install.js [--restore] [--yes] (not ${unknown.join(' ')})` })
    : argv.includes('--restore') ? restore({ yes: argv.includes('--yes') }) : install({ yes: argv.includes('--yes') });
  job.then(({ code, text }) => { process.stdout.write(`${text}\n`); process.exitCode = code; },
    e => { process.stdout.write(`install failed: ${e.message}\n`); process.exitCode = 1; });
}

module.exports = { install, restore, withoutOurs, mergeAdded, docsServer, confirm };
