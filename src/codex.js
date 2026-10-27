// codex.js: running GPT through the Codex CLI. It builds each run's command line with GPT fully isolated
// (read-only, no connectors, plugins or other tools), locks computer-use runs down to computer use and the
// browser, and runs Codex with a timeout that kills its whole process tree.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const state = require('./state');

// Every isolated run switches these features off: --ignore-user-config alone still exposed about 1,100
// app connector tools.
const ISOLATION_OFF = ['apps', 'plugins', 'multi_agent', 'image_generation', 'tool_suggest', 'computer_use', 'browser_use', 'in_app_browser'];
// What a computer run keeps, and the features it switches off.
const CU_PLUGINS = ['computer-use', 'unified-computer-use', 'browser', 'chrome'].map(p => `${p}@openai-bundled`);
const CU_SERVERS = ['node_repl', 'cua_repl'];
const CU_FEATURES_OFF = ['apps', 'remote_plugin', 'multi_agent', 'image_generation', 'tool_suggest', 'memories'];
const PLAIN_KEY = /^[A-Za-z0-9_@-]+$/; // a name that fits in one -c key segment
const TIMEOUT_MINUTES = { medium: 20, high: 30, xhigh: 45 };
const CLOSE_GRACE_MS = 2000; // after Codex exits, how long its output may take to arrive
const WATCH_MS = 2000; // how often a computer run notes the processes it started since
const COOLDOWN_MS = 15 * 60 * 1000;
const LIMIT_ERROR = /usage limit|rate limit|quota|too many requests|model is not supported when using Codex with a ChatGPT account/i;
const LOGIN_ERROR = /not logged in|log in again|login required|unauthorized/i;

const configPairs = list => list.flatMap(value => ['-c', value]);
const tomlString = s => JSON.stringify(s); // a JSON string is also a valid TOML string

// The read-only MQL5 docs server, with its own settings (env, such as where its data is: install admits only plain
// variable names, since each becomes part of a setting's name) and exactly its lookup tools, for runs on MQL5 code.
function docsArgs(docs) {
  const k = 'mcp_servers.mql5-docs';
  return configPairs([
    `${k}.command=${tomlString(docs.command)}`,
    `${k}.args=[${docs.args.map(tomlString).join(',')}]`,
    ...Object.entries(docs.env || {}).map(([name, value]) => `${k}.env.${name}=${tomlString(value)}`),
    `${k}.required=false`,
    `${k}.enabled_tools=[${docs.tools.map(tomlString).join(',')}]`,
    ...docs.tools.map(t => `${k}.tools.${t}.approval_mode="approve"`),
  ]);
}

// The Codex command line for one run. A computer run needs its verified lockdown; every other mode is isolated.
function buildArgs({ mode, effort, cwd, outFile, schemaFile, resume, persist, docs, lockdown }) {
  if (mode === 'computer' && !Array.isArray(lockdown)) throw new Error('a computer run needs its verified lockdown');
  const cfg = state.config();
  const args = [cfg.codexJs, 'exec'];
  if (resume) args.push('resume');
  if (mode !== 'computer') args.push('--ignore-user-config');
  // (the tier is always stated, since a computer run loads the user's Codex config, which may choose Fast itself)
  const tier = (state.read(state.files.global()).data || {}).fast ? 'priority' : 'default';
  // (--json: Codex reports in JSON events, so its own errors can't be confused with the text GPT writes)
  args.push('--json', '-m', cfg.model, ...configPairs([`model_reasoning_effort=${effort}`, `windows.sandbox=${cfg.windowsSandbox}`, `service_tier="${tier}"`]));
  if (mode === 'computer') {
    args.push(...lockdown);
  } else {
    args.push(...configPairs(ISOLATION_OFF.map(f => `features.${f}=false`)));
    if (mode !== 'research') args.push(...configPairs(['web_search="disabled"']));
    if (docs) args.push(...docsArgs(docs));
  }
  if (schemaFile) args.push('--output-schema', schemaFile);
  args.push('--skip-git-repo-check', '-o', outFile);
  // (resume has no -s or -C flag, so its sandbox is set through config)
  if (resume) args.push(...configPairs(['sandbox_mode="read-only"']), resume, '-');
  else args.push('-s', 'read-only', ...(persist ? [] : ['--ephemeral']), '-C', cwd, '-');
  return args;
}

// ---- The computer lockdown ----

