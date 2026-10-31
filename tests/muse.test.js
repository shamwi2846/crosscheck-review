// Tests for muse.js (test plan of the Muse task, cases T1 and T2): a Muse session that would hold a tool, personal
// context or a foreign skill is refused before any model call, and a real run's answer whose session holds one is
// discarded with the verification taken away; a Muse run looping on blank output is stopped with its child, and not
// retried. They run muse.js against the recording stub fake-muse.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck muse test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_MUSE_SPEC: SPEC, FAKE_MUSE_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
const state = require('../src/state');
const muse = require('../src/muse');

const VERIFIED = { museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')], museVerified: '9.9.9-test', museSkills: ['bundled:git'] };
const config = (over = {}) => fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test', ...VERIFIED, ...over }));
const setSpec = spec => { fs.writeFileSync(SPEC, JSON.stringify(spec)); fs.rmSync(LOG, { force: true }); fs.rmSync(`${LOG}.sessions`, { recursive: true, force: true }); };
const execs = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.args && c.args[0] === 'exec').map(c => c.args);
const provider = args => args[args.indexOf('--provider') + 1];
const bundle = name => { const dir = path.join(HOME, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
// (written out, not taken from muse.js, so dropping one there fails here: no tools of its own, no writes or shell, no
// web, no reminders, no personal context; contributor mode on, the user's choice of 2026-10-30)
const ISOLATION = ['--preset', 'empty', '--approval-mode', 'never', '--disable-write', '--disable-shell', '--disable-web-tools', '--disable-reminders',
  '--disable-request-user-input', '--no-foreign-personal-context', '--contributor-mode', 'on'];
const isolated = args => ISOLATION.every((flag, i) => args[args.indexOf('--preset') + i] === flag);

test('a session that would hold a tool, personal context or a foreign skill is refused before any model call, and takes the verification away', async () => {
  for (const record of [{ tools: ['write_file'] }, { context: ['personal_rules'] }, { skills: ['bundled:git', 'user:mine'] }]) {
    config();
    setSpec({ echo: { record }, exec: [{ text: '{"verdict":"NO_ISSUES"}' }] });
    const home = bundle(`refused-${Object.keys(record)[0]}`);
    const r = await muse.ask({ prompt: 'review this', home });
    assert.ok(!r.ok && /would hold/.test(r.reason) && /no longer verified/.test(r.reason), `${JSON.stringify(record)}: ${r.reason}`);
    const now = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
    assert.deepStrictEqual([now.museVerified, now.museSkills], [undefined, undefined], 'no longer verified');
    const runs = execs();
    assert.deepStrictEqual(runs.map(provider), ['echo'], 'only the echo run, which makes no model call');
    const args = runs[0];
    assert.ok(isolated(args), 'no tools, and every read-only flag, in order');
    const workspace = args[args.indexOf('--workspace') + 1];
    assert.ok(workspace.startsWith(home) && fs.readdirSync(workspace).length === 0, 'an empty workspace in the attempt\'s folder');
  }
  // (a clean pre-check lets the real run go, but a real session whose record holds a tool loses its answer and the verification)
  config();
  setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}', record: { tools: ['read_memory'] } }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('discarded') });
  assert.ok(!r.ok && /held tools read_memory/.test(r.reason) && !r.text, r.reason);
  assert.deepStrictEqual(execs().map(provider), ['echo', 'meta']);
  assert.ok(execs().every(isolated), 'the pre-check and the model run alike');
  const now = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
  assert.deepStrictEqual([now.museVerified, now.museSkills], [undefined, undefined], 'no longer verified');
  setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}' }] });
  assert.match((await muse.ask({ prompt: 'review this', home: bundle('unverified') })).reason, /isn't verified: run doctor --live/);
  assert.deepStrictEqual(execs(), [], 'an unverified Muse never runs');
});

test('a failed run whose record holds a tool, personal context or a foreign skill takes the verification away before any retry', async () => {
  const clean = { text: '{"verdict":"NO_ISSUES"}' };
  const cases = [
    { name: 'retryable', record: { tools: ['read_memory'] }, fail: 'connection reset', held: /held tools read_memory/, runs: ['echo', 'meta'] },
    { name: 'limit', record: { context: ['personal_rules'] }, fail: 'usage limit reached', held: /held context personal_rules/, runs: ['echo', 'meta'] },
    { name: 'resumed', record: { skills: ['bundled:git', 'user:mine'] }, fail: 'connection reset', held: /held skills user:mine/, runs: ['meta'], resume: '0123abcd-0000-4000-8000-0000000f11e5' },
  ];
  for (const c of cases) {
    config();
    setSpec({ exec: [{ fail: c.fail, record: c.record }, clean] }); // (a clean retry could hide the first run)
    const r = await muse.ask({ prompt: 'review this', home: bundle(`failed-${c.name}`), resume: c.resume || null });
    assert.ok(!r.ok && c.held.test(r.reason) && /no longer verified/.test(r.reason), `${c.name}: ${r.reason}`);
    assert.deepStrictEqual(execs().map(provider), c.runs, `${c.name}: no retry after it`);
    const now = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
    assert.deepStrictEqual([now.museVerified, now.museSkills], [undefined, undefined], `${c.name}: no longer verified`);
    // (a usage limit still says so and starts the cooldown, so doctor --live can't make a model call meanwhile)
    const cooling = state.read(state.files.global()).data.museCooldownUntil > Date.now();
    assert.deepStrictEqual([cooling, /usage limit reached/.test(r.reason)], [c.name === 'limit', c.name === 'limit'], `${c.name}: the cooldown`);
    setSpec({ exec: [clean] });
    assert.match((await muse.ask({ prompt: 'review this', home: bundle(`after-${c.name}`) })).reason, cooling ? /cooling down/ : /isn't verified/);
    assert.deepStrictEqual(execs(), [], `${c.name}: nothing runs until doctor --live passes again`);
    assert.ok(state.update(state.files.global(), g => { delete g.museCooldownUntil; }).ok);
  }
  // (a failed run that left no record keeps its own reason, and Muse stays verified)
  config();
  setSpec({ exec: [{ fail: 'usage limit reached', noRecord: true }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('failed-no-record') });
  assert.ok(!r.ok && /usage limit reached/.test(r.reason), r.reason);
  assert.strictEqual(JSON.parse(fs.readFileSync(state.files.config(), 'utf8')).museVerified, '9.9.9-test');
  assert.ok(state.update(state.files.global(), g => { delete g.museCooldownUntil; }).ok);
});

test('a run looping on blank output is stopped with its child, and not retried', { timeout: 60000 }, async () => {
  config();
  const child = path.join(HOME, 'child.pid');
  setSpec({ exec: [{ blank: true, child }, { text: '{"verdict":"NO_ISSUES"}' }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('loop') });
  assert.deepStrictEqual([r.ok, r.reason], [false, 'Muse looped on blank output']);
  assert.deepStrictEqual(execs().map(provider), ['echo', 'meta'], 'one real run: a loop is not retried');
  const pid = Number(fs.readFileSync(child, 'utf8'));
  for (let i = 0; i < 100 && state.mayRun(pid); i++) await new Promise(res => setTimeout(res, 50));
  assert.ok(!state.mayRun(pid), 'the looping run\'s child was stopped with it');
});

// (after a run took the verification away: the next ask is refused and runs nothing)
async function refusedAfter(name) {
  setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}' }] });
  assert.match((await muse.ask({ prompt: 'review this', home: bundle(`after-${name}`) })).reason, /isn't verified/);
  assert.deepStrictEqual(execs(), [], `${name}: nothing runs until doctor --live passes again`);
}
const unverified = () => { const c = JSON.parse(fs.readFileSync(state.files.config(), 'utf8')); return c.museVerified === undefined && c.museSkills === undefined; };
const RESUMED = '0123abcd-0000-4000-8000-0000000f11e5';

test('a resumed run that answers with no readable session record counts nothing and takes the verification away', async () => {
  config();
  setSpec({ exec: [{ text: '{"verdict":"NO_ISSUES"}', noRecord: true }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('no-record'), resume: RESUMED });
  assert.ok(!r.ok && !r.text && /no readable session record/.test(r.reason) && /no longer verified/.test(r.reason), r.reason);
  assert.deepStrictEqual(execs().map(provider), ['meta']);
  assert.ok(unverified());
  await refusedAfter('no-record');
});

test('a looped run whose record holds a tool takes the verification away', { timeout: 60000 }, async () => {
  config();
  setSpec({ exec: [{ blank: true, record: { tools: ['read_memory'] } }, { text: '{"verdict":"NO_ISSUES"}' }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('loop-tool') });
  assert.ok(!r.ok && /failed run held tools read_memory/.test(r.reason) && /no longer verified/.test(r.reason), r.reason);
  assert.deepStrictEqual(execs().map(provider), ['echo', 'meta'], 'no retry');
  assert.ok(unverified());
  await refusedAfter('loop-tool');
});

test('a resumed run whose last retry fails with a foreign skill takes the verification away', async () => {
  config();
  setSpec({ exec: [{ fail: 'connection reset' }, { fail: 'connection reset', record: { skills: ['bundled:git', 'user:mine'] } }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('retry-skill'), resume: RESUMED });
  assert.ok(!r.ok && /failed run held skills user:mine/.test(r.reason) && /no longer verified/.test(r.reason), r.reason);
  const runs = execs();
  assert.deepStrictEqual([runs.map(provider), runs.map(a => a[a.indexOf('--session-id') + 1])], [['meta', 'meta'], [RESUMED, RESUMED]], 'retried once, in the same session');
  assert.ok(unverified());
  await refusedAfter('retry-skill');
});

// (the tools a review gives Muse: crosscheck's file tool, and the docs when `docs` is a server)
const given = docs => ({ files: path.join(HOME, 'manifest.json'), docs });
const FILE_TOOLS = ['list_files', 'read_file', 'search'].map(t => `mcp__project_files__${t}`);
const DOCS_TOOLS = ['mql5_find', 'mql5_read'].map(t => `mcp__mql5_docs__${t}`);
const clean = { text: '{"verdict":"NO_ISSUES"}' };
const execLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.args && c.args[0] === 'exec');

test('the session check admits exactly the tools a run was given, never by a server prefix or a short name', async () => {
  // (the file tool alone; with the docs; with docs that can't start, which are optional)
  for (const [name, docs] of [['files', null], ['docs', { command: process.execPath, args: ['docs.js'], env: {} }], ['no-docs', { command: path.join(HOME, 'no-such-docs.exe'), args: [], env: {} }]]) {
    config();
    setSpec({ exec: [clean] });
    const r = await muse.ask({ prompt: 'review this', home: bundle(`granted-${name}`), tools: given(docs) });
    assert.ok(r.ok, `${name}: ${r.reason}`);
  }
  // (another tool of an allowed server, another server's tool with an allowed short name, the docs not given: refused at
  // the pre-check, after a fresh or a resumed run, and after a failed run before any retry)
  for (const extra of ['mcp__project_files__write_file', 'mcp__other__read_file', DOCS_TOOLS[0]]) {
    const bad = { tools: [...FILE_TOOLS, extra] };
    for (const c of [{ name: 'precheck', spec: { echo: { record: bad }, exec: [clean] }, runs: ['echo'] },
      { name: 'run', spec: { exec: [{ ...clean, record: bad }] }, runs: ['echo', 'meta'] },
      { name: 'resumed', spec: { exec: [{ ...clean, record: bad }] }, runs: ['meta'], resume: RESUMED },
      { name: 'failed', spec: { exec: [{ fail: 'connection reset', record: bad }, clean] }, runs: ['echo', 'meta'] }]) {
      config();
      setSpec(c.spec);
      const r = await muse.ask({ prompt: 'review this', home: bundle(`extra-${c.name}`), tools: given(null), resume: c.resume || null });
      assert.ok(!r.ok && r.reason.includes(extra) && /no longer verified/.test(r.reason), `${extra} ${c.name}: ${r.reason}`);
      assert.deepStrictEqual(execs().map(provider), c.runs, `${extra} ${c.name}: no model run after it`);
      assert.ok(unverified(), `${extra} ${c.name}`);
    }
  }
  // (a run without its file tools isn't unsafe, but its answer can't count)
  config();
  setSpec({ exec: [{ ...clean, record: { tools: [] } }] });
  const lacking = await muse.ask({ prompt: 'review this', home: bundle('lacking'), tools: given(null) });
  assert.ok(!lacking.ok && /lacked its tools/.test(lacking.reason) && !unverified(), lacking.reason);
});

test('docs settings reach Muse only as crosscheck-named variables of its own process, and its docs server gets them as configured', async t => {
  // (a NODE_OPTIONS the test runner inherited, as a debugging terminal sets one, would reach Muse like any variable:
  // it is set aside, so the test sees only what crosscheck sets)
  const inherited = process.env.NODE_OPTIONS;
  delete process.env.NODE_OPTIONS;
  t.after(() => { if (inherited !== undefined) process.env.NODE_OPTIONS = inherited; });
  const docs = { command: process.execPath, args: [path.join(HOME, 'docs "quoted" dir', 'server.js')],
    env: { NODE_OPTIONS: `--require=${path.join(HOME, 'missing-module.js')}`, MQL5_DOCS_DATA: 'C:\\docs data\\x' } };
  const before = JSON.stringify(process.env);
  config();
  setSpec({ exec: [clean] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('docs-env'), tools: given(docs) });
  assert.ok(r.ok, r.reason);
  const runs = execLog();
  assert.deepStrictEqual(runs.map(c => provider(c.args)), ['echo', 'meta']);
  for (const c of runs) {
    assert.deepStrictEqual(c.env, { CROSSCHECK_MQL5_DOCS_NODE_OPTIONS: docs.env.NODE_OPTIONS, CROSSCHECK_MQL5_DOCS_MQL5_DOCS_DATA: docs.env.MQL5_DOCS_DATA }, 'NODE_OPTIONS never set for Muse itself');
    const settings = c.args.filter((a, i) => c.args[i - 1] === '-c');
    assert.deepStrictEqual(settings.map(s => s.split('=')[0]), ['mcpServers.project-files', 'mcpServers.mql5-docs']);
    assert.deepStrictEqual(JSON.parse(settings[1].replace(/^mcpServers\.mql5-docs=/, '')), { command: docs.command, args: docs.args, mode: 'optional',
      env: { NODE_OPTIONS: '${CROSSCHECK_MQL5_DOCS_NODE_OPTIONS}', MQL5_DOCS_DATA: '${CROSSCHECK_MQL5_DOCS_MQL5_DOCS_DATA}' } });
  }
  assert.strictEqual(JSON.stringify(process.env), before, 'crosscheck\'s own environment is unchanged');
  config();
  setSpec({ exec: [clean] });
  assert.ok((await muse.ask({ prompt: 'review this', home: bundle('no-docs-env'), tools: given(null) })).ok);
  assert.ok(execLog().every(c => Object.keys(c.env).length === 0 && !c.args.some(a => a.startsWith('mcpServers.mql5-docs'))), 'a run without docs gets none');
  // (a docs server that starts gets its command, arguments and values as configured, and lists exactly the two lookups)
  const fixture = path.join(HOME, 'docs fixture.js');
  const seen = path.join(HOME, 'docs-seen.json');
  fs.writeFileSync(fixture, `const fs = require('fs');
fs.writeFileSync(process.env.DOCS_SEEN, JSON.stringify({ argv: process.argv.slice(2), data: process.env.MQL5_DOCS_DATA }));
require('readline').createInterface({ input: process.stdin }).on('line', l => { const m = JSON.parse(l);
  const result = m.method === 'tools/list' ? { tools: [{ name: 'mql5_find' }, { name: 'mql5_read' }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mql5-docs' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); });\n`);
  const real = { command: process.execPath, args: [fixture, 'one arg', 'C:\\with space\\two'], env: { MQL5_DOCS_DATA: 'C:\\docs data\\x', DOCS_SEEN: seen } };
  config();
  setSpec({ exec: [{ ...clean, startDocs: true }] });
  assert.ok((await muse.ask({ prompt: 'review this', home: bundle('docs-start'), tools: given(real) })).ok);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), { argv: ['one arg', 'C:\\with space\\two'], data: 'C:\\docs data\\x' });
  const listed = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(c => c.docsTools);
  assert.deepStrictEqual(listed.docsTools, ['mql5_find', 'mql5_read']);
});
