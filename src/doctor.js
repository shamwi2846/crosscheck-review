// doctor.js: whether crosscheck can work here (DESIGN.md section 4): Codex found, the hooks registered as installed,
// Claude Code new enough, the state readable, the MQL5 docs server present. With `live`, harmless real Codex runs
// prove that its isolation holds on the installed Codex version, which is then recorded as verified.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const state = require('./state');
const codex = require('./codex');
const answer = require('./answer');

const MIN_CLAUDE = [2, 1, 295]; // (the first Claude Code that honors a hook's "onFailure": "block")
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
const olderThan = (v, min) => (v[0] - min[0] || v[1] - min[1] || v[2] - min[2]) < 0;
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// npm's global folder, or null (npm run through Node: its Windows .cmd shim can't start without a shell).
function npmRoot() {
  const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = fs.existsSync(npm) ? run(process.execPath, [npm, 'root', '-g']) : run('npm', ['root', '-g']);
  const root = r.status === 0 ? String(r.stdout).trim() : '';
  return root && path.isAbsolute(root) ? root : null;
}

// Claude Code's version: from `command` (config.json's, as install found it), else, when that fails (Node moved, say),
// the `claude` command, else, where npm installed it (a .cmd shim on Windows), its cli.js through Node. Returns
// { version, text, command } from the first that works, or { why } from the last tried.
function claudeVersion(command = null) {
  const tries = [...(command ? [command] : []), ['claude']];
  let r = null;
  for (let i = 0; ; i++) {
    if (i === tries.length) { // (npm is asked only when nothing before worked)
      const npm = npmRoot();
      const cli = npm && path.join(npm, '@anthropic-ai', 'claude-code', 'cli.js');
      // (the same cli.js through this Node is still worth a try after a saved command whose Node moved)
      if (!cli || !fs.existsSync(cli) || tries.some(t => t[0] === process.execPath && t[1] === cli)) break;
      tries.push([process.execPath, cli]);
    }
    r = run(tries[i][0], [...tries[i].slice(1), '--version']);
    const v = r.status === 0 && String(r.stdout || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (v) return { version: v.slice(1).map(Number), text: v[0], command: tries[i] };
  }
  return { why: r.error ? `${r.error.code || 'it could not start'}: ${r.error.message}` : `exit ${r.status}, no version printed${String(r.stderr || '').trim() ? `: ${String(r.stderr).trim().slice(0, 300)}` : ''}` };
}

// The Codex launcher configured and the version it reports, or why there is none.
function codexNow() {
  const js = state.config().codexJs;
  if (!js || !fs.existsSync(js)) return { js, why: `not found at ${js}` };
  const r = run(process.execPath, [js, '--version']);
  const v = r.status === 0 && String(r.stdout || '').match(/\d+\.\d+\.\d+/);
  return v ? { js, version: v[0] } : { js, why: `\`codex --version\` failed (exit ${r.status})` };
}

// Whether a program can be found: an existing path, or a name on PATH (with Windows' program extensions).
function findable(cmd) {
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) return fs.existsSync(cmd);
  const exts = process.platform === 'win32' ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  return String(process.env.PATH || '').split(path.delimiter).some(dir => exts.some(e => fs.existsSync(path.join(dir, cmd + e))));
}

// The hooks as installed: every hook of `registration` once, in its event and matcher, with its exact settings (the
// screen hook failing closed), and the installed hook.js present. Returns problems.
function hookProblems() {
  const hookJs = path.join(claudeDir(), 'crosscheck', 'hook.js');
  const settings = state.read(path.join(claudeDir(), 'settings.json'));
  if (settings.unreadable) return [`settings.json can't be read (${settings.unreadable})`];
  const have = (settings.data || {}).hooks || {};
  const problems = fs.existsSync(hookJs) ? [] : [`${hookJs} is missing`];
  if ((settings.data || {}).disableAllHooks === true) problems.push('settings.json has "disableAllHooks": true, so no hook runs');
  for (const [event, groups] of Object.entries(require('./hook').registration(hookJs))) {
    for (const group of groups) {
      for (const want of group.hooks) {
        const same = [].concat(have[event] || []).filter(g => (g.matcher || '') === (group.matcher || ''))
          .flatMap(g => [].concat(g.hooks || [])).filter(h => JSON.stringify(h) === JSON.stringify(want));
        if (same.length !== 1) problems.push(`${event}${group.matcher ? ` ${group.matcher}` : ''}: ${want.command.split(' ').pop()} is registered ${same.length} times, not once as installed${want.onFailure ? ' (failing closed)' : ''}`);
      }
    }
  }
  return problems;
}

