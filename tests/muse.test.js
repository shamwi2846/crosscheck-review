// Tests for muse.js (test plan of the Muse task, cases T1 and T2; of the shell task, T1, T2 and T4): a Muse session
// that would hold a tool, personal context, a foreign skill or a shell outside its sandbox is refused before any model
// call, and a real run's answer whose session holds one is discarded with the verification taken away; the copy Muse's
// commands run in can't reach the project's storage and is removed; every call is logged; a Muse run looping on blank
// output is stopped with its child, and not retried. They run muse.js against the recording stub fake-muse.js.
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
// (written out, not taken from muse.js, so dropping one there fails here: the network restricted, no writes but the
// shell's, no web, no reminders, no personal context; contributor mode on, the user's choice of 2026-10-30; exactly the
// shell's tools, plus whatever servers the run attaches; and never a way out of the sandbox)
const ISOLATION = ['--approval-mode', 'never', '--sandbox-network', 'restricted', '--disable-write', '--disable-web-tools', '--disable-reminders',
  '--disable-request-user-input', '--no-foreign-personal-context', '--contributor-mode', 'on'];
const SHELL = ['powershell', 'powershell_input', 'read_file', 'search'];
const BYPASS = ['--yolo', '--disable-sandbox', '--disable-approval', '--trust-workspace', '--preset', '--disable-shell'];
const toolsetOf = args => JSON.parse(args.filter((a, i) => args[i - 1] === '-c' && a.startsWith('run.toolset='))[0].slice('run.toolset='.length));
const isolated = args => ISOLATION.every((flag, i) => args[args.indexOf('--approval-mode') + i] === flag)
  && !args.some(a => BYPASS.includes(a)) && SHELL.every((t, i) => toolsetOf(args)[i] === t);

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
    assert.ok(isolated(args), 'the shell\'s tools alone, and every sandbox flag, in order');
    const workspace = args[args.indexOf('--workspace') + 1];
    assert.ok(workspace.startsWith(home), 'a workspace in the attempt\'s folder');
    assert.deepStrictEqual(fs.readdirSync(workspace), ['.crosscheck-tmp'], 'empty but for its temp folder');
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
  // (a failed run that left no record is unsafe too, since even a refused run leaves one and its commands can't be
  // seen: the verification goes, before any retry, and a usage limit still says so and starts the cooldown)
  for (const fail of ['usage limit reached', 'connection reset']) {
    config();
    setSpec({ exec: [{ fail, noRecord: true }, clean] });
    const r = await muse.ask({ prompt: 'review this', home: bundle(`failed-no-record-${fail.length}`) });
    assert.ok(!r.ok && r.reason.includes(fail) && /no readable session record/.test(r.reason) && /no longer verified/.test(r.reason), r.reason);
    assert.deepStrictEqual(execs().map(provider), ['echo', 'meta'], `${fail}: no retry after it`);
    assert.strictEqual(JSON.parse(fs.readFileSync(state.files.config(), 'utf8')).museVerified, undefined);
    assert.strictEqual(state.read(state.files.global()).data.museCooldownUntil > Date.now(), fail === 'usage limit reached', `${fail}: the cooldown`);
    assert.ok(state.update(state.files.global(), g => { delete g.museCooldownUntil; }).ok);
  }
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
  assert.ok(!r.ok && /failed run \(Muse looped on blank output\) held tools read_memory/.test(r.reason) && /no longer verified/.test(r.reason), r.reason);
  assert.deepStrictEqual(execs().map(provider), ['echo', 'meta'], 'no retry');
  assert.ok(unverified());
  await refusedAfter('loop-tool');
});