// Runs one Codex listing; throws when it fails, so the lockdown refuses.
function codexListing(cfg, args, what) {
  const r = spawnSync(process.execPath, [cfg.codexJs, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 << 20 });
  if (r.error || r.status !== 0) throw new Error(`\`codex ${what}\` failed (${r.error ? r.error.message : `exit ${r.status}`})`);
  return r.stdout;
}

function parseListing(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`\`codex ${what}\` printed no readable JSON`);
  }
}

function enabledPlugins(cfg, switches) {
  const list = parseListing(codexListing(cfg, ['plugin', 'list', '--json', ...switches], 'plugin list'), 'plugin list');
  const readable = list && Array.isArray(list.installed) && list.installed.every(p => p && typeof p.pluginId === 'string' && typeof p.enabled === 'boolean');
  if (!readable) throw new Error('`codex plugin list --json` has no readable "installed" list');
  return list.installed.filter(p => p.enabled).map(p => p.pluginId);
}

function enabledServers(cfg, switches) {
  const list = parseListing(codexListing(cfg, ['mcp', 'list', '--json', ...switches], 'mcp list'), 'mcp list');
  const readable = Array.isArray(list) && list.every(s => s && typeof s.name === 'string' && typeof s.enabled === 'boolean');
  if (!readable) throw new Error('`codex mcp list --json` is not a readable server list');
  return list.filter(s => s.enabled);
}

// The features that must be off but aren't (a feature Codex doesn't list counts as on).
function featuresStillOn(cfg, switches) {
  const lines = codexListing(cfg, ['features', 'list', ...switches], 'features list').split(/\r?\n/);
  const states = new Map(lines.map(l => l.trim().match(/^(\S+)\s.*\s(true|false)$/)).filter(Boolean).map(m => [m[1], m[2] === 'true']));
  return CU_FEATURES_OFF.filter(f => states.get(f) !== false);
}

// A kept server must run Codex's own program from its runtime folder, not just carry the name.
function isCodexRuntime(server) {
  if (!process.env.LOCALAPPDATA) return false;
  const runtime = path.resolve(process.env.LOCALAPPDATA, 'OpenAI', 'Codex').toLowerCase() + path.sep;
  const command = server.transport && typeof server.transport.command === 'string' ? server.transport.command : '';
  return command !== '' && path.resolve(command).toLowerCase().startsWith(runtime);
}

// The switches that lock a computer run down to computer use and the browser: built from Codex's own lists,
// then checked by listing again. Returns { args } or { problem }; anything that can't be established refuses.
function computerLockdown() {
  const cfg = state.config();
  try {
    const switches = configPairs([...CU_FEATURES_OFF.map(f => `features.${f}=false`), 'web_search="disabled"']);
    const switchOff = (names, key) => {
      for (const name of names) {
        if (!PLAIN_KEY.test(name)) throw new Error(`"${name}" can't be switched off with a plain -c key`);
        switches.push(...configPairs([`${key}.${name}.enabled=false`]));
      }
    };
    switchOff(enabledPlugins(cfg, switches).filter(p => !CU_PLUGINS.includes(p)), 'plugins'); // (first: their servers go with them)
    const servers = enabledServers(cfg, switches);
    const impostors = servers.filter(s => CU_SERVERS.includes(s.name) && !isCodexRuntime(s)).map(s => s.name);
    if (impostors.length) throw new Error(`${impostors.join(', ')} doesn't run Codex's own program`);
    switchOff(servers.filter(s => !CU_SERVERS.includes(s.name)).map(s => s.name), 'mcp_servers');
    featuresStillOn(cfg, switches); // (discovery lists the features too, so a failing listing stops here)
    const left = [
      ...enabledPlugins(cfg, switches).filter(p => !CU_PLUGINS.includes(p)),
      ...enabledServers(cfg, switches).filter(s => !CU_SERVERS.includes(s.name) || !isCodexRuntime(s)).map(s => s.name),
      ...featuresStillOn(cfg, switches).map(f => `feature ${f}`),
    ];
    return left.length ? { problem: `still enabled after the lockdown: ${left.join(', ')}` } : { args: switches };
  } catch (e) {
    return { problem: e.message };
  }
}

// ---- Running Codex ----

const running = new Set(); // Codex runs this driver started: stopped, with all they started, when it ends

// Windows: every process, as [id, parent id, start time in ms].
function processTable() {
  const list = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return String(list.stdout || '').split(/\r?\n/).map(l => l.trim().split(' ').map(Number)).filter(r => r.length === 3 && r.every(Number.isFinite));
}