// The checks that need no GPT: [{ name, ok, info }], each run on its own, so one that throws hides no other.
function checks() {
  const out = [];
  const check = (name, fn) => {
    try {
      const [ok, info] = fn();
      out.push({ name, ok, info });
    } catch (e) {
      out.push({ name, ok: false, info: `the check failed: ${e.message}` });
    }
  };
  const cfg = state.read(state.files.config());
  const now = codexNow();
  check('Codex', () => [!!now.version, now.version ? `${now.version} at ${now.js}` : now.why]);
  check('Codex verified', () => {
    const verified = (cfg.data || {}).codexVerified;
    return [!!now.version && now.version === verified, now.version === verified ? `doctor --live verified ${verified}` : `doctor --live last verified ${verified || 'no version'}: run doctor --live`];
  });
  check('Hooks', () => { const p = hookProblems(); return [!p.length, p.join('; ') || 'all registered as installed, the screen hook failing closed']; });
  check('Claude Code', () => {
    const c = claudeVersion(state.config().claude || null);
    return [!!c.version && !olderThan(c.version, MIN_CLAUDE), c.text ? `${c.text} (${MIN_CLAUDE.join('.')} or newer honors "onFailure": "block")` : `not found: ${c.why}`];
  });
  check('State', () => {
    const files = [state.files.global(), ...(fs.existsSync(state.HOME) ? fs.readdirSync(state.HOME).map(d => path.join(state.HOME, d, 'state.json')) : [])];
    const bad = files.filter(f => fs.existsSync(f) && state.read(f).unreadable);
    return [!bad.length, bad.length ? `can't be read: ${bad.join(', ')}` : `readable (${state.HOME})`];
  });
  check('MQL5 docs', () => {
    const docs = state.config().mql5Docs;
    if (!docs) return [true, 'none recorded (reviews of MQL5 files run without them)'];
    const missing = [docs.command, ...docs.args.filter(a => /[\\/]|\.[cm]?js$|\.py$/i.test(a))].filter((f, i) => !(i === 0 ? findable(f) : fs.existsSync(f)));
    return [!missing.length, missing.length ? `missing: ${missing.join(', ')}` : `${docs.command} ${docs.args.join(' ')}`];
  });
  check('Hook problems', () => {
    const log = path.join(state.HOME, 'hooks.log');
    const recent = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => Date.parse(l.slice(0, 24)) > Date.now() - 86400000) : [];
    return [true, recent.length ? `warning: ${recent.length} in the last day (see ${log})` : 'none in the last day'];
  });
  return out;
}

// (it asks for a plain sentence, so only a Codex that enforces the schema returns JSON; and for a real attempt)
const PROBE = 'This checks your sandbox; nothing else is needed. Run exactly this shell command once with your shell tool: echo probe > %s\nThen reply in one plain sentence saying whether it worked, quoting the error it printed.';

const DENIED = /denied|not permitted|read-only|permission|EACCES|EPERM/i;

// A proven write takes away the verified version at once, before anything else runs, so a cancel can't keep it.
function unverify() {
  const saved = state.update(state.files.config(), c => { delete c.codexVerified; });
  return saved.ok ? 'no Codex version is verified now' : `the verified version couldn't be taken away (${saved.why})`;
}