test('a resumed run whose last retry fails with a foreign skill takes the verification away', async () => {
  config();
  setSpec({ exec: [{ fail: 'connection reset' }, { fail: 'connection reset', record: { skills: ['bundled:git', 'user:mine'] } }] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('retry-skill'), resume: RESUMED });
  assert.ok(!r.ok && /failed run \(connection reset\) held skills user:mine/.test(r.reason) && /no longer verified/.test(r.reason), r.reason);
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
  // (the file tool alone; with the docs)
  for (const [name, docs] of [['files', null], ['docs', { command: process.execPath, args: ['docs.js'], env: {} }]]) {
    config();
    setSpec({ exec: [clean] });
    const r = await muse.ask({ prompt: 'review this', home: bundle(`granted-${name}`), tools: given(docs) });
    assert.ok(r.ok, `${name}: ${r.reason}`);
    assert.deepStrictEqual(toolsetOf(execs()[1]), [...SHELL, ...FILE_TOOLS, ...(docs ? DOCS_TOOLS : [])], `${name}: exactly its tools, named`);
  }
  // (docs that can't start: Muse refuses a toolset naming their tools, so it doesn't take part, and nothing unsafe is known)
  config();
  setSpec({ exec: [clean] });
  const noDocs = await muse.ask({ prompt: 'review this', home: bundle('granted-no-docs'), tools: given({ command: path.join(HOME, 'no-such-docs.exe'), args: [], env: {} }) });
  assert.ok(!noDocs.ok && /Muse can't start: .*unknown tool names/.test(noDocs.reason) && !unverified(), noDocs.reason);
  assert.deepStrictEqual(execs().map(provider), ['echo'], 'no model run');
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
  const docsEnvOf = c => Object.fromEntries(Object.entries(c.env).filter(([k]) => /^(CROSSCHECK_MQL5_DOCS_|NODE_OPTIONS$)/.test(k)));
  for (const c of runs) {
    assert.deepStrictEqual(docsEnvOf(c), { CROSSCHECK_MQL5_DOCS_NODE_OPTIONS: docs.env.NODE_OPTIONS, CROSSCHECK_MQL5_DOCS_MQL5_DOCS_DATA: docs.env.MQL5_DOCS_DATA }, 'NODE_OPTIONS never set for Muse itself');
    const settings = c.args.filter((a, i) => c.args[i - 1] === '-c');
    assert.deepStrictEqual(settings.map(s => s.split('=')[0]), ['run.toolset', 'mcpServers.project-files', 'mcpServers.mql5-docs']);
    assert.deepStrictEqual(JSON.parse(settings[2].replace(/^mcpServers\.mql5-docs=/, '')), { command: docs.command, args: docs.args,
      env: { NODE_OPTIONS: '${CROSSCHECK_MQL5_DOCS_NODE_OPTIONS}', MQL5_DOCS_DATA: '${CROSSCHECK_MQL5_DOCS_MQL5_DOCS_DATA}' } });
  }
  assert.strictEqual(JSON.stringify(process.env), before, 'crosscheck\'s own environment is unchanged');
  config();
  setSpec({ exec: [clean] });
  assert.ok((await muse.ask({ prompt: 'review this', home: bundle('no-docs-env'), tools: given(null) })).ok);
  assert.ok(execLog().every(c => Object.keys(docsEnvOf(c)).length === 0 && !c.args.some(a => a.startsWith('mcpServers.mql5-docs'))), 'a run without docs gets none');
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

test('sandbox_attestation_is_required_before_and_after_every_run (shell task T1): a shell without its sandbox record, outside the sandbox or with network is refused at the pre-check, after a resumed run and after a failed run, before any retry', async () => {
  const bad = [['no sandbox record', { permission: false }], ['the shell sandbox off', { sandbox: 'off' }], ['a shell outside its sandbox', { filesystem: 'unrestricted' }],
    ['a shell with network', { network: 'proxy_only' }], ['a shell with network', { network: 'enabled' }]];
  for (const [why, record] of bad) {
    for (const c of [{ name: 'precheck', spec: { echo: { record }, exec: [clean] }, runs: ['echo'] },
      { name: 'resumed', spec: { exec: [{ ...clean, record }] }, runs: ['meta'], resume: RESUMED },
      { name: 'failed', spec: { exec: [{ fail: 'connection reset', record }, clean] }, runs: ['echo', 'meta'] }]) {
      config();
      setSpec(c.spec);
      const r = await muse.ask({ prompt: 'review this', home: bundle(`sandbox-${c.name}`), tools: given(null), resume: c.resume || null });
      assert.ok(!r.ok && !r.text && r.reason.includes(why) && /no longer verified/.test(r.reason), `${why} ${c.name}: ${r.reason}`);
      assert.deepStrictEqual(execs().map(provider), c.runs, `${why} ${c.name}: no model run or retry after it`);
      assert.ok(unverified(), `${why} ${c.name}`);
    }
  }
  // (only the attested run passes, and every launch asks for the restricted network, never for a way out of the sandbox)
  config();
  setSpec({ exec: [clean] });
  assert.ok((await muse.ask({ prompt: 'review this', home: bundle('sandbox-clean'), tools: given(null) })).ok);
  assert.ok(execs().length === 2 && execs().every(isolated));
});

const { spawnSync } = require('child_process');
const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const filesIn = dir => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, f)).filter(f => fs.lstatSync(f).isFile());

test('job_copy_and_temp_cannot_modify_source_storage_and_are_cleaned (shell task T2): the copy has git storage of its own at the project\'s HEAD, Muse\'s temp is inside it, and it goes when the job ends, never what a link in it points to', async () => {
  const review = require('../src/review');
  // (a project whose objects are partly borrowed from another repository, checked out in a linked worktree on a branch)
  const lender = bundle('lender');
  gitIn(lender, 'init', '-q');
  fs.writeFileSync(path.join(lender, 'a.js'), 'A1\n');
  gitIn(lender, 'add', '-A');
  gitIn(lender, 'commit', '-qm', 'a');
  const source = path.join(HOME, 'source');
  gitIn(HOME, 'clone', '-q', '--shared', lender, source);
  const tree = path.join(HOME, 'source-tree');
  gitIn(source, 'worktree', 'add', '-q', '-b', 'feature', tree);
  fs.writeFileSync(path.join(tree, 'a.js'), 'A2 feature\n');
  gitIn(tree, 'commit', '-qam', 'feature');
  const head = gitIn(tree, 'rev-parse', 'HEAD');
  const outside = bundle('copy-outside');
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'keep');
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-sibling-'));
  const tempBefore = process.env.TEMP;
  let job;
  config();
  setSpec({ exec: [clean] });
  await review.withCopy(tree, {}, async copy => {
    const { dir } = copy;
    job = path.dirname(dir);
    const spoilObjects = () => {
      for (const f of filesIn(path.join(dir, '.git', 'objects'))) {
        fs.chmodSync(f, 0o666);
        fs.writeFileSync(f, 'garbage');
      }
    };
    // (from a project that borrows nothing, the copy's objects are files of its own too: overwritten in place, the
    // project's stay whole; then a copy made again, from the worktree)
    assert.strictEqual(review.museCopy(lender, {}, dir), null);
    spoilObjects();
    gitIn(lender, 'fsck', '--no-progress');
    assert.strictEqual(copy.remake(), null);
    assert.strictEqual(gitIn(dir, 'rev-parse', 'HEAD'), head, 'the worktree\'s HEAD');
    assert.strictEqual(gitIn(dir, 'remote'), '', 'no remote back to the project');
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'objects', 'info', 'alternates')), 'no borrowed objects');
    // (Muse works there, its temp a folder inside it, git told the copy is safe, crosscheck's own environment untouched)
    assert.ok((await muse.ask({ prompt: 'review this', home: bundle('copy-run'), tools: { ...given(null), copy } })).ok);
    const [, real] = execLog();
    assert.strictEqual(real.args[real.args.indexOf('--workspace') + 1], dir);
    assert.deepStrictEqual([real.env.TEMP, real.env.TMP, real.env.GIT_CONFIG_KEY_0, real.env.GIT_CONFIG_VALUE_0],
      [path.join(dir, '.crosscheck-tmp'), path.join(dir, '.crosscheck-tmp'), 'safe.directory', dir.split(path.sep).join('/')]);
    assert.strictEqual(process.env.TEMP, tempBefore);
    // (what Muse's commands could do there: change a file, overwrite every object of the copy's git storage in place,
    // leave a temp file, and link to a folder outside)
    fs.writeFileSync(path.join(dir, 'a.js'), 'changed in the copy\n');
    spoilObjects();
    fs.writeFileSync(path.join(dir, '.crosscheck-tmp', 'left.txt'), 'temp');
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction');
  });
  assert.ok(!fs.existsSync(job), 'the job\'s folder is gone');
  assert.ok(fs.existsSync(path.join(outside, 'sentinel.txt')) && fs.existsSync(sibling), 'never what a link points to, or a folder beside it');
  assert.strictEqual(fs.readFileSync(path.join(tree, 'a.js'), 'utf8'), 'A2 feature\n');
  for (const repo of [source, lender, tree]) gitIn(repo, 'fsck', '--no-progress');
  // (a job that fails leaves nothing either)
  await assert.rejects(review.withCopy(tree, {}, async copy => {
    job = path.dirname(copy.dir);
    assert.strictEqual(copy.remake(), null);
    throw new Error('the job failed');
  }), /the job failed/);
  assert.ok(!fs.existsSync(job));
  fs.rmSync(sibling, { recursive: true, force: true });
});

