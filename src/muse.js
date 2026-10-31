// muse.js: running Muse Wonder Full through Muse Code, reviewer B while `crosscheck muse on` (DESIGN.md section 8).
// Muse gets exactly these tools: its shell, in Muse Code's own sandbox without network, working in a throwaway copy of
// the project with a temp folder inside it, so its commands can change nothing outside that copy; its own read_file and
// search, without which Meta refuses the shell; crosscheck's read-only project-files tool; and on MQL5 work the MQL5
// docs lookups. No edit, web, memory, scheduling or sub-agent tool. That is never taken on trust: Muse's own record of
// each session (its export) must show exactly the tools that run was given, the sandbox and network it was asked for,
// only the context a clean run has and only the skills doctor --live verified, before the first real run (an echo
// run, which makes no model call) and after every run, or its answer doesn't count. Every call it makes, and every
// result, is kept in the job's bundle.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const state = require('./state');
const { spawnRun, TIMEOUT_MINUTES, COOLDOWN_MS } = require('./codex');

const MODEL = 'muse-wonder-full-1.0';
// (the sandbox stays on and the network restricted, the most Muse allows: never --yolo, --disable-sandbox or
// --disable-approval. Contributor mode on: the user chose to let Meta train on their code, 2026-10-30)
const SANDBOXED = ['--approval-mode', 'never', '--sandbox-network', 'restricted', '--disable-write', '--disable-web-tools', '--disable-reminders',
  '--disable-request-user-input', '--no-foreign-personal-context', '--contributor-mode', 'on'];
// Muse's tools, under the names its session record gives them: its own shell, read_file and search (every run; Meta
// refuses the shell without the other two, fact 26), then crosscheck's servers (mcp__<server>__<tool>): the read-only
// project-files tool (muse-files.js), and on MQL5 work the MQL5 docs lookups.
const SHELL_TOOLS = ['powershell', 'powershell_input', 'read_file', 'search'];
const FILE_TOOLS = ['list_files', 'read_file', 'search'].map(t => `mcp__project_files__${t}`);
const DOCS_TOOLS = ['mql5_find', 'mql5_read'].map(t => `mcp__mql5_docs__${t}`);
const FILES_SERVER = path.join(__dirname, 'muse-files.js');
const TEMP_DIR = '.crosscheck-tmp'; // (Muse's temp, inside the folder it works in)
// The context messages a clean shell run has (Muse Code 1.4.14, 2026-10-30): memory_snapshot holds Muse's memory notes
// and can't be turned off (the user accepted that); personal rules would add others.
const CONTEXT = ['workspace_identity', 'capability_policy', 'security_mode', 'skills_catalog', 'meta_context_note', 'session_identity',
  'sandbox_policy', 'memory_snapshot'];
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

// The tools a run with `tools` (as for serversOf) gets, by the names its session record gives them.
const toolsOf = tools => [...SHELL_TOOLS, ...(tools ? FILE_TOOLS : []), ...(tools && tools.docs ? DOCS_TOOLS : [])];

// The settings and environment that give a Muse run its tools (`tools`: { files: the manifest's absolute path, docs:
// the docs server or null, copy: the job's copy of the project, { dir, remake } (review.withCopy), or none }, or null
// for the shell alone): exactly toolsOf's, named; the file tool started by absolute paths, so a project's own file of
// that name never runs; the docs as GPT has them, each env value passed through a crosscheck-named variable set for
// this Muse process alone, since Muse takes env values only as a whole ${VAR}. (A named tool whose server can't start
// makes Muse refuse the run, so the docs can't be optional for Muse: then it doesn't take part, fact 26.)
function serversOf(tools) {
  const args = ['-c', `run.toolset=${JSON.stringify(toolsOf(tools))}`];
  const env = {};
  if (!tools) return { args, env };
  args.push('-c', `mcpServers.project-files=${JSON.stringify({ command: process.execPath, args: [FILES_SERVER, tools.files] })}`);
  if (tools.docs) {
    const docsEnv = {};
    for (const [name, value] of Object.entries(tools.docs.env || {})) {
      env[`CROSSCHECK_MQL5_DOCS_${name}`] = value;
      docsEnv[name] = `\${CROSSCHECK_MQL5_DOCS_${name}}`;
    }
    args.push('-c', `mcpServers.mql5-docs=${JSON.stringify({ command: tools.docs.command, args: tools.docs.args, env: docsEnv })}`);
  }
  return { args, env };
}

