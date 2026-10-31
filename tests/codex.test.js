// Tests for codex.js: GPT stays isolated, computer runs are locked down, timeouts kill the whole tree, and a
// usage or login failure cools every driver down (test plan P1). Codex itself is the recording stub fake-codex.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck codex test ü '));
const WORK = path.join(HOME, 'project');
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
const LOCAL = path.join(HOME, 'LocalAppData');
const RUNTIME = path.join(LOCAL, 'OpenAI', 'Codex', 'runtimes', 'cua_node', 'bin', 'node.exe');
Object.assign(process.env, { CROSSCHECK_HOME: HOME, FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG, LOCALAPPDATA: LOCAL });
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js') }));
const CODEX = path.join(__dirname, '..', 'src', 'codex.js');
const codex = require(CODEX);
const state = require('../src/state');

const SESSION = '0123abcd-0000-4000-8000-00000000c0de';
const ALLOWED = codex.CU_PLUGINS.map(id => [id, true]);
const LOCKDOWN_BASE = ['apps', 'remote_plugin', 'multi_agent', 'image_generation', 'tool_suggest', 'memories']
  .map(f => `features.${f}=false`).concat('web_search="disabled"');
const ISOLATION = ['apps', 'plugins', 'multi_agent', 'image_generation', 'tool_suggest', 'computer_use', 'browser_use', 'in_app_browser']
  .flatMap(f => ['-c', `features.${f}=false`]);

const setSpec = spec => { fs.writeFileSync(SPEC, JSON.stringify(spec)); fs.rmSync(LOG, { force: true }); };
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const execCalls = () => calls().filter(c => c.kind === 'exec');
const pluginList = list => ({ out: JSON.stringify({ installed: list.map(([pluginId, enabled]) => ({ pluginId, enabled })), available: [] }) });
const serverList = list => ({ out: JSON.stringify(list.map(([name, command]) => ({ name, enabled: true, transport: { type: 'stdio', command } }))) });
const featureList = () => ({ out: [...LOCKDOWN_BASE.slice(0, 6).map(s => s.slice(9, -6)), 'computer_use', 'browser_use']
  .map(f => `${f.padEnd(30)} stable  ${/^(computer|browser)_use$/.test(f)}`).join('\n') + '\n' });
// generated paths become placeholders, so the rest of the command line is compared exactly
const placeholders = args => args.map((a, i) => ({ '--output-schema': '<schema>', '-o': '<answer>', '-C': '<cwd>' })[args[i - 1]] || a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a saved review and its resume keep isolation and the answer schema', async () => {
  setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}' }] });
  const profile = path.join(HOME, '.codex', 'config.toml'); // a user config that enables write-capable tools
  const toml = '[features]\napps = true\nplugins = true\n[mcp_servers.writer]\ncommand = "writer.exe"\n';
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, toml);
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
  const first = await codex.ask({ mode: 'review', effort: 'high', persist: true, schema, prompt: 'review this', cwd: WORK });
  assert.strictEqual(first.ok, true, first.reason);
  assert.strictEqual(first.sessionId, SESSION);
  const second = await codex.ask({ mode: 'review', effort: 'high', resume: SESSION, schema, prompt: 'round 2', cwd: WORK });
  assert.strictEqual(second.ok, true, second.reason);
  const [fresh, resumed] = execCalls().map(c => placeholders(c.args));
  const head = ['--json', '-m', 'gpt-test', '-c', 'model_reasoning_effort=high', '-c', 'windows.sandbox=unelevated', '-c', 'service_tier="default"', ...ISOLATION,
    '--output-schema', '<schema>', '--skip-git-repo-check', '-o', '<answer>'];
  assert.deepStrictEqual(fresh, ['exec', '--ignore-user-config', ...head, '-s', 'read-only', '-C', '<cwd>', '-']);
  assert.deepStrictEqual(resumed, ['exec', 'resume', '--ignore-user-config', ...head, '-c', 'sandbox_mode="read-only"', SESSION, '-']);
  assert.strictEqual(fs.readFileSync(profile, 'utf8'), toml);
});