test('the copy is made without the user\'s git hooks, filters or template, from files or the environment, and a temp folder that isn\'t a folder of its own keeps Muse from starting (the shell plan\'s review)', async () => {
  const review = require('../src/review');
  const source = bundle('hooked');
  gitIn(source, 'init', '-q');
  fs.writeFileSync(path.join(source, '.gitattributes'), '*.js filter=evil\n');
  fs.writeFileSync(path.join(source, 'a.js'), 'A\n');
  fs.writeFileSync(path.join(source, '.crosscheck-tmp'), 'the project\'s own file of that name\n');
  gitIn(source, 'add', '-A');
  gitIn(source, 'commit', '-qm', 'a');
  // (the user's own git configuration, in their home folder and in GIT_* variables, and a template: a checkout hook and
  // a filter, each leaving a mark if it runs)
  const mark = path.join(HOME, 'hook-ran').split(path.sep).join('/');
  const hooks = bundle('evil-hooks');
  fs.writeFileSync(path.join(hooks, 'post-checkout'), `#!/bin/sh\necho hook > "${mark}"\n`);
  fs.mkdirSync(path.join(HOME, 'evil-template', 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(hooks, 'post-checkout'), path.join(HOME, 'evil-template', 'hooks', 'post-checkout'));
  const userHome = bundle('evil-home');
  fs.writeFileSync(path.join(userHome, '.gitconfig'), `[core]\n\thooksPath = ${hooks.split(path.sep).join('/')}\n[filter "evil"]\n\tsmudge = sh -c 'echo filter > \\"${mark}\\"; cat'\n`);
  const names = ['HOME', 'USERPROFILE', 'GIT_TEMPLATE_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const saved = Object.fromEntries(names.map(k => [k, process.env[k]]));
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  for (const evil of [{ HOME: userHome, USERPROFILE: userHome, GIT_TEMPLATE_DIR: path.join(HOME, 'evil-template') },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks.split(path.sep).join('/') }]) {
    Object.assign(process.env, evil);
    try {
      await review.withCopy(source, {}, async copy => {
        assert.strictEqual(copy.remake(), null);
        assert.strictEqual(fs.readFileSync(path.join(copy.dir, 'a.js'), 'utf8'), 'A\n');
        assert.ok(!fs.existsSync(mark), `no hook or filter of the user's ran (${Object.keys(evil)})`);
      });
    } finally {
      restore();
    }
  }
  // (the project's own .crosscheck-tmp, which isn't a folder Muse's temp may be: the run doesn't start)
  await review.withCopy(source, {}, async copy => {
    config();
    setSpec({ exec: [clean] });
    const r = await muse.ask({ prompt: 'review this', home: bundle('temp-link'), tools: { ...given(null), copy }, resume: RESUMED });
    assert.ok(!r.ok && /temp folder .* is a link or not a folder/.test(r.reason), r.reason);
    assert.deepStrictEqual(execs(), [], 'Muse never started');
  });
});

test('doctor\'s probe names its target as a PowerShell literal, so a temp folder with an apostrophe still proves the sandbox', async () => {
  const temp = path.join(HOME, 'O\'Brien temp');
  fs.mkdirSync(temp, { recursive: true });
  const before = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TEMP: temp, TMP: temp });
  try {
    config();
    setSpec({ exec: [{ attempt: 'denied', text: 'Access was denied.' }] });
    const r = await muse.probe();
    assert.ok(r.ok, r.info);
    const prompt = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(c => c.args && c.args[0] === 'exec').prompt;
    assert.match(prompt, /-LiteralPath '.*O''Brien temp.*probe\.txt' -Value probe/);
  } finally {
    Object.assign(process.env, before);
  }
});

