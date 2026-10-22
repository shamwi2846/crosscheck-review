// Tests for crosscheck.js, step 5a (test plan P1): the review skip that acknowledges without GPT, the handoff and the
// fallback when GPT is unavailable, and closing a chain only with a reason per BUG. They run the real CLI, with the
// recording Codex stub fake-codex.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck cli test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CROSSCHECK_HOME, 'config.json'), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js') }));
const state = require('../src/state');
const review = require('../src/review');
const gaps = require('../src/gaps');
const hook = require('../src/hook');

const CLI = path.join(__dirname, '..', 'src', 'crosscheck.js');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const key = rel => state.pathKey(rel);
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const stateOf = root => state.read(state.files.project(root)).data;
const setSpec = spec => { fs.writeFileSync(SPEC, JSON.stringify(spec)); fs.rmSync(LOG, { force: true }); };
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0);
const env = session => ({ ...process.env, CLAUDE_CODE_SESSION_ID: session });
const cli = (cwd, args, session = 'A') => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: env(session) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 500 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const answerOf = (over = {}) => JSON.stringify({ verdict: 'NO_ISSUES', findings: [], requirements: [{ id: 'R1', status: 'MET', evidence: 'src/EA.mq5:1' }],
  possibly_missing: [], class: { level: 'normal', files: [], why: 'plain code' }, coverage: 'all checked', ...over });
const finding = (title, over = {}) => ({ severity: 'MEDIUM', title, location: 'src/a.js:1', trigger: 't', harm: 'h', failure: 'f', fix: 'x', test: null, label: 'BUG', reqs: [], ...over });
const followOf = rows => JSON.stringify({ verdict: rows.some(r => r.status !== 'RESOLVED') ? 'ISSUES_REMAIN' : 'RESOLVED', followups: rows, findings: [],
  requirements: [], possibly_missing: [], class: { level: 'normal', files: [], why: '-' }, coverage: 'c' });
const execLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.kind === 'exec');
const responseFile = text => { const f = path.join(HOME, `response-${crypto.randomBytes(3).toString('hex')}.md`); fs.writeFileSync(f, text); return f; };
const commitRefusal = root => {
  const denied = hook.handle('bash', { tool_input: { command: 'git commit -m x' }, cwd: root, session_id: 'A' });
  return denied ? denied.hookSpecificOutput.permissionDecisionReason : null;
};

// A git project with committed files, and session A's task file.
function project(name, committed) {
  const root = path.join(HOME, name);
  for (const [rel, text] of Object.entries(committed)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const g = args => assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const real = fs.realpathSync.native(root);
  const taskFile = state.files.task(real, 'A');
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  fs.writeFileSync(taskFile, '# task\n\n## Requirements\nR1. Keeps a stop loss on every order.\n\n## Notes\n-\n');
  return { root: real, task: review.sessionTask(real, 'A') };
}
const pending = (rel, session = 'A') => ({ path: rel, session, at: 1, baseline: null });
const change = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);

test('a review skip refuses a file GPT once rated risky and acknowledges nothing', () => {
  const { root } = project('t1', { 'docs/guide.md': 'g\n', 'src/payments.js': 'p\n' });
  change(root, 'docs/guide.md', 'reworded\n');
  change(root, 'src/payments.js', 'p2\n');
  seed(root, s => {
    s.changes = { [key('docs/guide.md')]: pending('docs/guide.md') };
    s.needsPlan = { [key('src/payments.js')]: [{ task: 'another task', reqHash: 'h' }] };
  });
  setSpec({ exec: [{ text: answerOf() }] });
  const before = stateOf(root);
  const r = cli(root, ['review', '--skip', '--why', 'comments only', '--files', 'src/payments.js']);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /never for risky files: src\/payments\.js/);
  const after = stateOf(root);
  assert.deepStrictEqual([after.acks, after.changes, after.needsPlan, after.reviewSkips], [{}, before.changes, before.needsPlan, undefined]);
  assert.strictEqual(calls(), 0);
});