// Windows: the processes of a run still running: its noted processes (`run.known`, as [id, start time]; null
// when unknown) and everything started from them since the run began. Windows keeps a dead parent's id on its
// orphans, so this also finds what an exited Codex left behind. A noted id that now belongs to a process with
// another start time is skipped, so a stranger's children are never taken for the run's.
function runProcesses(run, rows) {
  const found = [];
  const queue = [];
  for (const [id, started] of run.known) {
    const row = rows.find(([pid]) => pid === id);
    if (row && row[2] === started) found.push(id);
    if (!row || row[2] === started) queue.push(id);
  }
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid, started] of rows) {
      if (ppid !== parent || started < run.since - 1000 || found.includes(pid)) continue;
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

// Windows: Codex's launcher starts the native Codex at once, and what Codex starts hangs off that one, not off the
// launcher. So the run notes its processes from the process table (`rows`): its launcher once seen, and everything
// started from a noted process since the run began, kept after it exits, so what it leaves behind stays the run's.
// This happens at Codex's first output, and in a computer run every WATCH_MS too. Returns whether any was added.
function noteProcesses(run, rows) {
  for (const known of run.known) { // (the launcher, until it is first seen: our own child, so its row is it)
    const row = known[1] === null && rows.find(([pid]) => pid === known[0]);
    if (row) known[1] = row[2];
  }
  const added = runProcesses(run, rows).filter(pid => !run.known.some(([id]) => id === pid));
  for (const pid of added) run.known.push([pid, rows.find(([id]) => id === pid)[2]]);
  return added.length > 0;
}

// Stops a run's Codex and everything it started.
function stopRun(run) {
  const { child } = run;
  if (!child.pid) return; // (it never started)
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {} // (Codex leads its own process group)
    return;
  }
  if (child.exitCode === null && child.signalCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  for (const pid of runProcesses(run, processTable())) spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
}

process.on('exit', () => running.forEach(stopRun));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  if (os.constants.signals[signal]) process.on(signal, () => process.exit(130)); // (exit stops the runs)
}

// Starts Codex with the prompt on stdin. Resolves { stdout, stderr, failure } (failure: null, 'TIMEOUT' or a
// reason) once everything the run started has been stopped. If processes Codex leaves behind hold its output
// open, the run ends CLOSE_GRACE_MS after Codex exits, so they can't hang it. `onProcesses(pids)` hears the run's
// processes once they are noted, and again whenever more are found (a computer run's desktop record keeps them).
function spawnCodex(args, prompt, timeoutMs, onSpawn, onProcesses) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { windowsHide: true, detached: process.platform !== 'win32' });
    const run = { child, since: Date.now(), known: [[child.pid, null]] };
    running.add(run);
    if (onSpawn) onSpawn(child);
    const output = { stdout: '', stderr: '' };
    let noteTries = process.platform === 'win32' ? 3 : 0;
    let timedOut = false;
    let settled = false;
    let grace;
    const timer = setTimeout(() => { timedOut = true; stopRun(run); }, timeoutMs);
    const pids = () => run.known.map(([pid]) => pid);
    // (a computer run notes from its start on, output or not, so a process started at any time stays the run's)
    const watch = onProcesses && process.platform === 'win32'
      ? setInterval(() => { const rows = processTable(); if (rows.length && noteProcesses(run, rows)) onProcesses(pids()); }, WATCH_MS) : null;
    const collect = stream => d => {
      output[stream] += d;
      if (noteTries > 0) { // (the process table may fail to load: the next output tries again, three times in all)
        const rows = processTable();
        noteTries = rows.length ? 0 : noteTries - 1;
        if (rows.length) noteProcesses(run, rows);
        if (noteTries === 0 && onProcesses) onProcesses(pids());
      }
    };
    child.stdout.setEncoding('utf8'); // (so a character split across two chunks stays whole)
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const failureFor = code => (timedOut ? 'TIMEOUT' : code === 0 ? null : `Codex exited with ${code}`);
    const settle = failure => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearInterval(watch);
      stopRun(run);
      running.delete(run);
      resolve({ ...output, failure });
    };
    child.on('error', e => settle(`Codex could not start (${e.message})`));
    child.on('exit', code => {
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(failureFor(code));
      }, CLOSE_GRACE_MS);
    });
    child.on('close', code => settle(failureFor(code))); // (all its output has been read)
    child.stdin.on('error', () => {}); // (Codex may exit before reading the prompt)
    child.stdin.end(prompt);
  });
}