test('every Muse run, a retry too, starts in a copy made afresh, and one that can\'t be made starts no run', async () => {
  let made = 0;
  config();
  setSpec({ exec: [{ fail: 'connection reset' }, clean] });
  const dir = bundle('remade');
  assert.ok((await muse.ask({ prompt: 'review this', home: bundle('remade-home'), tools: { ...given(null), copy: { dir, remake: () => { made++; return null; } } } })).ok);
  assert.deepStrictEqual([made, execs().map(provider)], [2, ['echo', 'meta', 'meta']], 'remade before the run and before its retry');
  config();
  setSpec({ exec: [clean] });
  const r = await muse.ask({ prompt: 'review this', home: bundle('unmade-home'), tools: { ...given(null), copy: { dir, remake: () => 'git clone failed' } } });
  assert.ok(!r.ok && /copy of the project couldn't be made: git clone failed/.test(r.reason) && !unverified(), r.reason);
  assert.deepStrictEqual(execs().map(provider), ['echo'], 'no model run');
});

test('tool_audit_survives_failures_and_missing_evidence_revokes_verification (shell task T4): every call and result is kept in the bundle, a failed run\'s and each resumed run\'s too; a call the record doesn\'t show, or a log that can\'t be written, discards the answer', async () => {
  const toolCalls = [{ name: 'powershell', args: { command: 'npm test' } }, { name: 'powershell_input', args: { input: 'q' } }, { name: 'read_file', args: { path: 'src/a.js' } },
    { name: 'search', args: { text: 'refund' } }, { name: 'mcp__project_files__read_file', args: { path: 'src/a.js' } }];
  const results = [{ command: 'npm test', exit_code: 7, output: 'línea 1\n失败 2\r\n' }, 'refund twice\n'];
  const logged = (calls, outs) => [...calls.map(c => ({ tool: c.name, args: JSON.stringify(c.args) })), ...outs.map(o => ({ result: typeof o === 'string' ? o : JSON.stringify(o) }))];
  const logsIn = home => fs.readdirSync(home).filter(f => f.startsWith('muse-calls-')).sort()
    .map(f => fs.readFileSync(path.join(home, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const second = [{ name: 'search', args: { text: 'twice' } }];
  // (a run that fails after its calls, then a clean retry in a fresh session: both runs' calls are kept)
  config();
  setSpec({ exec: [{ fail: 'connection reset', record: { toolCalls, results } }, { ...clean, record: { toolCalls: second } }] });
  const home = bundle('audit-failed');
  assert.ok((await muse.ask({ prompt: 'review this', home, tools: given(null) })).ok);
  const sessions = execs().filter(a => provider(a) === 'meta').map(a => a[a.indexOf('--session-id') + 1]);
  assert.deepStrictEqual(sessions.map(s => fs.readdirSync(home).filter(f => f.startsWith(`muse-calls-${s}-`))), [[`muse-calls-${sessions[0]}-1.jsonl`], [`muse-calls-${sessions[1]}-1.jsonl`]]);
  assert.deepStrictEqual(JSON.parse(`[${fs.readFileSync(path.join(home, `muse-calls-${sessions[0]}-1.jsonl`), 'utf8').trim().split('\n').join(',')}]`), logged(toolCalls, results));
  // (a resumed session: each run's record is kept beside the earlier one, which stays as it was)
  const resumedHome = bundle('audit-resumed');
  for (const record of [{ toolCalls, results }, { toolCalls: second }]) {
    config();
    setSpec({ exec: [{ ...clean, record }] });
    assert.ok((await muse.ask({ prompt: 'review this', home: resumedHome, tools: given(null), resume: RESUMED })).ok);
  }
  assert.deepStrictEqual(logsIn(resumedHome), [logged(toolCalls, results), logged(second, [])]);
  // (a call that started but isn't in the record, or is there without its arguments: the answer is discarded and the
  // verification goes, before any retry)
  for (const c of [{ name: 'run', exec: [{ ...clean, record: { toolCalls, results, unlogged: ['call_hidden'] } }] },
    { name: 'failed', exec: [{ fail: 'connection reset', record: { toolCalls, unlogged: ['call_hidden'] } }, clean] },
    { name: 'no-args', exec: [{ ...clean, record: { toolCalls: [{ name: 'powershell', args: null }] } }] }]) {
    config();
    setSpec({ exec: c.exec });
    const r = await muse.ask({ prompt: 'review this', home: bundle(`audit-hidden-${c.name}`), tools: given(null) });
    assert.ok(!r.ok && !r.text && /1 tool call\(s\) its record doesn't show/.test(r.reason) && /no longer verified/.test(r.reason), `${c.name}: ${r.reason}`);
    assert.deepStrictEqual(execs().map(provider), ['echo', 'meta'], `${c.name}: no retry`);
    assert.ok(unverified());
  }
  // (a log that can't be written: the answer is discarded, and a failed run isn't retried)
  const workspace = bundle('audit-workspace');
  for (const c of [{ name: 'run', exec: [{ ...clean, record: { toolCalls } }] }, { name: 'failed', exec: [{ fail: 'connection reset', record: { toolCalls } }, clean] }]) {
    config();
    setSpec({ exec: c.exec });
    const r = await muse.ask({ prompt: 'review this', home: path.join(HOME, 'no-such-bundle'), tools: { ...given(null), copy: { dir: workspace, remake: () => null } }, resume: RESUMED });
    assert.ok(!r.ok && !r.text && /calls couldn't be logged/.test(r.reason), `${c.name}: ${r.reason}`);
    assert.deepStrictEqual(execs().map(provider), ['meta'], `${c.name}: no retry`);
  }
});
