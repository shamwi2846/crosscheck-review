// muse.js: running Muse Wonder Full through Muse Code, reviewer B while `crosscheck muse on` (DESIGN.md section 8).
// Muse gets no tools at all (--preset empty), so it reads only its prompt and can't write, run commands, read the
// user's Muse memory or schedule anything. That is never taken on trust: Muse's own record of each session (its
// export) must show no tool, only the context a clean run has and only the skills doctor --live verified, before
// the first real run (an echo run, which makes no model call) and after every run, or its answer doesn't count.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const state = require('./state');
const { spawnRun, TIMEOUT_MINUTES, COOLDOWN_MS } = require('./codex');

const MODEL = 'muse-wonder-full-1.0';
const READ_ONLY = ['--preset', 'empty', '--approval-mode', 'never', '--disable-write', '--disable-shell', '--disable-web-tools', '--disable-reminders',
  '--disable-request-user-input', '--no-foreign-personal-context', '--contributor-mode', 'off'];
// The context messages a clean run has (Muse Code 1.4.14, 2026-10-30); personal rules or memory would add others.
const CONTEXT = ['workspace_identity', 'capability_policy', 'security_mode', 'skills_catalog', 'meta_context_note', 'session_identity'];
const BLANK_RUN = 300; // blank output pieces in a row that count as a loop (once seen: blank lines without end)
const LIMIT_OR_LOGIN = /allowance|usage limit|quota|rate limit|not logged in|muse login|log in|unauthorized|subscription/i;
const run = (command, args) => spawnSync(command[0], [...command.slice(1), ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });

// The Muse program the launcher would run now, run directly: the launcher updates itself, so it could switch
// versions between a check and a run. A test names its own command instead (config `museCommand`).
function programNow() {
  const cfg = state.config();
  if (cfg.museCommand) return { command: cfg.museCommand };
  let version;
  try {
    version = fs.readFileSync(path.join(cfg.museDir, '.muse-version'), 'utf8').trim();
  } catch {
    return { why: `Muse Code isn't installed in ${cfg.museDir}` };
  }
  const exe = path.join(cfg.museDir, `muse-bin-${version}.exe`);
  return fs.existsSync(exe) ? { command: [exe] } : { why: `${exe} is missing` };
}

// The build a program reports ("Muse Code 1.4.14 (1.4.14-R7309.1)": the part in brackets), or null.
function versionOf(command) {
  const r = run(command, ['--version']);
  const v = r.status === 0 && String(r.stdout).match(/\(([^()\s]+)\)/);
  return v ? v[1] : null;
}

// The program to run, only when it is the version doctor --live verified, with the skills verified with it.
function verifiedProgram() {
  const p = programNow();
  if (p.why) return p;
  const cfg = state.config();
  const version = versionOf(p.command);
  if (!version) return { why: 'Muse Code reports no version' };
  if (version !== cfg.museVerified || !Array.isArray(cfg.museSkills)) return { why: `Muse ${version} isn't verified: run doctor --live` };
  return { ...p, version, skills: cfg.museSkills };
}

// What Muse's own record of a session shows that a review must not have: any tool, a context message a clean run
// doesn't have, a skill catalog it can't read, or a skill not in `allowed` (null: doctor judges the skills itself).
// Returns { problems, skills: [{ id, scope }], unreadable: true when there was no record to read }.
function inspect(command, session, allowed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-muse-'));
  try {
    const file = path.join(dir, 'export.json');
    run(command, ['export', '--session', session, '--out', file]);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { problems: [`no readable session record (${e.message})`], skills: [], unreadable: true };
    }
    const toolsets = [];
    const context = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if ('toolset' in o) toolsets.push(o.toolset);
      if (Array.isArray(o.run_context_messages)) context.push(...o.run_context_messages);
      for (const v of Object.values(o)) walk(v);
    })(record);
    const problems = [];
    const tools = toolsets.flatMap(t => (t && Array.isArray(t.active_tools) ? t.active_tools : ['(an unreadable tool list)']));
    if (!toolsets.length) problems.push('no tool list');
    if (tools.length) problems.push(`tools ${[...new Set(tools)].join(', ')}`);
    if (!context.length) problems.push('no context list');
    const strange = [...new Set(context.map(m => m && m.id).filter(id => !CONTEXT.includes(id)))];
    if (strange.length) problems.push(`context ${strange.join(', ')}`);
    const catalogs = context.filter(m => m && m.id === 'skills_catalog').map(m => String(m.text));
    const skills = catalogs.flatMap(t => [...t.matchAll(/<skill id="([^"]+)" scope="([^"]+)"/g)].map(m => ({ id: m[1], scope: m[2] })));
    // (every <skill entry must have been read, or one in another shape could pass unseen)
    if (catalogs.reduce((n, t) => n + (t.match(/<skill\s/g) || []).length, 0) !== skills.length) problems.push('a skill catalog it can\'t read');
    const extra = allowed ? [...new Set(skills.map(s => s.id).filter(id => !allowed.includes(id)))] : [];
    if (extra.length) problems.push(`skills ${extra.join(', ')}`);
    return { problems, skills };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Watches Muse's --json output and returns why to stop it: a long run of blank output pieces is a loop.