// What Codex itself reported: its session id and its errors. With --json it prints one JSON event per line on
// stdout, and GPT's messages only ever appear inside events. So Codex's errors are its "error" and
// "turn.failed" events. Text that isn't an event counts only when no session started (a failure before it,
// such as a login error); after that it may be a log line quoting what GPT wrote. Text GPT writes, which may
// well quote words like "rate limit", never counts.
function codexReport(stdout, stderr) {
  let started = false;
  let sessionId = null;
  const errors = [];
  const plain = [];
  const commands = []; // (the shell commands GPT ran, as Codex reports them: doctor's evidence of a refused write)
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event = null;
    try { event = JSON.parse(line); } catch {}
    if (!event && line.trim().startsWith('{')) continue; // (an event cut off when Codex died: it may hold GPT's text)
    if (!event || typeof event !== 'object') {
      plain.push(line.trim());
    } else if (event.type === 'thread.started') {
      started = true;
      sessionId = event.thread_id || null;
    } else if (event.type === 'error') {
      errors.push(String(event.message));
    } else if (event.type === 'turn.failed') {
      errors.push(String((event.error || {}).message));
    } else if (event.type === 'item.completed' && event.item && event.item.type === 'command_execution') {
      commands.push({ command: String(event.item.command || ''), output: String(event.item.aggregated_output || ''), exitCode: event.item.exit_code });
    }
  }
  return { sessionId, commands, errors: [...errors, ...(started ? [] : plain)].join('\n') };
}

async function runOnce(request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-'));
  try {
    const outFile = path.join(dir, 'answer.txt');
    let schemaFile = null;
    if (request.schema) {
      schemaFile = path.join(dir, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(request.schema));
    }
    const args = buildArgs({ ...request, outFile, schemaFile, cwd: request.cwd || process.cwd() });
    const timeoutMs = request.timeoutMs || (TIMEOUT_MINUTES[request.effort] || 30) * 60000;
    const { stdout, stderr, failure } = await spawnCodex(args, request.prompt, timeoutMs, request.onSpawn, request.onProcesses);
    let text = '';
    try { text = fs.readFileSync(outFile, 'utf8'); } catch {}
    const problem = failure || (text.trim() ? null : 'GPT returned no answer');
    const { sessionId, commands, errors } = codexReport(stdout, stderr);
    // (only a failed run counts, and not a timeout: a killed run's last words are no outage)
    const outage = !!failure && failure !== 'TIMEOUT';
    return {
      ok: !problem,
      text,
      sessionId,
      commands,
      reason: problem ? `${problem}${errors ? ` — ${errors.split('\n').slice(-3).join(' | ').slice(0, 600)}` : ''}` : null,
      timedOut: failure === 'TIMEOUT',
      limit: outage && LIMIT_ERROR.test(errors),
      login: outage && LOGIN_ERROR.test(errors),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Why no GPT run may start now, or null: a usage cooldown, or shared state that can't be read, since then a
// cooldown couldn't be seen or shared.
function blockedReason() {
  const global = state.read(state.files.global());
  if (global.unreadable) return `the shared state ${state.files.global()} can't be read (${global.unreadable}), so GPT runs wait until it is fixed`;
  const until = global.data.cooldownUntil || 0;
  if (until <= Date.now()) return null;
  return `GPT is cooling down after a usage or login failure, until ${new Date(until).toLocaleTimeString()}`;
}

// Asks GPT. One retry for a failure that isn't a limit, a login problem or a timeout (a retry would double a
// 20-45 minute wait), and never for computer use (repeating clicks is unsafe). A limit or login failure starts
// the cooldown, and every attempt, retries included, checks first that no other run started one.
async function ask(request) {
  const attempts = request.mode === 'computer' ? 1 : 2;
  let result;
  for (let i = 0; i < attempts; i++) {
    const blocked = blockedReason();
    if (blocked) return { ok: false, unavailable: true, reason: result ? `${result.reason}; no retry: ${blocked}` : blocked };
    result = await runOnce(request);
    if (result.ok || result.limit || result.login || result.timedOut) break;
  }
  if (result.limit || result.login) {
    const saved = state.update(state.files.global(), g => {
      g.cooldownUntil = Date.now() + COOLDOWN_MS;
      g.cooldownReason = result.reason.slice(0, 200);
    });
    if (!saved.ok) result.reason += ` (the cooldown could not be saved: ${saved.why})`;
    result.unavailable = true;
  }
  if (result.timedOut) result.unavailable = true;
  return result;
}

module.exports = { buildArgs, computerLockdown, ask, CU_PLUGINS, CU_SERVERS, ISOLATION_OFF };