test('an unavailable pair hands its bundle to the fallback, whose answer keeps newer edits and the risky file pending', () => {
  const { root, task } = project('t2 with spaces', { 'src/EA.mq5': 'e\n', 'src/helper.js': 'h\n' });
  change(root, 'src/EA.mq5', 'with a stop loss\n');
  change(root, 'src/helper.js', 'helper v1\n');
  seed(root, s => {
    s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') };
    s.plans = { [key('src/EA.mq5')]: { task: task.id, reqHash: task.reqHash, cases: [{ id: 'T1', text: 'an order without a stop is refused', test: 'tests/t.test.js' }], tests: [], at: 1 } };
  });
  setSpec({ byPrompt: [{ match: 'reviewer A. Check', answers: [{ text: answerOf() }] }, { match: 'reviewer B. Attack', answers: [{ fail: 'error: stream disconnected', code: 1 }] }] });
  const r = cli(path.join(root, 'src'), ['review', '--files', 'src/helper.js']);
  assert.strictEqual(r.status, 3, r.stdout);
  assert.match(r.stdout, /^GPT_UNAVAILABLE/);
  assert.match(r.stdout, /risky files: src\/EA\.mq5; attack them with this checklist:\n[\s\S]*money and trading[\s\S]*security/);
  const bundle = r.stdout.match(/review --fallback "([^"]+)" --answer "<answer\.json>"/)[1];
  assert.ok(fs.existsSync(path.join(bundle, 'prompt.md')));
  assert.deepStrictEqual([stateOf(root).chains, stateOf(root).acks], [{}, {}], 'neither reviewer\'s answer was applied');
  change(root, 'src/helper.js', 'helper v2, edited after the freeze\n');
  const answerFile = path.join(HOME, 't2-answer.json');
  const bug = { severity: 'MEDIUM', title: 'helper drops the stop', location: 'src/helper.js:1', trigger: 'any order', harm: 'no stop loss', failure: 'f', fix: 'x', test: null, label: 'BUG', reqs: ['R1'] };
  fs.writeFileSync(answerFile, answerOf({ verdict: 'ISSUES_FOUND', findings: [bug] }));
  const before = calls();
  const applied = cli(root, ['review', '--fallback', bundle, '--answer', answerFile]);
  assert.strictEqual(applied.status, 0, applied.stdout);
  assert.match(applied.stdout, /helper drops the stop/);
  const s = stateOf(root);
  assert.ok(s.changes[key('src/EA.mq5')] && !s.acks[key('src/EA.mq5')], 'the trading file waits for a completed pair, plan or not');
  assert.ok(s.changes[key('src/helper.js')] && !s.acks[key('src/helper.js')], 'the newer helper.js stays pending');
  assert.deepStrictEqual([s.riskyReviews, calls()], [{}, before], 'no receipt of a pair, and no GPT call');
});

test('closing a chain needs a gap reason for every open BUG', () => {
  const { root } = project('t3', { 'src/a.js': 'a\n' });
  const bug = (title, location) => ({ severity: 'HIGH', title, location, trigger: 't', harm: 'h', failure: 'f', fix: 'x', test: 'y', label: 'BUG', status: 'open', reqs: [] });
  seed(root, s => { s.chains = { C1: { rev: 4, rounds: ['r1'], closed: false, files: {}, frozen: {}, task: { title: 't' },
    findings: { F1: bug('importer loses rows', 'src/a.js:1'), F2: bug('old migration drops a column', 'src/a.js:9') } } }; });
  setSpec({ exec: [{ text: answerOf() }] });
  const before = fs.readFileSync(state.files.project(root), 'utf8');
  const partial = cli(root, ['close', 'C1', '--note', 'F1: gap: the importer is disabled in this release']);
  assert.strictEqual(partial.status, 1, partial.stdout);
  assert.deepStrictEqual([fs.readFileSync(state.files.project(root), 'utf8'), fs.existsSync(path.join(root, gaps.NAME))], [before, false]);
  const r = cli(root, ['close', 'C1', '--note', 'F1: gap: the importer is disabled in this release; F2: gap: the obsolete migration has no callers in this release']);
  assert.strictEqual(r.status, 0, r.stdout);
  const c = stateOf(root).chains.C1;
  assert.deepStrictEqual([c.closed, c.rev, c.findings.F1.reason, c.findings.F2.reason, c.findings.F1.label],
    [true, 5, 'the importer is disabled in this release', 'the obsolete migration has no callers in this release', 'GAP']);
  const known = fs.readFileSync(path.join(root, gaps.NAME), 'utf8');
  assert.match(known, /Problem: F1: importer loses rows\n(- .*\n)*- Why skipped: the importer is disabled in this release\n/);
  assert.match(known, /Problem: F2: old migration drops a column\n(- .*\n)*- Why skipped: the obsolete migration has no callers in this release\n/);
  assert.strictEqual(calls(), 0);
});

