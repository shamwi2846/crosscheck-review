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
  const head = ['--json', '-m', 'gpt-test', '-c', 'model_reasoning_effort=high', '-c', 'windows.sandbox=unelevated', ...ISOLATION,
    '-c', 'web_search="disabled"', '--output-schema', '<schema>', '--skip-git-repo-check', '-o', '<answer>'];
  assert.deepStrictEqual(fresh, ['exec', '--ignore-user-config', ...head, '-s', 'read-only', '-C', '<cwd>', '-']);
  assert.deepStrictEqual(resumed, ['exec', 'resume', '--ignore-user-config', ...head, '-c', 'sandbox_mode="read-only"', SESSION, '-']);
  assert.strictEqual(fs.readFileSync(profile, 'utf8'), toml);
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

test('a retry waits out a cooldown another driver started meanwhile, and unreadable shared state stops every run', async () => {
  const global = state.files.global();
  setSpec({ exec: [{ fail: 'error: something broke', code: 1 }] });
  const anotherDriverHitALimit = () => state.update(global, g => { g.cooldownUntil = Date.now() + 60000; });
  const r = await codex.ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: WORK, onSpawn: anotherDriverHitALimit });
  assert.strictEqual(r.unavailable, true);
  assert.match(r.reason, /no retry: GPT is cooling down/);
  assert.strictEqual(execCalls().length, 1);
  fs.writeFileSync(global, '{"cooldownUntil": 17');
  for (const force of [false, true]) {
    const blocked = await codex.ask({ mode: 'review', effort: 'high', prompt: 'y', cwd: WORK, force });
    assert.strictEqual(blocked.unavailable, true);
    assert.match(blocked.reason, /can't be read/);
  }
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

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