// (test plan T4) Web search for every isolated mode can't reach a computer run: its one web setting is the lockdown's.
test('a computer run keeps web search off while every isolated mode has it', () => {
  const lockdown = ['-c', 'features.apps=false', '-c', 'web_search="disabled"'];
  const web = args => args.filter(a => /web_search|--search/.test(a));
  assert.deepStrictEqual(web(codex.buildArgs({ mode: 'computer', lockdown, effort: 'high', cwd: WORK, outFile: 'a' })), ['web_search="disabled"']);
  for (const mode of ['review', 'consult', 'research', 'write']) {
    const args = codex.buildArgs({ mode, effort: 'high', cwd: WORK, outFile: 'a' });
    assert.deepStrictEqual(web(args), [], `${mode}: Codex's default web search`);
    assert.ok(args.includes('--ignore-user-config') && args.includes('read-only') && ISOLATION.every(a => args.includes(a)), `${mode}: isolated and read-only`);
  }
});

test("the computer lockdown refuses a node_repl outside Codex's runtime", () => {
  setSpec({
    'plugin list': [pluginList(ALLOWED)],
    'mcp list': [serverList([['node_repl', 'C:\\Elsewhere\\node.exe'], ['cua_repl', RUNTIME]])],
    'features list': [featureList()],
  });
  const r = codex.computerLockdown();
  assert.match(r.problem || '', /node_repl doesn't run Codex's own program/);
  assert.strictEqual(execCalls().length, 0);
});

test('the computer lockdown refuses a server left enabled after its switch', () => {
  const servers = serverList([['node_repl', RUNTIME], ['cua_repl', RUNTIME], ['write_server', 'C:\\tools\\write.exe']]);
  setSpec({
    'plugin list': [pluginList([...ALLOWED, ['slack@openai-curated', true]]), pluginList(ALLOWED)],
    'mcp list': [servers, servers],
    'features list': [featureList()],
  });
  const r = codex.computerLockdown();
  assert.match(r.problem || '', /still enabled after the lockdown: write_server/);
  const log = calls();
  assert.deepStrictEqual(log.map(c => c.kind), ['plugin list', 'mcp list', 'features list', 'plugin list', 'mcp list', 'features list']);
  for (const call of log) for (const s of LOCKDOWN_BASE) assert.ok(call.args.includes(s), `${call.kind} lacks ${s}`);
  for (const call of log.slice(1)) assert.ok(call.args.includes('plugins.slack@openai-curated.enabled=false'));
  for (const call of log.slice(2)) assert.ok(call.args.includes('mcp_servers.write_server.enabled=false'));
  assert.strictEqual(execCalls().length, 0);
});

test('a computer timeout kills the whole process tree, with no retry', async () => {
  const pidFile = path.join(HOME, 'pids.json');
  setSpec({
    'plugin list': [pluginList(ALLOWED)],
    'mcp list': [serverList([['node_repl', RUNTIME], ['cua_repl', RUNTIME]])],
    'features list': [featureList()],
    exec: [{ hang: pidFile }],
  });
  const lockdown = codex.computerLockdown();
  assert.ok(lockdown.args, lockdown.problem);
  const r = await codex.ask({ mode: 'computer', lockdown: lockdown.args, effort: 'high', prompt: 'look only', cwd: WORK, timeoutMs: 3000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  const runs = execCalls();
  assert.strictEqual(runs.length, 1);
  assert.ok(runs[0].args.join('\n').includes(lockdown.args.join('\n')));
  assert.ok(!runs[0].args.includes('--ignore-user-config'));
  assert.ok(!runs[0].args.some(a => /^features\.(computer_use|browser_use|in_app_browser)=false$/.test(a)));
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.strictEqual(pids.length, 3);
  for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(100);
  const survivors = pids.filter(alive);
  survivors.forEach(pid => { try { process.kill(pid); } catch {} });
  assert.deepStrictEqual(survivors, []);
});

test('processes an exited Codex left holding its output end the run and are stopped, even if the first process check failed', { timeout: 90000 }, async () => {
  const pidFile = path.join(HOME, 'orphans.json');
  setSpec({ exec: [{ orphan: pidFile, text: '{"verdict":"NO_ISSUES"}' }] });
  const started = Date.now();
  const realPath = process.env.PATH;
  process.env.PATH = ''; // (the process table can't be read at Codex's first output)
  setTimeout(() => { process.env.PATH = realPath; }, 1000);
  const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: WORK, timeoutMs: 60000 });
  assert.strictEqual(r.ok, true, r.reason);
  assert.ok(Date.now() - started < 30000, `took ${Date.now() - started} ms`);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')).slice(1); // (left by the exited native process)
  for (let i = 0; i < 50 && pids.some(alive); i++) await sleep(100);
  const survivors = pids.filter(alive);
  survivors.forEach(pid => { try { process.kill(pid); } catch {} });
  assert.deepStrictEqual(survivors, []);
});