// Harmless real Codex runs in an empty folder: a read-only run, and the same through its resumed session, must run
// the write (Codex reports the command) and have it refused, and answer in the schema; and the computer lockdown
// must build. [{ name, ok, info, wrote }]; a failure of its own becomes a result too, never hiding the others.
async function live() {
  const out = [];
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-doctor-'));
    const probe = async (name, file, resume) => {
      const r = await codex.ask({ mode: 'review', effort: 'medium', schema: answer.SCHEMAS.probe, cwd: dir, persist: true, resume, prompt: PROBE.replace('%s', file) });
      const wrote = fs.existsSync(path.join(dir, file));
      if (wrote) return out.push({ name, ok: false, wrote, info: `GPT could write ${file}: the sandbox is NOT read-only; ${unverify()}` }) && r;
      const read = r.ok ? answer.read('probe', r.text, {}) : null;
      // (the write itself refused: the command ran, exited with an error, and its denial names the file; a shell that
      // couldn't start, "Access is denied." with no file, proves nothing)
      const refused = (r.commands || []).some(c => c.command.includes(file) && Number.isInteger(c.exitCode) && c.exitCode > 0
        && c.output.includes(file) && DENIED.test(c.output));
      const info = !r.ok ? `the run failed: ${r.reason}`
        : read.problems.length ? `the answer didn't fit the schema (${read.problems.join('; ')}): is --output-schema enforced?`
          : !refused ? 'inconclusive: Codex reported no refused write of the file, so the sandbox wasn\'t tested' : 'the write was run and refused';
      out.push({ name, ok: r.ok && !read.problems.length && refused, info });
      return r;
    };
    const first = await probe('Read-only', 'probe.txt', null);
    if (first.ok && first.sessionId) await probe('Read-only, resumed', 'probe-resumed.txt', first.sessionId);
    else out.push({ name: 'Read-only, resumed', ok: false, info: 'no session to resume' });
  } catch (e) {
    out.push({ name: 'Live checks', ok: false, info: `the probes couldn't run: ${e.message}` });
  }
  try {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    out.push({ name: 'Live checks', ok: false, info: `the probe folder ${dir} couldn't be removed: ${e.message}` });
  }
  try { // (on its own: a failed probe never skips it)
    const lockdown = codex.computerLockdown();
    out.push({ name: 'Computer lockdown', ok: !lockdown.problem, info: lockdown.problem || 'verified from Codex\'s own listings' });
  } catch (e) {
    out.push({ name: 'Computer lockdown', ok: false, info: `the check failed: ${e.message}` });
  }
  return out;
}

// Runs the checks, and the live ones with `live`. The Codex version is recorded as verified only when every live check
// passed on the version that was there before and after them; a proven write takes away that version's record.
async function doctor({ live: liveToo = false } = {}) {
  const results = checks();
  if (liveToo) {
    const before = codexNow();
    const proved = await live();
    results.push(...proved);
    const after = codexNow();
    const verified = results.find(r => r.name === 'Codex verified');
    const same = before.version && before.version === after.version && before.js === after.js;
    if (same && proved.every(r => r.ok)) {
      const saved = state.update(state.files.config(), c => { c.codexVerified = before.version; });
      Object.assign(verified, saved.ok ? { ok: true, info: `doctor --live verified ${before.version} now` } : { ok: false, info: `couldn't record ${before.version}: ${saved.why}` });
    } else if (proved.some(r => r.wrote)) { // (its record was taken away when the write was seen)
      Object.assign(verified, { ok: false, info: `no version is verified: GPT could write in a read-only run of ${before.version || 'Codex'}` });
    } else if (!same) {
      Object.assign(verified, { ok: false, info: 'Codex changed during the checks, so nothing was verified: run doctor --live again' });
    }
  }
  return { ok: results.every(r => r.ok), text: results.map(r => `${r.ok ? 'ok     ' : 'PROBLEM'} ${r.name}: ${r.info}`).join('\n') };
}

module.exports = { doctor, npmRoot, claudeVersion, MIN_CLAUDE, olderThan };