test('a follow-up, or a repair, that GPT can\'t complete hands its bundle to the fallback', () => {
  const { root } = project('t6', { 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  change(root, 'src/a.js', 'a2\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: pending('src/a.js') }; });
  const bug = { severity: 'MEDIUM', title: 'off by one', location: 'src/a.js:1', trigger: 't', harm: 'wrong sum', failure: 'f', fix: 'x', test: null, label: 'BUG', reqs: [] };
  setSpec({ exec: [{ text: answerOf({ verdict: 'ISSUES_FOUND', findings: [bug], class: { level: 'risky', files: ['src/a.js'], why: 'it moves money' } }) }] });
  const first = cli(root, ['review']);
  assert.strictEqual(first.status, 0, first.stdout);
  const chain = first.stdout.match(/^chain (\S+)/m)[1];
  seed(root, s => { delete s.escalations[key('src/a.js')]; }); // (as its own paired review leaves it)
  const response = path.join(HOME, 't6-response.md');
  fs.writeFileSync(response, 'F1: fixed');
  const disconnected = { fail: 'error: stream disconnected', code: 1 };
  setSpec({ exec: [disconnected] });
  const followup = cli(root, ['review', '--followup', chain, '--file', response]);
  assert.strictEqual(followup.status, 3, followup.stdout);
  assert.match(followup.stdout, /^GPT_UNAVAILABLE: (?!GPT_UNAVAILABLE)[\s\S]*review --fallback "[^"]+" --answer/);
  assert.match(followup.stdout, /risky files: src\/a\.js; attack them with this checklist/, 'a file GPT rated risky in the chain stays risky');
  // a repair whose Codex run fails even after its retry
  change(root, 'src/b.js', 'b2\n');
  seed(root, s => { s.changes[key('src/b.js')] = pending('src/b.js'); });
  setSpec({ exec: [{ text: answerOf({ requirements: [] }) }, disconnected] }); // (R1 isn't rated, so it needs a repair)
  const repaired = cli(root, ['review', '--files', 'src/b.js']);
  assert.strictEqual(repaired.status, 3, repaired.stdout);
  assert.match(repaired.stdout, /^GPT_UNAVAILABLE[\s\S]*review --fallback/);
});

test('a review skip cannot acknowledge a file a live review holds', async () => {
  const { root } = project('t4', { 'docs/guide.md': 'g\n' });
  change(root, 'docs/guide.md', 'formatted\n');
  seed(root, s => { s.changes = { [key('docs/guide.md')]: pending('docs/guide.md') }; });
  const hold = fs.mkdtempSync(path.join(HOME, 't4-hold-'));
  setSpec({ exec: [{ hold, text: answerOf({ requirements: [{ id: 'R1', status: 'NOT_IN_THIS_CHANGE', evidence: 'docs only' }] }) }] });
  const running = spawn(process.execPath, [CLI, 'review'], { cwd: root, env: env('A'), stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  running.stdout.on('data', d => { out += d; });
  const exited = new Promise(resolve => running.on('close', resolve)); // (close: after the last output, not just the exit)
  await waitFor(path.join(hold, 'started'));
  const r = cli(root, ['review', '--skip', '--why', 'formatting only']);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /running review: docs\/guide\.md/);
  const s = stateOf(root);
  assert.deepStrictEqual([s.acks, !!s.changes[key('docs/guide.md')], !!s.running[key('docs/guide.md')], s.reviewSkips, calls()], [{}, true, true, undefined, 1]);
  fs.writeFileSync(path.join(hold, 'go'), '');
  assert.strictEqual(await exited, 0, out);
  assert.strictEqual(stateOf(root).acks[key('docs/guide.md')], sha('formatted\n'), 'the held review applies normally');
});

test('a review skip needs its reason, and records only the chosen files\' current versions', () => {
  const { root } = project('t5', { 'docs/guide.md': 'g\n', 'docs/extra.md': 'x\n', 'docs/other.md': 'o\n' });
  change(root, 'docs/guide.md', 'session A wording\n');
  change(root, 'docs/extra.md', 'edited by a shell\n');
  change(root, 'docs/other.md', 'session B wording\n');
  seed(root, s => { s.changes = { [key('docs/guide.md')]: pending('docs/guide.md'), [key('docs/other.md')]: pending('docs/other.md', 'B') }; });
  setSpec({ exec: [{ text: answerOf() }] });
  const before = fs.readFileSync(state.files.project(root), 'utf8');
  // wrong usage changes nothing: the reason left out, an option written as --name=value, an option review doesn't take
  for (const args of [['--why', '--files', 'docs/extra.md'], ['--why', '--files=docs/extra.md'], ['--why', '-files=docs/extra.md'], ['--why=docs only'],
    ['--why', 'docs only', '--file', 'docs/extra.md']]) {
    const wrong = cli(root, ['review', '--skip', ...args]);
    assert.strictEqual(wrong.status, 2, `${args.join(' ')}: ${wrong.stdout}`);
  }
  assert.strictEqual(fs.readFileSync(state.files.project(root), 'utf8'), before);
  const bare = cli(root, ['review', '--skip', '--files', 'docs/extra.md']);
  assert.strictEqual(bare.status, 1, bare.stdout);
  assert.match(bare.stdout, /needs its reason/);
  assert.strictEqual(fs.readFileSync(state.files.project(root), 'utf8'), before);
  const r = cli(root, ['review', '--skip', '--files', 'docs/extra.md', '--why', 'documentation wording only']);
  assert.strictEqual(r.status, 0, r.stdout);
  const s = stateOf(root);
  const versions = { [key('docs/guide.md')]: sha('session A wording\n'), [key('docs/extra.md')]: sha('edited by a shell\n') };
  assert.deepStrictEqual(s.acks, versions);
  for (const [k, hash] of Object.entries(versions)) assert.ok(fs.existsSync(review.snapFile(root, hash)), `${k} is snapshotted`);
  assert.deepStrictEqual(Object.keys(s.changes), [key('docs/other.md')], 'session B\'s change is untouched');
  assert.deepStrictEqual(s.reviewSkips.map(k => [k.why, k.session, k.versions]), [['documentation wording only', 'A', versions]]);
  assert.strictEqual(calls(), 0);
});

test('crosscheck\'s own gap writes through the CLI stay acknowledged, never a shell edit made during a review', async () => {
  const older = '# Known gaps\n\nFindings left unfixed on purpose. Entries are never deleted, only marked fixed.\n\n## G1 · open · 2026-10-01 · LOW\n- Where: src/old.js\n- Problem: older\n';
  const { root } = project('t7', { 'src/a.js': 'a0\n', [gaps.NAME]: older });
  seed(root, s => { s.acks = { [key(gaps.NAME)]: sha(older) }; s.changes = { [key('src/a.js')]: pending('src/a.js') }; });
  change(root, 'src/a.js', 'a1\n');
  setSpec({ exec: [{ text: answerOf({ verdict: 'ISSUES_FOUND', findings: [finding('odd name', { severity: 'LOW', label: 'GAP' }), finding('off by one')] }) },
    { text: followOf([{ id: 'F1', status: 'RESOLVED', reason: 'renamed' }, { id: 'F2', status: 'MAINTAIN', reason: 'still there' }]) }] });
  const gapsNow = () => fs.readFileSync(path.join(root, gaps.NAME), 'utf8');
  const acknowledged = what => {
    const s = stateOf(root);
    assert.deepStrictEqual([s.acks[key(gaps.NAME)], s.changes[key(gaps.NAME)]], [sha(gapsNow()), undefined], what);
    assert.match(gapsNow(), /- Problem: older/, `${what}: the older entry stays`);
  };
  const first = cli(root, ['review']);
  assert.strictEqual(first.status, 0, first.stdout);
  const chain = first.stdout.match(/^chain (\S+)/m)[1];
  acknowledged('a review');
  assert.strictEqual(cli(root, ['review', '--followup', chain, '--file', responseFile('renamed it')]).status, 0);
  assert.match(gapsNow(), /· fixed ·/);
  acknowledged('a follow-up');
  const closed = cli(root, ['close', chain, '--note', 'F2: gap: the affected feature is disabled']);
  assert.strictEqual(closed.status, 0, closed.stdout);
  acknowledged('a close');
  assert.strictEqual(commitRefusal(root), null, 'the closed chain lets the commit through');
  // a held review during which a shell edits KNOWN_GAPS.md
  const ack = stateOf(root).acks[key(gaps.NAME)];
  change(root, 'src/a.js', 'a2\n');
  const hold = fs.mkdtempSync(path.join(HOME, 't7-hold-'));
  setSpec({ exec: [{ hold, text: answerOf({ verdict: 'ISSUES_FOUND', findings: [finding('another', { severity: 'LOW', label: 'GAP' })] }) }] });
  const run = spawn(process.execPath, [CLI, 'review', '--files', 'src/a.js'], { cwd: root, env: env('A'), stdio: 'ignore' });
  const ended = new Promise(resolve => run.on('close', resolve));
  await waitFor(path.join(hold, 'started'));
  fs.writeFileSync(path.join(root, gaps.NAME), `${gapsNow()}\n<!-- a note by hand -->\n`);
  fs.writeFileSync(path.join(hold, 'go'), '');
  assert.strictEqual(await ended, 0);
  assert.ok(gapsNow().includes('<!-- a note by hand -->') && /- Problem: F1: another/.test(gapsNow()), 'the shell edit stays, with the new entry');
  assert.strictEqual(stateOf(root).acks[key(gaps.NAME)], ack, 'its acknowledgement stays where it was');
  assert.match(commitRefusal(root), /differ from their last reviewed version: KNOWN_GAPS\.md/);
});

test('a CLI follow-up refuses another session\'s pending change, even in an escalated file it would leave out', () => {
  const { root } = project('t8', { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n' });
  change(root, 'src/a.js', 'a1\n');
  change(root, 'src/b.js', 'b1\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: pending('src/a.js'), [key('src/b.js')]: pending('src/b.js') }; });
  setSpec({ exec: [{ text: answerOf({ verdict: 'ISSUES_FOUND', findings: [finding('off by one')] }) }, { text: followOf([{ id: 'F1', status: 'RESOLVED', reason: 'fixed' }]) }] });
  const first = cli(root, ['review']);
  assert.strictEqual(first.status, 0, first.stdout);
  const chain = first.stdout.match(/^chain (\S+)/m)[1];
  change(root, 'src/a.js', 'a2 by B\n');
  seed(root, s => {
    s.changes[key('src/a.js')] = { path: 'src/a.js', session: 'B', at: 9, baseline: sha('a1\n') };
    s.escalations = { [key('src/a.js')]: { chain: 'C0', at: 1 } };
  });
  const before = [JSON.stringify(stateOf(root)), fs.existsSync(path.join(root, gaps.NAME)), calls()];
  const r = cli(root, ['review', '--followup', chain, '--file', responseFile('fixed it')], 'B');
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /another session has pending changes in src\/a\.js/);
  assert.deepStrictEqual([JSON.stringify(stateOf(root)), fs.existsSync(path.join(root, gaps.NAME)), calls()], before, 'nothing changes and GPT is not asked');
});

test('a risky review whose driver is killed mid-pair is paired again on a plain retry', async () => {
  const { root, task } = project('t10', { 'src/payments.js': 'p0\n' });
  change(root, 'src/payments.js', 'p1\n');
  seed(root, s => {
    s.changes = { [key('src/payments.js')]: pending('src/payments.js') };
    s.plans = { [key('src/payments.js')]: { task: task.id, reqHash: task.reqHash, cases: [{ id: 'T1', text: 'a refund runs once', test: 'tests/t.test.js' }], tests: [], at: 1 } };
  });
  const hold = fs.mkdtempSync(path.join(HOME, 't10-hold-'));
  setSpec({ byPrompt: [{ match: 'reviewer A. Check', answers: [{ hold, text: answerOf() }, { text: answerOf() }] }, { match: 'reviewer B. Attack', answers: [{ text: answerOf() }, { text: answerOf() }] }] });
  const run = spawn(process.execPath, [CLI, 'review', '--risky'], { cwd: root, env: env('A'), stdio: 'ignore' });
  const ended = new Promise(resolve => run.on('close', resolve));
  try {
    await waitFor(path.join(hold, 'started'));
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(run.pid), '/F'], { windowsHide: true }); // (forced: no cleanup runs)
    else run.kill('SIGKILL');
    await ended;
    assert.ok(stateOf(root).escalations[key('src/payments.js')], 'it stays escalated: the pair never completed');
    const retry = cli(root, ['review']); // (no --risky this time)
    assert.strictEqual(retry.status, 0, retry.stdout);
    const s = stateOf(root);
    assert.ok(s.riskyReviews[key('src/payments.js')], 'the retry is a completed pair (only one grants this receipt)');
    assert.deepStrictEqual([s.acks[key('src/payments.js')], s.changes[key('src/payments.js')], s.escalations[key('src/payments.js')]], [sha('p1\n'), undefined, undefined]);
  } finally {
    fs.writeFileSync(path.join(hold, 'go'), ''); // (the held reviewer of the killed driver may answer and exit)
  }
});

test('a CLI concession because of the round limit fails after its one repair, and the same reason can\'t close the chain', () => {
  const { root } = project('t9', { 'src/a.js': 'a0\n' });
  change(root, 'src/a.js', 'a1\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: pending('src/a.js') }; });
  const limit = { id: 'F1', status: 'CONCEDE', reason: 'the round limit was reached' };
  const maintain = { id: 'F1', status: 'MAINTAIN', reason: 'still there' };
  setSpec({ exec: [{ text: answerOf({ verdict: 'ISSUES_FOUND', findings: [finding('off by one')] }) }, { text: followOf([maintain]) }, { text: followOf([maintain]) },
    { text: followOf([limit]) }, { text: followOf([limit]) }] });
  const first = cli(root, ['review']);
  assert.strictEqual(first.status, 0, first.stdout);
  const chain = first.stdout.match(/^chain (\S+)/m)[1];
  for (const v of ['a2\n', 'a3\n']) {
    change(root, 'src/a.js', v);
    assert.strictEqual(cli(root, ['review', '--followup', chain, '--file', responseFile(v)]).status, 0);
  }
  change(root, 'src/a.js', 'a4\n');
  const before = [JSON.stringify(stateOf(root)), fs.existsSync(path.join(root, gaps.NAME))];
  const r = cli(root, ['review', '--followup', chain, '--file', responseFile('past it')]);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /F1 is conceded because of the round limit/);
  const [answered, repair] = execLog().slice(-2);
  assert.ok(repair.prompt.startsWith('Your answer has these problems') && repair.args[1] === 'resume' && repair.args.includes(answered.session));
  const closing = cli(root, ['close', chain, '--note', 'F1: gap: the round limit was reached']);
  assert.strictEqual(closing.status, 1, closing.stdout);
  assert.match(closing.stdout, /the round limit is never a reason/);
  assert.deepStrictEqual([JSON.stringify(stateOf(root)), fs.existsSync(path.join(root, gaps.NAME))], before, 'F1 stays open, the chain open, no gap written');
});

test('fast toggle preserves concurrent global safety updates', async () => {
  const global = state.files.global();
  fs.writeFileSync(global, JSON.stringify({ off: false, plans: { abc: { at: 1 } } }));
  const hold = fs.mkdtempSync(path.join(HOME, 'fast-hold-'));
  // (a worker holds the shared lock and, before letting go, records a cooldown, a screen window, a desktop owner and a plan)
  const worker = spawn(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path'), state = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'state.js'))});
    const hold = ${JSON.stringify(hold)};
    state.update(state.files.global(), g => {
      fs.writeFileSync(path.join(hold, 'started'), '');
      const until = Date.now() + 6000;
      while (!fs.existsSync(path.join(hold, 'go')) && Date.now() < until) {}
      Object.assign(g, { cooldownUntil: Date.now() + 15 * 60000, cooldownReason: 'usage limit', screen: { session: 'S', until: Date.now() + 60000, why: 'w' },
        desktop: { pid: 1, workers: [], project: 'p', at: 1 } });
      g.plans.def = { at: 2 };
    });`], { env: process.env, stdio: 'ignore' });
  await waitFor(path.join(hold, 'started'));
  const toggling = spawn(process.execPath, [CLI, 'fast', 'on'], { cwd: HOME, env: env('A'), stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  toggling.stdout.on('data', d => { out += d; });
  await sleep(400);
  assert.strictEqual(state.read(global).data.fast, undefined, 'the toggle waits for the lock');
  fs.writeFileSync(path.join(hold, 'go'), '');
  const code = await new Promise(resolve => (toggling.exitCode !== null ? resolve(toggling.exitCode) : toggling.on('exit', resolve)));
  if (worker.exitCode === null) await new Promise(resolve => worker.on('exit', resolve));
  assert.strictEqual(code, 0, out);
  const g = state.read(global).data;
  assert.deepStrictEqual([g.fast, g.off, Object.keys(g.plans).sort(), g.screen.session, g.desktop.pid, g.cooldownReason], [true, false, ['abc', 'def'], 'S', 1, 'usage limit']);
  setSpec({ exec: [{ text: 'fine' }] });
  const blocked = await require('../src/codex').ask({ mode: 'review', effort: 'high', prompt: 'x', cwd: HOME });
  assert.strictEqual(blocked.unavailable, true);
  assert.strictEqual(calls(), 0, 'the cooldown still blocks GPT: Codex never starts');
  fs.rmSync(global);
});