// What Muse's own record of a session shows that a review must not have: a tool the run wasn't given (`given`, as for
// serversOf), a shell outside Muse's sandbox (its files not managed, or its network not restricted, or the sandbox off),
// a context message a clean run doesn't have, a skill catalog it can't read, a skill not in `allowed` (null: doctor
// judges the skills itself), or a tool call the record doesn't show. Returns { problems, skills: [{ id, scope }],
// incomplete: the given tools the run didn't have, log: every call ({ tool, args }) and result ({ result }) in the
// record's order, unreadable: true when there was no record to read }.
function inspect(command, session, allowed, given = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-muse-'));
  try {
    const file = path.join(dir, 'export.json');
    run(command, ['export', '--session', session, '--out', file]);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return { problems: [`no readable session record (${e.message})`], skills: [], log: [], unreadable: true };
    }
    const toolsets = [];
    const context = [];
    const sandboxes = [];
    const log = [];
    const shown = new Set();
    const started = [];
    (function walk(o, key) {
      // (Muse keeps some records as JSON text, its permission record among them)
      if (key === 'record_json' && typeof o === 'string') {
        try { o = JSON.parse(o); } catch { return; }
      }
      if (!o || typeof o !== 'object') return;
      if ('toolset' in o) toolsets.push(o.toolset);
      if (Array.isArray(o.run_context_messages)) context.push(...o.run_context_messages);
      if (o.payload_type === 'runtime.session.permission_profile_committed') sandboxes.push((o.payload || {}).resolved_snapshot || {});
      if (o.payload_type === 'tool_batch.effect.started') started.push(((o.payload || {}).record || {}).call_id);
      if (o.kind === 'assistant_tool_calls_committed' && Array.isArray(o.tool_calls)) {
        for (const c of o.tool_calls) {
          // (a call counts as shown only with its tool and arguments: one without them is a command the log can't show)
          if (c && typeof c.name === 'string' && typeof c.args === 'string') shown.add(c.call_id);
          log.push({ tool: c && c.name, args: c && c.args });
        }
      }
      if (o.kind === 'output' && 'chunk' in o) log.push({ result: o.chunk });
      for (const [k, v] of Object.entries(o)) walk(v, k);
    })(record);
    const problems = [];
    const tools = [...new Set(toolsets.flatMap(t => (t && Array.isArray(t.active_tools) ? t.active_tools : ['(an unreadable tool list)'])))];
    if (!toolsets.length) problems.push('no tool list');
    const granted = toolsOf(given);
    const extra = tools.filter(t => !granted.includes(t));
    if (extra.length) problems.push(`tools ${extra.join(', ')}`);
    // (a run without the tools it was given isn't unsafe, but its answer can't count either)
    const incomplete = granted.filter(t => !tools.includes(t)).map(t => `no ${t}`);
    if (!sandboxes.length) problems.push('no sandbox record');
    if (sandboxes.some(s => (s.filesystem || {}).mode !== 'managed')) problems.push('a shell outside its sandbox');
    if (sandboxes.some(s => (s.local_command_network || {}).mode !== 'restricted')) problems.push('a shell with network');
    const modes = context.filter(m => m && m.id === 'security_mode');
    if (!modes.length || modes.some(m => !/Shell sandbox: on\./.test(String(m.text)))) problems.push('the shell sandbox off');
    // (every call that started must be in the log, or a command could run unseen)
    const unshown = started.filter(id => !shown.has(id));
    if (unshown.length) problems.push(`${unshown.length} tool call(s) its record doesn't show`);
    if (!context.length) problems.push('no context list');
    const strange = [...new Set(context.map(m => m && m.id).filter(id => !CONTEXT.includes(id)))];
    if (strange.length) problems.push(`context ${strange.join(', ')}`);
    const catalogs = context.filter(m => m && m.id === 'skills_catalog').map(m => String(m.text));
    const skills = catalogs.flatMap(t => [...t.matchAll(/<skill id="([^"]+)" scope="([^"]+)"/g)].map(m => ({ id: m[1], scope: m[2] })));
    // (every <skill entry must have been read, or one in another shape could pass unseen)
    if (catalogs.reduce((n, t) => n + (t.match(/<skill\s/g) || []).length, 0) !== skills.length) problems.push('a skill catalog it can\'t read');
    const foreign = allowed ? [...new Set(skills.map(s => s.id).filter(id => !allowed.includes(id)))] : [];
    if (foreign.length) problems.push(`skills ${foreign.join(', ')}`);
    return { problems, skills, incomplete, log };
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

// One Muse run in `workspace` (a throwaway copy of the project, or an empty folder; untrusted in Muse, so it loads no
// project rules), with the `tools` crosscheck gives it (serversOf). Its commands' temp is a folder inside the
// workspace: the sandbox user can't write one anywhere else but the user's real temp. A link there (from the project,
// or from an earlier run's commands) could point it outside, so the run doesn't start. Git gets the workspace as a
// safe folder, since commands run as the sandbox's own user, not the folder's owner. `echo` makes no model call: it only
// sets the session up, for the check before the first real run.
async function runOnce(command, { echo = false, effort = 'high', session, workspace, schema = null, prompt, tools = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-muse-'));
  try {
    fs.mkdirSync(workspace, { recursive: true });
    const temp = path.join(workspace, TEMP_DIR);
    let entry;
    try {
      entry = fs.lstatSync(temp);
    } catch {
      fs.mkdirSync(temp);
      entry = fs.lstatSync(temp);
    }
    if (!entry.isDirectory()) return { ok: false, text: '', reason: `Muse's temp folder ${temp} is a link or not a folder`, timedOut: false, looped: false, limit: false };
    const promptFile = path.join(dir, 'prompt.md');
    fs.writeFileSync(promptFile, prompt);
    const schemaFile = path.join(dir, 'schema.json');
    if (schema) fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const servers = serversOf(tools);
    const args = ['exec', '--json', '--provider', echo ? 'echo' : 'meta', ...(echo ? [] : ['--model', MODEL, '--reasoning-effort', effort]),
      '--session-id', session, ...SANDBOXED, ...servers.args, '--workspace', workspace, ...(schema && !echo ? ['--output-schema', schemaFile] : []),
      '--prompt-file', promptFile, ''];
    const env = { ...servers.env, TEMP: temp, TMP: temp, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: workspace.split(path.sep).join('/') };
    const timeoutMs = (TIMEOUT_MINUTES[effort] || 30) * 60000;
    const { stdout, failure } = await spawnRun(command[0], [...command.slice(1), ...args], { name: 'Muse', timeoutMs, stopOn: blankWatch(), env });
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

// The check before a session's first real run: an echo run (no model call) of the same command line and `tools`, as a
// scratch session with its own folder in `home`, whose record must pass the session check; one that holds anything
// unsafe takes the verification away, as a real run's does. An echo run that fails (a docs server that can't start,
// say) made no model call and ran nothing, so Muse only can't take part. Returns why not, or null.
async function precheck(p, home, tools) {
  const scratch = crypto.randomUUID();
  const r = await runOnce(p.command, { echo: true, session: scratch, workspace: path.join(home, `muse-${scratch}`), prompt: 'The session check before a review.', tools });
  if (!r.ok) return `Muse can't start: ${r.reason}`;
  const seen = inspect(p.command, scratch, p.skills, tools);
  if (seen.problems.length) return `Muse's session would hold ${seen.problems.join('; ')}${seen.unreadable ? '' : `; ${unverify()}`}`;
  return seen.incomplete.length ? `Muse's session would lack its tools: ${seen.incomplete.join('; ')}` : null;
}

// Why Muse can't take part now with `tools` (as for serversOf), or null: its cooldown, a program that isn't the
// verified one, or a pre-check that fails. A review or test plan asks before it starts anything, so GPT never runs
// twice for a Muse that can't start.
async function ready(tools = null) {
  const blocked = blockedReason();
  if (blocked) return blocked;
  const p = verifiedProgram();
  if (p.why) return p.why;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-muse-'));
  try {
    return await precheck(p, home, tools);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Keeps the calls and results a run's session record shows (inspect's log) in `home`, the job's bundle: one file per
// run, since a resumed session's record holds its earlier runs too. Returns why it couldn't, or null.
function keepCalls(home, session, seen) {
  try {
    const prefix = `muse-calls-${session}-`;
    const n = fs.readdirSync(home).filter(f => f.startsWith(prefix)).length + 1;
    fs.writeFileSync(path.join(home, `${prefix}${n}.jsonl`), seen.log.map(e => `${JSON.stringify(e)}\n`).join(''));
    return null;
  } catch (e) {
    return `Muse's calls couldn't be logged (${e.message}), so its answer was discarded`;
  }
}

// Asks Muse: only its verified program, only after an echo run of the same command line showed a clean session, one
// retry for a failure that isn't a limit, a login problem, a timeout or a loop, and the real session checked and its
// calls logged before its answer counts. It works in `tools.copy.dir` (the job's copy of the project, made afresh by
// `tools.copy.remake()` before every run, a retry's too, so no run sees what an earlier one's commands left there) or
// else a folder of its own under `home` (the attempt's bundle, where its calls are logged); `resume` continues a session
// in the workspace it was made in; `tools` (as for serversOf) go to every run of it, the same for a resumed one.
// Returns { ok, text, sessionId, reason }.
async function ask({ effort = 'high', resume = null, schema = null, prompt, home, tools = null }) {
  const blocked = blockedReason();
  if (blocked) return { ok: false, reason: blocked };
  const p = verifiedProgram();
  if (p.why) return { ok: false, reason: p.why };
  const workspaceOf = session => (tools && tools.copy ? tools.copy.dir : path.join(home, `muse-${session}`));
  const unsafe = resume ? null : await precheck(p, home, tools);
  if (unsafe) return { ok: false, reason: unsafe };
  let result;
  let session;
  for (let i = 0; i < 2; i++) {
    session = resume || crypto.randomUUID(); // (a fresh request retries in a fresh session)
    const unmade = tools && tools.copy ? tools.copy.remake() : null;
    if (unmade) return { ok: false, reason: `Muse's copy of the project couldn't be made: ${unmade}` };
    result = await runOnce(p.command, { effort, session, workspace: workspaceOf(session), schema, prompt, tools });
    if (!result.ok) {
      // (a failed run is checked and logged too, before any retry: what its session held and ran counts even though
      // its answer doesn't. Even a run Meta refuses leaves a record, so one without is unsafe too: its commands
      // couldn't be seen. A usage or login failure still starts the cooldown)
      const seen = inspect(p.command, session, p.skills, tools);
      const unlogged = seen.unreadable ? null : keepCalls(home, session, seen);
      if (seen.problems.length) return { ok: false, reason: `Muse's failed run (${result.reason}) held ${seen.problems.join('; ')}; ${unverify()}${result.limit ? cooldown() : ''}` };
      if (unlogged) return { ok: false, reason: `${result.reason}; ${unlogged}${result.limit ? cooldown() : ''}` };
    }
    if (result.ok || result.limit || result.timedOut || result.looped) break;
  }
  if (result.limit) result.reason += cooldown();
  if (!result.ok) return { ok: false, reason: result.reason };
  const seen = inspect(p.command, session, p.skills, tools);
  const unlogged = seen.unreadable ? null : keepCalls(home, session, seen);
  if (seen.problems.length) return { ok: false, reason: `Muse's session held ${seen.problems.join('; ')}, so its answer was discarded; ${unverify()}` };
  if (unlogged) return { ok: false, reason: unlogged };
  if (seen.incomplete.length) return { ok: false, reason: `Muse's session lacked its tools (${seen.incomplete.join('; ')}), so its answer was discarded` };
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

// Whether a run's log shows its shell's write to `quoted` (the target as the command names it) denied: an exit code of
// its own and PowerShell's access-denied error, not any failure (a parse error or a shell that never started proves
// nothing). PowerShell wraps its error lines, even mid-word, so the output is read with its whitespace taken out.
const refusedWrite = (log, quoted) => log.some(e => {
  try {
    const out = JSON.parse(e.result);
    return String(out.command).includes(quoted) && typeof out.exit_code === 'number' && out.exit_code !== 0
      && /PermissionDenied|UnauthorizedAccess/.test(String(out.output).replace(/\s+/g, ''));
  } catch {
    return false;
  }
});

// doctor --live: a run made exactly as a review makes it, shell and sandbox included (in a scratch folder, without the
// file tool: there is no project), asked to write a file outside its folder with its shell. It passes only if it
// completed, it really tried and its sandbox refused (a Muse that never tried proves nothing), the file doesn't exist,
// and its session passes the check (its shell only, the sandbox and network asked for, a clean run's context), with
// skills only of Muse's own (scope bundled, or plugin while nobody installed a plugin), on one version before and
// after. Then that version and those skills are recorded as verified; anything else takes the verification away.
// { ok, info }.
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
    const quoted = `'${target.replace(/'/g, "''")}'`; // (a PowerShell literal, whatever the user's temp folder is called)
    const session = crypto.randomUUID();
    const r = await runOnce(p.command, { effort: 'low', session, workspace: path.join(dir, 'workspace'),
      prompt: `This checks your sandbox; nothing else is needed. Run exactly this command with your powershell tool, once: Set-Content -LiteralPath ${quoted} -Value probe\nThen say in one sentence what happened.` });
    const seen = inspect(p.command, session, null);
    const plugins = installedPlugins(p.command);
    const foreign = seen.skills.filter(s => s.scope !== 'bundled' && !(s.scope === 'plugin' && plugins && !plugins.length)).map(s => s.id);
    const problems = [...(r.ok ? [] : [`the run failed: ${r.reason}${r.limit ? cooldown() : ''}`]), ...(fs.existsSync(target) ? ['Muse WROTE the probe file'] : []),
      ...(refusedWrite(seen.log, quoted) ? [] : ['its shell never had the write denied, so its sandbox is unproven']), ...seen.problems,
      ...(plugins ? [] : ['the installed plugins can\'t be listed']), ...(foreign.length ? [`skills that aren't Muse's own: ${foreign.join(', ')}`] : [])];
    if (!before || versionOf(p.command) !== before) problems.push('Muse changed during the check');
    if (problems.length) return { ok: false, info: `${problems.join('; ')}; ${unverify()}` };
    const saved = state.update(state.files.config(), c => { c.museVerified = before; c.museSkills = seen.skills.map(s => s.id); });
    return saved.ok ? { ok: true, info: `Muse ${before} verified: its shell sandboxed (a write outside its folder refused), no network, a clean context, ${seen.skills.length} skills of its own` }
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

module.exports = { ask, ready, probe, status, inspect, MODEL, SANDBOXED, CONTEXT, TEMP_DIR };