function blankWatch() {
  let rest = '';
  let blanks = 0;
  return chunk => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || e.payload_type !== 'run.output.delta') continue;
      blanks = /\S/.test(String((e.payload || {}).text)) ? 0 : blanks + 1;
      if (blanks >= BLANK_RUN) return 'Muse looped on blank output';
    }
    return null;
  };
}

// The run's terminal event (completed with its text, or failed with its reason), or null: it alone decides, so
// Muse's own words elsewhere (which may quote "usage limit") never count.
function terminalOf(stdout) {
  let last = null;
  for (const line of stdout.split(/\r?\n/)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e && String(e.payload_type).startsWith('run.terminal.') && e.payload) last = e.payload;
  }
  return last;
}

// One Muse run in `workspace` (an empty folder, untrusted in Muse, so it loads no project rules). `echo` makes no
// model call: it only sets the session up, for the check before the first real run.
async function runOnce(command, { echo = false, effort = 'high', session, workspace, schema = null, prompt }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-muse-'));
  try {
    fs.mkdirSync(workspace, { recursive: true });
    const promptFile = path.join(dir, 'prompt.md');
    fs.writeFileSync(promptFile, prompt);
    const schemaFile = path.join(dir, 'schema.json');
    if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const args = ['exec', '--json', '--provider', echo ? 'echo' : 'meta', ...(echo ? [] : ['--model', MODEL, '--reasoning-effort', effort]),
      '--session-id', session, ...READ_ONLY, '--workspace', workspace, ...(schema && !echo ? ['--output-schema', schemaFile] : []), '--prompt-file', promptFile, ''];
    const timeoutMs = (TIMEOUT_MINUTES[effort] || 30) * 60000;
    const { stdout, failure } = await spawnRun(command[0], [...command.slice(1), ...args], { name: 'Muse', timeoutMs, stopOn: blankWatch() });
    const end = terminalOf(stdout);
    const text = end && end.terminal === 'completed' ? String(end.text || '') : '';
    const ok = !failure && !!text.trim();
    const looped = failure === 'Muse looped on blank output';
    // (Muse's own reason says more than its exit code: signing in, or waiting for the allowance)
    const reason = failure === 'TIMEOUT' ? 'Muse timed out' : looped ? failure : (end && end.reason) || failure || 'Muse returned no answer';
    return {
      ok,
      text,
      reason: ok ? null : reason,
      timedOut: failure === 'TIMEOUT',
      looped,
      limit: !ok && !!end && LIMIT_OR_LOGIN.test(String(end.reason || '')),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Why no Muse run may start now, or null: Muse's own cooldown, or shared state that can't be read.
function blockedReason() {
  const global = state.read(state.files.global());
  if (global.unreadable) return `the shared state can't be read (${global.unreadable})`;
  return global.data.museCooldownUntil > Date.now() ? `Muse is cooling down after a usage or login failure, until ${new Date(global.data.museCooldownUntil).toLocaleTimeString()}` : null;
}

// Starts Muse's own cooldown after a usage or login failure; returns '' or why it couldn't be saved.
function cooldown() {
  const saved = state.update(state.files.global(), g => { g.museCooldownUntil = Date.now() + COOLDOWN_MS; });
  return saved.ok ? '' : ` (the cooldown could not be saved: ${saved.why})`;
}

// Takes the verification away (and with it every Muse run until doctor --live passes again).
function unverify() {
  const saved = state.update(state.files.config(), c => { delete c.museVerified; delete c.museSkills; });
  return saved.ok ? 'Muse is no longer verified' : `Muse's verification couldn't be taken away (${saved.why})`;
}

// The check before a session's first real run: an echo run (no model call) of the same command line, as a scratch
// session with its own folder in `home`, whose record must pass the session check. Returns why not, or null.
async function precheck(p, home) {
  const scratch = crypto.randomUUID();
  await runOnce(p.command, { echo: true, session: scratch, workspace: path.join(home, `muse-${scratch}`), prompt: 'The session check before a review.' });
  const seen = inspect(p.command, scratch, p.skills);
  return seen.problems.length ? `Muse's session would hold ${seen.problems.join('; ')}` : null;
}

// Why Muse can't take part now, or null: its cooldown, a program that isn't the verified one, or a pre-check that
// fails. A review or test plan asks before it starts anything, so GPT never runs twice for a Muse that can't start.
async function ready() {
  const blocked = blockedReason();
  if (blocked) return blocked;
  const p = verifiedProgram();
  if (p.why) return p.why;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-muse-'));
  try {
    return await precheck(p, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Asks Muse: only its verified program, only after an echo run of the same command line showed a clean session, one
// retry for a failure that isn't a limit, a login problem, a timeout or a loop, and the real session checked before
// its answer counts. `resume` continues a session in the workspace it was made in, under `home` (the attempt's
// bundle). Returns { ok, text, sessionId, reason }.
async function ask({ effort = 'high', resume = null, schema = null, prompt, home }) {
  const blocked = blockedReason();
  if (blocked) return { ok: false, reason: blocked };
  const p = verifiedProgram();
  if (p.why) return { ok: false, reason: p.why };
  const workspaceOf = session => path.join(home, `muse-${session}`);
  const unsafe = resume ? null : await precheck(p, home);
  if (unsafe) return { ok: false, reason: unsafe };
  let result;
  let session;
  for (let i = 0; i < 2; i++) {
    session = resume || crypto.randomUUID(); // (a fresh request retries in a fresh session)
    result = await runOnce(p.command, { effort, session, workspace: workspaceOf(session), schema, prompt });
    if (!result.ok) {
      // (a failed run is checked too, before any retry, when it left a record: what its session held counts even
      // though its answer doesn't)
      const seen = inspect(p.command, session, p.skills);
      // (a usage or login failure still starts the cooldown, and still says so)
      const limit = result.limit ? `; ${result.reason}${cooldown()}` : '';
      if (!seen.unreadable && seen.problems.length) return { ok: false, reason: `Muse's failed run held ${seen.problems.join('; ')}; ${unverify()}${limit}` };
    }
    if (result.ok || result.limit || result.timedOut || result.looped) break;
  }
  if (result.limit) result.reason += cooldown();
  if (!result.ok) return { ok: false, reason: result.reason };
  const seen = inspect(p.command, session, p.skills);
  if (seen.problems.length) return { ok: false, reason: `Muse's session held ${seen.problems.join('; ')}, so its answer was discarded; ${unverify()}` };
  return { ok: true, text: result.text, sessionId: session, reason: null };
}

// Plugins the user or a project installed (`muse plugins list --json`), or null when that can't be read.
function installedPlugins(command) {
  const r = run(command, ['plugins', 'list', '--json']);
  try {
    const list = JSON.parse(r.stdout).plugins;
    return r.status === 0 && Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

// doctor --live: a run made exactly as a review makes it, asked to write a file elsewhere. It passes only if it
// completed, the file doesn't exist and its session shows no tool and only a clean run's context, with skills only of
// Muse's own (scope bundled, or plugin while nobody installed a plugin), on one version before and after. Then that
// version and those skills are recorded as verified; anything else takes the verification away. { ok, info }.
async function probe() {
  const blocked = blockedReason(); // (a cooldown proves nothing about isolation: the verification stays as it is)
  if (blocked) return { ok: false, info: `not checked: ${blocked}` };
  const p = programNow();
  if (p.why) return { ok: false, info: `${p.why}; ${unverify()}` };
  const before = versionOf(p.command);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-doctor-muse-'));
  try {
    const target = path.join(dir, 'elsewhere', 'probe.txt');
    fs.mkdirSync(path.dirname(target));
    const session = crypto.randomUUID();
    const r = await runOnce(p.command, { effort: 'low', session, workspace: path.join(dir, 'workspace'),
      prompt: `This checks your tools; nothing else is needed. Create the file ${target} containing the word probe, then say in one sentence whether it worked.` });
    const seen = inspect(p.command, session, null);
    const plugins = installedPlugins(p.command);
    const foreign = seen.skills.filter(s => s.scope !== 'bundled' && !(s.scope === 'plugin' && plugins && !plugins.length)).map(s => s.id);
    const problems = [...(r.ok ? [] : [`the run failed: ${r.reason}${r.limit ? cooldown() : ''}`]), ...(fs.existsSync(target) ? ['Muse WROTE the probe file'] : []), ...seen.problems,
      ...(plugins ? [] : ['the installed plugins can\'t be listed']), ...(foreign.length ? [`skills that aren't Muse's own: ${foreign.join(', ')}`] : [])];
    if (!before || versionOf(p.command) !== before) problems.push('Muse changed during the check');
    if (problems.length) return { ok: false, info: `${problems.join('; ')}; ${unverify()}` };
    const saved = state.update(state.files.config(), c => { c.museVerified = before; c.museSkills = seen.skills.map(s => s.id); });
    return saved.ok ? { ok: true, info: `Muse ${before} verified: no tools, a clean context, ${seen.skills.length} skills of its own` }
      : { ok: false, info: `couldn't record Muse ${before}: ${saved.why}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// For doctor and status: the switch's effect now, as { ok, info } (ok is false only when the switch is on and Muse
// can't take part).
function status() {
  if (!(state.read(state.files.global()).data || {}).muse) {
    const p = programNow();
    const version = p.why ? null : versionOf(p.command);
    return { ok: true, info: `off (${version ? `Muse Code ${version} is installed` : p.why || 'Muse Code reports no version'})` };
  }
  const p = verifiedProgram();
  const blocked = blockedReason();
  if (p.why || blocked) return { ok: false, info: `on, but Muse can't take part: ${p.why || blocked} (GPT takes its seat meanwhile)` };
  return { ok: true, info: `on: Muse ${p.version} (verified) is reviewer B in every review and checks test plans` };
}

module.exports = { ask, ready, probe, status, inspect, MODEL, READ_ONLY, CONTEXT };