test('a run that tracks its processes keeps noting them, even after a failed first check and no more output: a late helper\'s worker stays the run\'s and is stopped with it', { skip: process.platform !== 'win32' && 'the process notes are Windows-only', timeout: 120000 }, async () => {
  const gate = fs.mkdtempSync(path.join(HOME, 'late-'));
  const pidFile = path.join(gate, 'worker.pid');
  setSpec({ exec: [{ late: { pidFile, gate }, text: 'answer' }] });
  const notes = [];
  const noted = pid => notes.some(list => list.includes(pid));
  const until = async (check, what) => { for (let i = 0; i < 600 && !check(); i++) await sleep(50); assert.ok(check(), `${what} never happened`); };
  const realPath = process.env.PATH;
  process.env.PATH = ''; // (the process table can't be read at Codex's first output, its only one until the end)
  setTimeout(() => { process.env.PATH = realPath; }, 1000);
  const running = codex.ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: WORK, timeoutMs: 90000, onProcesses: pids => notes.push(pids) });
  let helper = null;
  let worker = null;
  try {
    await until(() => fs.existsSync(`${pidFile}.helper`), 'the helper\'s start');
    helper = Number(fs.readFileSync(`${pidFile}.helper`, 'utf8'));
    await until(() => noted(helper), 'a note of the helper');
    fs.writeFileSync(path.join(gate, 'go'), '');
    await until(() => fs.existsSync(pidFile) && !alive(helper), 'the worker\'s start and the helper\'s exit');
    worker = Number(fs.readFileSync(pidFile, 'utf8'));
    await until(() => noted(worker), 'a note of the worker, found through the exited helper');
    fs.writeFileSync(path.join(gate, 'done'), '');
    const r = await running;
    assert.strictEqual(r.ok, true, r.reason);
    for (let i = 0; i < 50 && alive(worker); i++) await sleep(100);
    assert.strictEqual(alive(worker), false, 'the worker is stopped with the run');
    const count = notes.length;
    await sleep(5000);
    assert.strictEqual(notes.length, count, 'no noting goes on after the run');
  } finally {
    fs.writeFileSync(path.join(gate, 'done'), '');
    for (const pid of [helper, worker]) if (pid && alive(pid)) try { process.kill(pid); } catch {}
  }
});

test('a retry waits out a cooldown another driver started meanwhile, and unreadable shared state stops every run', async () => {
  const global = state.files.global();
  setSpec({ exec: [{ fail: 'error: something broke', code: 1 }] });
  const anotherDriverHitALimit = () => state.update(global, g => { g.cooldownUntil = Date.now() + 60000; });
  const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: WORK, onSpawn: anotherDriverHitALimit });
  assert.strictEqual(r.unavailable, true);
  assert.match(r.reason, /no retry: GPT is cooling down/);
  assert.strictEqual(execCalls().length, 1);
  fs.writeFileSync(global, '{"cooldownUntil": 17');
  const blocked = await codex.ask({ mode: 'review', effort: 'high', prompt: 'y', cwd: WORK });
  assert.strictEqual(blocked.unavailable, true);
  assert.match(blocked.reason, /can't be read/);
  assert.strictEqual(execCalls().length, 1);
  assert.strictEqual(fs.readFileSync(global, 'utf8'), '{"cooldownUntil": 17');
  fs.rmSync(global);
});

