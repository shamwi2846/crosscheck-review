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
const execs = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(c => c.args && c.args[0] === 'exec').map(c => c.args);
const provider = args => args[args.indexOf('--provider') + 1];
const bundle = name => { const dir = path.join(HOME, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
// (written out, not taken from muse.js, so dropping one there fails here: no tools, no writes or shell, no web, no
// reminders, no personal context, no contributor mode)
const ISOLATION = ['--preset', 'empty', '--approval-mode', 'never', '--disable-write', '--disable-shell', '--disable-web-tools', '--disable-reminders',
  '--disable-request-user-input', '--no-foreign-personal-context', '--contributor-mode', 'off'];
const isolated = args => ISOLATION.every((flag, i) => args[args.indexOf('--preset') + i] === flag);

test('a session that would hold a tool, personal context or a foreign skill is refused before any model call', async () => {
  config();
  for (const record of [{ tools: ['write_file'] }, { context: ['personal_rules'] }, { skills: ['bundled:git', 'user:mine'] }]) {
    setSpec({ echo: { record }, exec: [{ text: '{"verdict":"NO_ISSUES"}' }] });
    const home = bundle(`refused-${Object.keys(record)[0]}`);
    const r = await muse.ask({ prompt: 'review this', home });
    assert.ok(!r.ok && /would hold/.test(r.reason), `${JSON.stringify(record)}: ${r.reason}`);
    const runs = execs();
    assert.deepStrictEqual(runs.map(provider), ['echo'], 'only the echo run, which makes no model call');
    const args = runs[0];
    assert.ok(isolated(args), 'no tools, and every read-only flag, in order');
    const workspace = args[args.indexOf('--workspace') + 1];
    assert.ok(workspace.startsWith(home) && fs.readdirSync(workspace).length === 0, 'an empty workspace in the attempt\'s folder');
  }
  // (a clean pre-check lets the real run go, but a real session whose record holds a tool loses its answer and the verification)
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
    setSpec({ exec: [clean] });
    assert.match((await muse.ask({ prompt: 'review this', home: bundle(`after-${c.name}`) })).reason, /isn't verified/);
    assert.deepStrictEqual(execs(), [], `${c.name}: nothing runs until doctor --live passes again`);
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