test('limit words in GPT\'s messages or in session logs start no cooldown, Codex\'s own limit error does', async () => {
  const gpt = 'Error handling must retry on rate limits. The log ends with:\nERROR: unauthorized\nERROR: quota exceeded';
  setSpec({ exec: [
    { gpt, log: 'WARN exec: the command GPT ran printed "401 Unauthorized: usage limit"', fail: 'stream disconnected before completion', code: 1 },
    { gpt, fail: "You've hit your usage limit. Try again at 9:15 PM.", code: 1 },
  ] });
  const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'Review this code:\nerror: rate limit or quota hit, too many requests\nif (status === 401) throw new Error("unauthorized")', cwd: WORK });
  assert.strictEqual(execCalls().length, 2); // (the first failure counted as ordinary, so it was retried)
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.limit, true);
  assert.strictEqual(r.login, false);
  assert.strictEqual(r.unavailable, true);
  assert.ok(state.read(state.files.global()).data.cooldownUntil > Date.now());
  fs.rmSync(state.files.global());
});

test('a login failure on the retry starts a 15-minute cooldown that other drivers respect', async () => {
  setSpec({ exec: [{ fail: 'error: something broke', code: 1 }, { fail: 'error: not logged in, run codex login', code: 1 }, { text: 'fine' }] });
  const before = Date.now();
  const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: WORK });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.login, true);
  assert.strictEqual(execCalls().length, 2); // the ordinary failure was retried once, the login failure wasn't
  const until = state.read(state.files.global()).data.cooldownUntil;
  assert.ok(until >= before + 15 * 60000 && until <= Date.now() + 15 * 60000, `cooldown ends at ${until}`);
  const otherDriver = () => JSON.parse(spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(CODEX)}).ask({ mode: 'review', effort: 'high', prompt: 'y', cwd: ${JSON.stringify(WORK)} }).then(r => console.log(JSON.stringify(r)))`],
  { env: process.env, encoding: 'utf8' }).stdout);
  assert.strictEqual(otherDriver().unavailable, true);
  state.update(state.files.global(), g => { g.cooldownUntil = Date.now() + 2000; }); // (just before it ends)
  assert.strictEqual(otherDriver().unavailable, true);
  assert.strictEqual(execCalls().length, 2);
  state.update(state.files.global(), g => { g.cooldownUntil = Date.now() - 1; });
  assert.strictEqual(otherDriver().ok, true);
  assert.strictEqual(execCalls().length, 3);
});

// The Fast switch's test plan: every run states Codex's tier, whatever the shared record or the user's Codex config says.
const setFast = fast => state.update(state.files.global(), g => { if (fast === undefined) delete g.fast; else g.fast = fast; });
const tiersOf = run => run.args.filter((a, i) => run.args[i - 1] === '-c' && a.startsWith('service_tier='));

test('every run explicitly selects the shared tier without weakening isolation', async () => {
  const profile = path.join(HOME, '.codex', 'config.toml'); // (the user's own config chooses Fast and write-capable tools)
  const toml = 'service_tier = "priority"\n[features]\napps = true\n[mcp_servers.writer]\ncommand = "writer.exe"\n';
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, toml);
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
  const docs = { command: 'docs.exe', args: ['server.mjs'], env: {}, tools: ['mql5_find', 'mql5_read'] };
  for (const [fast, tier] of [[undefined, 'default'], [true, 'priority'], [false, 'default']]) {
    setFast(fast);
    setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}' }], 'plugin list': [pluginList(ALLOWED)],
      'mcp list': [serverList([['node_repl', RUNTIME], ['cua_repl', RUNTIME]])], 'features list': [featureList()] });
    for (const request of [{ mode: 'review', persist: true, schema, docs }, { mode: 'review', resume: SESSION, schema }, { mode: 'review' }, { mode: 'research' }]) {
      const r = await codex.ask({ effort: 'high', prompt: 'look', cwd: WORK, ...request });
      assert.ok(r.ok, r.reason);
    }
    const lockdown = codex.computerLockdown();
    assert.ok(lockdown.args, lockdown.problem);
    assert.ok((await codex.ask({ mode: 'computer', lockdown: lockdown.args, effort: 'high', prompt: 'look only', cwd: WORK })).ok);
    const [fresh, resumed, consult, research, computer] = execCalls();
    for (const run of [fresh, resumed, consult, research, computer]) assert.deepStrictEqual(tiersOf(run), [`service_tier="${tier}"`], `fast ${fast}`);
    for (const run of [fresh, resumed, consult, research]) {
      assert.ok(run.args.includes('--ignore-user-config') && ISOLATION.every(a => run.args.includes(a)), 'isolated as before');
      assert.ok(run.args.includes('read-only') || run.args.includes('sandbox_mode="read-only"'), 'read-only as before');
    }
    assert.ok(fresh.args.includes('--output-schema') && resumed.args.includes('--output-schema'));
    assert.ok(fresh.args.includes('mcp_servers.mql5-docs.enabled_tools=["mql5_find","mql5_read"]'), 'the docs server keeps only its lookup tools');
    assert.ok([fresh, resumed, consult, research].every(run => !run.args.includes('web_search="disabled"')), 'every isolated mode has the web');
    assert.ok(computer.args.join('\n').includes(lockdown.args.join('\n')) && !computer.args.includes('--ignore-user-config'), 'the computer lockdown as before');
  }
  assert.strictEqual(fs.readFileSync(profile, 'utf8'), toml, "the user's Codex config is unchanged");
  setFast(undefined);
  fs.rmSync(profile);
});

test('the MQL5 docs server is taken from Codex\'s own reading of its config, and left off for anything the driver can\'t pass on', () => {
  const entry = (transport = {}, over = {}) => ({ name: 'mql5-docs', enabled: true, disabled_reason: null, ...over,
    transport: { type: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\docs\\server.mjs'], env: { MQL5_DOCS_DATA: 'C:\\MQL5 "docs"' }, env_vars: [], cwd: null, ...transport },
    enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null });
  const docs = (answer, code = 0) => { setSpec({ 'mcp get': [{ out: typeof answer === 'string' ? answer : JSON.stringify(answer), code }] }); return codex.docsServer(); };
  assert.deepStrictEqual(docs(entry()), { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\docs\\server.mjs'], env: { MQL5_DOCS_DATA: 'C:\\MQL5 "docs"' }, tools: ['mql5_find', 'mql5_read'] });
  assert.deepStrictEqual(calls().map(c => [c.kind, c.args]), [['mcp get', ['mcp', 'get', 'mql5-docs', '--json']]]);
  assert.deepStrictEqual(docs(entry({ args: null, env: null })), { command: 'C:\\Program Files\\nodejs\\node.exe', args: [], env: {}, tools: ['mql5_find', 'mql5_read'] });
  // (an env name that isn't a plain variable name would become part of another setting's name: the whole entry is off)
  for (const name of ['X="ok",NODE_OPTIONS', 'a.b', '1ST', '']) assert.strictEqual(docs(entry({ env: { MQL5_DOCS_DATA: 'C:/d', [name]: 'x' } })), null, name);
  const proto = docs(JSON.stringify(entry()).replace('"env":{', '"env":{"__proto__":"p",'));
  assert.deepStrictEqual(Object.entries(proto.env), [['__proto__', 'p'], ['MQL5_DOCS_DATA', 'C:\\MQL5 "docs"']], 'a __proto__ name is kept as a setting');
  for (const [why, answer] of [
    ['not enabled', entry({}, { enabled: false })], ['another server', entry({}, { name: 'mql5-chm' })], ['not stdio', entry({ type: 'streamable_http' })],
    ['a working folder', entry({ cwd: 'C:/docs' })], ['variables from Codex\'s environment', entry({ env_vars: ['DOCS'] })],
    ['an arg that isn\'t a string', entry({ args: ['a', 1] })], ['an env value that isn\'t a string', entry({ env: { MQL5_DOCS_DATA: 1 } })],
    ['env as a list', entry({ env: ['x'] })], ['no command', entry({ command: null })], ['no transport', { ...entry(), transport: null }], ['not JSON', 'Error: no such server'],
  ]) assert.strictEqual(docs(answer), null, why);
  assert.strictEqual(docs(entry(), 1), null, 'Codex failing leaves the docs off');
});

test('the docs server\'s env settings reach only its own server setting, never the Codex launcher or a later run', async () => {
  // (NODE_OPTIONS naming a module that doesn't exist: had it reached the launcher's own node, the run would fail to start)
  const docs = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\docs\\server.mjs'], tools: ['mql5_find', 'mql5_read'],
    env: { DOCS_ROOT: 'C:\\MQL5 "docs"', NODE_OPTIONS: `--require=${path.join(HOME, 'no-such-module.js')}` } };
  const before = { ...process.env };
  const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };
  setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}' }, { text: '{"verdict":"NO_ISSUES"}' }] });
  for (const request of [{ docs }, {}]) {
    const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'look', cwd: WORK, schema, ...request });
    assert.ok(r.ok, r.reason);
  }
  assert.deepStrictEqual({ ...process.env }, before);
  const [withDocs, without] = execCalls();
  const k = 'mcp_servers.mql5-docs';
  const pairs = withDocs.args.filter(a => a.startsWith(`${k}.`));
  assert.deepStrictEqual(pairs, [`${k}.command=${JSON.stringify(docs.command)}`, `${k}.args=[${JSON.stringify(docs.args[0])}]`,
    `${k}.env.DOCS_ROOT=${JSON.stringify(docs.env.DOCS_ROOT)}`, `${k}.env.NODE_OPTIONS=${JSON.stringify(docs.env.NODE_OPTIONS)}`, `${k}.required=false`,
    `${k}.enabled_tools=["mql5_find","mql5_read"]`, `${k}.tools.mql5_find.approval_mode="approve"`, `${k}.tools.mql5_read.approval_mode="approve"`]);
  const withoutDocs = placeholders(withDocs.args).filter((a, i, all) => !a.startsWith(`${k}.`) && !(a === '-c' && all[i + 1].startsWith(`${k}.`)));
  assert.deepStrictEqual(withoutDocs, placeholders(without.args), 'apart from the docs server, the run is isolated as one without it');
  assert.ok(!without.args.some(a => a.startsWith('mcp_servers.')), 'the next run has no docs server');
});

test('fast limit keeps the selected tier and the shared cooldown', async () => {
  setFast(true);
  setSpec({ exec: [{ fail: 'error: something broke', code: 1 }, { fail: "You've hit your usage limit. Try again at 9:15 PM.", code: 1 }, { text: 'fine' }] });
  const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: WORK });
  assert.deepStrictEqual([r.ok, r.limit], [false, true]);
  assert.deepStrictEqual(execCalls().map(tiersOf), [['service_tier="priority"'], ['service_tier="priority"']], 'the retry kept Fast');
  const g = state.read(state.files.global()).data;
  assert.ok(g.cooldownUntil > Date.now() && g.fast === true, 'the cooldown starts, and Fast stays on');
  const otherDriver = () => JSON.parse(spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(CODEX)}).ask({ mode: 'review', effort: 'high', prompt: 'y', cwd: ${JSON.stringify(WORK)} }).then(r => console.log(JSON.stringify(r)))`],
  { env: process.env, encoding: 'utf8' }).stdout);
  assert.strictEqual(otherDriver().unavailable, true);
  assert.strictEqual(execCalls().length, 2, 'another driver starts nothing during the cooldown');
  state.update(state.files.global(), x => { x.cooldownUntil = Date.now() - 1; });
  assert.strictEqual(otherDriver().ok, true);
  assert.deepStrictEqual(tiersOf(execCalls()[2]), ['service_tier="priority"'], 'after the cooldown, still Fast');
  fs.rmSync(state.files.global());
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
