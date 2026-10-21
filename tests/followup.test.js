// Tests for review.js follow-ups, closing and the fallback: chains keep their ids, scope and history, a stale chain
// revision changes nothing, and nothing closes without a real reason (test plan P2 of step 2b).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck followup test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CROSSCHECK_HOME, 'config.json'), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js') }));
const state = require('../src/state');
const review = require('../src/review');
const gaps = require('../src/gaps');
const hook = require('../src/hook');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const setSpec = exec => { fs.writeFileSync(SPEC, JSON.stringify({ exec })); fs.rmSync(LOG, { force: true }); };
const execCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.kind === 'exec');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 300 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const stateOf = root => state.read(state.files.project(root)).data;
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const key = rel => state.pathKey(rel);
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
const gapsText = root => fs.readFileSync(path.join(root, gaps.NAME), 'utf8');

function project(name, files) {
  const root = path.join(HOME, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'base']]) {
    assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  }
  const taskFile = path.join(HOME, `${name}-task.md`);
  fs.writeFileSync(taskFile, `# ${name}\n\n## Requirements\nR1. Adds numbers.\nR2. Keeps the sum.\n`);
  // (its real spelling, as git reports it: a short 8.3 temp path would give the commit hook another state folder)
  return { root: fs.realpathSync.native(root), taskFile };
}
const finding = (title, location, over = {}) => ({ severity: 'MEDIUM', title, location, trigger: 't', harm: 'h', failure: 'f', fix: 'x', test: null, label: 'BUG', reqs: [], ...over });
const met = ids => ids.map(id => ({ id, status: 'MET', evidence: 'src/a.js:1' }));
const normal = { level: 'normal', files: [], why: '-' };
const reviewAnswer = (findings, cls = normal) => JSON.stringify({ verdict: findings.length ? 'ISSUES_FOUND' : 'NO_ISSUES', findings,
  requirements: met(['R1', 'R2']), possibly_missing: [], class: cls, coverage: 'c' });
const followAnswer = (followups, { findings = [], rows = [], cls = normal } = {}) => JSON.stringify({
  verdict: followups.some(f => f.status === 'MAINTAIN') || findings.length ? 'ISSUES_REMAIN' : 'RESOLVED',
  followups, findings, requirements: met(rows), possibly_missing: [], class: cls, coverage: 'c' });
const row = (id, status) => ({ id, status, reason: `${id} ${status.toLowerCase()}` });
const response = text => { const f = path.join(HOME, `response-${crypto.randomBytes(3).toString('hex')}.md`); fs.writeFileSync(f, text); return f; };
// A chain from a fresh review of this session's change to src/a.js (and any other pending files).
async function freshChain(root, taskFile, findings, more = {}) {
  seed(root, s => { s.changes = { ...(s.changes || {}), [key('src/a.js')]: { path: 'src/a.js', session: 'A', at: 1, baseline: null }, ...more }; });
  const r = await review.review(root, { session: 'A', taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  return r.chain;
}

test('full follow-ups keep their scope, history, finding ids and the gap lifecycle', async () => {
  const { root, taskFile } = project('t1', { 'src/a.js': 'a0\n' });
  fs.writeFileSync(path.join(root, gaps.NAME), `# Known gaps\n${[1, 2, 3, 4, 5, 6].map(n => `\n## G${n} · open · 2026-10-01 · LOW\n- Where: src/old.js\n- Problem: old ${n}\n`).join('')}`);
  write(root, 'src/a.js', 'a1\n');
  setSpec([{ text: reviewAnswer([finding('one', 'src/a.js:1'), finding('two', 'src/a.js:1'), finding('three', 'src/a.js:1'), finding('four', 'src/a.js:1', { severity: 'LOW', label: 'GAP' })]) },
    { text: followAnswer([row('F1', 'RESOLVED'), row('F2', 'CONCEDE'), row('F3', 'MAINTAIN'), row('F4', 'MAINTAIN')], { findings: [finding('five', 'src/a.js:1', { severity: 'LOW' })], rows: ['R2'] }) },
    { fail: 'error: no such session', code: 1 }, { fail: 'error: no such session', code: 1 },
    { text: followAnswer([row('F3', 'MAINTAIN'), row('F4', 'RESOLVED'), row('F5', 'RESOLVED')]) }]);
  const chain = await freshChain(root, taskFile, []);
  assert.strictEqual(stateOf(root).chains[chain].findings.F4.gap, 'G7');
  seed(root, s => { // pending work outside the chain, from both sessions
    s.changes[key('src/x.js')] = { path: 'src/x.js', session: 'A', at: 5, baseline: null };
    s.changes[key('src/y.js')] = { path: 'src/y.js', session: 'B', at: 6, baseline: null };
  });
  write(root, 'src/a.js', 'a2\n');
  fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace('R2. Keeps the sum.', 'R2. Keeps the sum, rounded.'));
  const r2 = await review.followup(root, { chain, responseFile: response('RESPONSE-2: fixed one, two was never real') });
  assert.strictEqual(r2.status, 'DONE', r2.text);
  const p2 = execCalls()[1].prompt;
  for (const id of ['F1', 'F2', 'F3', 'F4']) assert.match(p2, new RegExp(`- ${id} \\[`));
  assert.match(p2, /RESPONSE-2/);
  assert.match(p2, /## Changed requirements\nR2\. Keeps the sum, rounded\.\n/);
  assert.ok(!p2.includes('R1. Adds numbers.'));
  assert.match(p2, /-a1\n\+a2/);
  let s = stateOf(root);
  let c = s.chains[chain];
  assert.deepStrictEqual(Object.entries(c.findings).map(([id, f]) => [id, f.label, f.status]),
    [['F1', 'BUG', 'resolved'], ['F2', 'BUG', 'conceded'], ['F3', 'BUG', 'open'], ['F4', 'GAP', 'open'], ['F5', 'GAP', 'open']]);
  assert.strictEqual(c.findings.F5.gap, 'G8');
  assert.match(gapsText(root), /## G8 · open · \S+ · LOW\n- Task: t1\n- Where: src\/a\.js:1\n- Problem: F5: five/);
  assert.ok(!/F2: two/.test(gapsText(root)));
  assert.deepStrictEqual([s.changes[key('src/x.js')].at, s.changes[key('src/y.js')].session], [5, 'B']);
  assert.deepStrictEqual([c.rev, c.rounds.length], [2, 2]);
  write(root, 'src/a.js', 'a3\n');
  const r3 = await review.followup(root, { chain, responseFile: response('RESPONSE-3') });
  assert.strictEqual(r3.status, 'DONE', r3.text);
  const calls = execCalls();
  assert.deepStrictEqual(calls.slice(2).map(x => x.args[1]), ['resume', 'resume', '--ignore-user-config']);
  const p3 = calls[4].prompt;
  assert.match(p3, /This review continues in a new session/);
  assert.ok(p3.indexOf('# Round 1') < p3.indexOf('# Round 2') && p3.indexOf('# Round 2') < p3.indexOf('# The current round'));
  assert.match(p3, /RESPONSE-2/);
  assert.match(p3, /## Changed requirements\nNone\./);
  s = stateOf(root);
  c = s.chains[chain];
  assert.deepStrictEqual(Object.values(c.findings).map(f => f.status), ['resolved', 'conceded', 'open', 'resolved', 'resolved']);
  assert.match(gapsText(root), /## G7 · fixed · /);
  assert.match(gapsText(root), /## G8 · fixed · /);
  assert.match(gapsText(root), /## G6 · open · 2026-10-01 · LOW\n- Where: src\/old\.js\n- Problem: old 6\n/);
  assert.deepStrictEqual([c.rev, c.rounds.length, c.frozen[key('src/a.js')]], [3, 3, sha('a3\n')]);
});

test('a stale chain revision changes nothing, through a follow-up, a close or the fallback', async () => {
  const { root, taskFile } = project('t2', { 'src/a.js': 'a0\n' });
  write(root, 'src/a.js', 'a1\n');
  const hold = fs.mkdtempSync(path.join(HOME, 't2-hold-'));
  const staleAnswer = followAnswer([row('F1', 'RESOLVED'), row('F2', 'MAINTAIN')], { findings: [finding('another', 'src/a.js:1', { label: 'GAP' })] });
  setSpec([{ text: reviewAnswer([finding('gap one', 'src/a.js:1', { severity: 'LOW', label: 'GAP' }), finding('bug two', 'src/a.js:1')]) },
    { hold, text: staleAnswer }]);
  const chain = await freshChain(root, taskFile, []);
  write(root, 'src/a.js', 'a2\n');
  const running = review.followup(root, { chain, responseFile: response('r') });
  await waitFor(path.join(hold, 'started'));
  seed(root, s => { s.chains[chain].rev = 5; s.chains[chain].note = 'an intervening update'; });
  const before = { state: JSON.stringify(stateOf(root)), gaps: gapsText(root) };
  const closing = review.close(root, { chain, rev: 1, notes: { F2: 'gap: only a cosmetic path' } });
  assert.strictEqual(closing.status, 'REFUSED');
  assert.strictEqual(JSON.stringify(stateOf(root)), before.state);
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'NOT_DONE');
  assert.match(r.text, /changed or closed since this round began/);
  const answerFile = path.join(HOME, 't2-answer.json');
  fs.writeFileSync(answerFile, staleAnswer);
  const late = review.fallback(root, { bundle: r.bundle, answerFile });
  assert.strictEqual(late.status, 'NOT_DONE');
  const s = stateOf(root);
  assert.deepStrictEqual({ ...s, running: {} }, { ...JSON.parse(before.state), running: {} });
  assert.strictEqual(s.chains[chain].rev, 5);
  assert.strictEqual(s.applied[path.basename(r.bundle)], undefined);
  assert.strictEqual(gapsText(root), before.gaps);
});

test('narrow rounds keep a regression a fix caused, and a file rated risky mid-chain blocks closing', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  const { root, taskFile } = project('t3', { 'src/a.js': `${lines.join('\n')}\n`, 'src/b.js': 'b0\n' });
  write(root, 'src/a.js', `FIRST\n${lines.slice(1).join('\n')}\n`);
  write(root, 'src/b.js', 'b1\n');
  setSpec([{ text: reviewAnswer([finding('wrong first line', 'src/a.js:1')]) },
    { text: followAnswer([row('F1', 'MAINTAIN')]) }, { text: followAnswer([row('F1', 'MAINTAIN')]) },
    { text: followAnswer([row('F1', 'RESOLVED')], { findings: [finding('the fix broke line two', 'src/a.js:2', { severity: 'LOW' })],
      cls: { level: 'risky', files: ['src/a.js'], why: 'it moves money' } }) },
    { text: followAnswer([row('F2', 'MAINTAIN')]) }]);
  const chain = await freshChain(root, taskFile, [], { [key('src/b.js')]: { path: 'src/b.js', session: 'A', at: 2, baseline: null } });
  for (const v of ['SECOND', 'THIRD']) {
    write(root, 'src/a.js', `${v}\n${lines.slice(1).join('\n')}\n`);
    assert.strictEqual((await review.followup(root, { chain, responseFile: response(v) })).status, 'DONE');
  }
  write(root, 'src/a.js', `FIXED\nbroken two\n${lines.slice(2).join('\n')}\n`);
  const r4 = await review.followup(root, { chain, responseFile: response('the fix') });
  assert.strictEqual(r4.status, 'DONE', r4.text);
  const p4 = execCalls()[3].prompt;
  assert.match(p4, /The round limit is reached/);
  assert.match(p4, /### src\/a\.js \(diff from its last reviewed version\)/);
  assert.ok(!p4.includes('line 30'));
  assert.match(p4, /### src\/b\.js \(unchanged since the last round\)\n/);
  assert.doesNotMatch(p4, /^b1$/m); // (b.js's content line; the snapshot hashes the prompt lists may contain "b1")
  let s = stateOf(root);
  assert.deepStrictEqual(['label', 'severity', 'status'].map(k => s.chains[chain].findings.F2[k]), ['BUG', 'LOW', 'open']);
  assert.strictEqual(s.escalations[key('src/a.js')].chain, chain);
  assert.ok(s.changes[key('src/a.js')]);
  seed(root, x => { x.riskyReviews = { [key('src/a.js')]: x.chains[chain].began - 1000 }; });
  write(root, 'src/b.js', 'b2\n');
  const r5 = await review.followup(root, { chain, responseFile: response('b only') });
  assert.strictEqual(r5.status, 'DONE', r5.text);
  assert.ok(!execCalls()[4].prompt.includes('### src/a.js'));
  s = stateOf(root);
  assert.ok(s.escalations[key('src/a.js')]);
  const gapsBefore = fs.existsSync(path.join(root, gaps.NAME)) ? gapsText(root) : null;
  const closing = review.close(root, { chain, rev: s.chains[chain].rev, notes: { F2: 'gap: only reachable through a manual edit' } });
  assert.strictEqual(closing.status, 'REFUSED');
  assert.match(closing.text, /src\/a\.js was rated risky in this chain/);
  assert.strictEqual(fs.existsSync(path.join(root, gaps.NAME)) ? gapsText(root) : null, gapsBefore);
  assert.deepStrictEqual(review.openBugs(root).map(b => b.id), ['F2']);
  assert.deepStrictEqual(review.openChains(root), [chain]);
});

test('the fallback reserves its frozen scope, keeps newer edits and applies exactly once', async () => {
  const { root, taskFile } = project('t4', { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n' });
  write(root, 'src/a.js', 'a1\n');
  write(root, 'src/b.js', 'b1\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: { path: 'src/a.js', session: 'A', at: 1, baseline: null }, [key('src/b.js')]: { path: 'src/b.js', session: 'A', at: 2, baseline: null } }; });
  const wrong = reviewAnswer([finding('nowhere', 'src/elsewhere.js:1')]);
  // (a chain the fallback made has no Codex session, so its next round starts fresh at once)
  setSpec([{ text: wrong }, { text: wrong }, { text: followAnswer([row('F1', 'MAINTAIN')]) }]);
  const failed = await review.review(root, { session: 'A', taskFile });
  assert.strictEqual(failed.status, 'NOT_DONE');
  const manifestBefore = fs.readFileSync(path.join(failed.bundle, 'manifest.json'), 'utf8');
  seed(root, s => {
    s.changes[key('src/a.js')] = { path: 'src/a.js', session: 'B', at: 77, baseline: null, note: 'B edited it' };
    s.changes[key('src/u.js')] = { path: 'src/u.js', session: 'B', at: 8, baseline: null };
    s.running[key('src/b.js')] = { attempt: 'other', pid: process.pid };
  });
  write(root, 'src/a.js', 'a2 by B\n');
  const answerFile = path.join(HOME, 't4-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer([finding('FALLBACK-GAP', 'src/b.js:1', { severity: 'LOW', label: 'GAP' })]));
  const elsewhere = project('t4-other', { 'src/a.js': 'a0\n', 'src/b.js': 'b1\n' });
  const otherBefore = JSON.stringify(stateOf(elsewhere.root) || {});
  const wrongProject = review.fallback(elsewhere.root, { bundle: failed.bundle, answerFile });
  assert.strictEqual(wrongProject.status, 'REFUSED');
  assert.match(wrongProject.text, /belongs to another project/);
  assert.strictEqual(JSON.stringify(stateOf(elsewhere.root) || {}), otherBefore);
  assert.ok(!fs.existsSync(path.join(elsewhere.root, gaps.NAME)));
  const busy = review.fallback(root, { bundle: failed.bundle, answerFile });
  assert.strictEqual(busy.status, 'REFUSED');
  assert.deepStrictEqual(stateOf(root).running[key('src/b.js')], { attempt: 'other', pid: process.pid });
  seed(root, s => { delete s.running[key('src/b.js')]; });
  const done = review.fallback(root, { bundle: failed.bundle, answerFile });
  assert.strictEqual(done.status, 'DONE', done.text);
  assert.strictEqual(fs.readFileSync(path.join(failed.bundle, 'manifest.json'), 'utf8'), manifestBefore);
  let s = stateOf(root);
  assert.strictEqual(s.acks[key('src/b.js')], sha('b1\n'));
  assert.deepStrictEqual([s.changes[key('src/a.js')].session, s.changes[key('src/a.js')].at, s.changes[key('src/a.js')].note, s.changes[key('src/a.js')].baseline],
    ['B', 77, 'B edited it', sha('a1\n')]);
  assert.strictEqual(s.changes[key('src/u.js')].at, 8);
  assert.match(gapsText(root), /- Problem: F1: FALLBACK-GAP/);
  const after = { state: JSON.stringify(s), gaps: gapsText(root) };
  const again = review.fallback(root, { bundle: failed.bundle, answerFile });
  assert.strictEqual(again.status, 'REFUSED');
  assert.match(again.text, /already applied/);
  assert.strictEqual(JSON.stringify(stateOf(root)), after.state);
  assert.strictEqual(gapsText(root), after.gaps);
  write(root, 'src/b.js', 'b2\n');
  // (B's pending edit of src/a.js is B's to review: the chain's follow-up waits for it)
  const waiting = await review.followup(root, { chain: done.chain, responseFile: response('after the fallback') });
  assert.strictEqual(waiting.status, 'REFUSED');
  assert.match(waiting.text, /another session has pending changes in src\/a\.js/);
  seed(root, x => { delete x.changes[key('src/a.js')]; }); // (as B's own review leaves it)
  const next = await review.followup(root, { chain: done.chain, responseFile: response('after the fallback') });
  assert.strictEqual(next.status, 'DONE', next.text);
  const prompt = execCalls().slice(-1)[0].prompt;
  assert.match(prompt, /This review continues in a new session/);
  assert.match(prompt, /FALLBACK-GAP/);
});

test('closing needs a real disposition per open BUG and records relabelled BUGs before closing', async () => {
  const { root, taskFile } = project('t5', { 'src/a.js': 'a0\n' });
  write(root, 'src/a.js', 'a1\n');
  setSpec([{ text: reviewAnswer([finding('one', 'src/a.js:1'), finding('two', 'src/a.js:1'), finding('three', 'src/a.js:1', { severity: 'LOW', label: 'GAP' })]) },
    { text: followAnswer([row('F1', 'RESOLVED'), row('F2', 'MAINTAIN'), row('F3', 'MAINTAIN')]) },
    { text: followAnswer([row('F2', 'MAINTAIN'), row('F3', 'MAINTAIN')]) }]);
  const chain = await freshChain(root, taskFile, []);
  for (const v of ['a2\n', 'a3\n']) {
    write(root, 'src/a.js', v);
    assert.strictEqual((await review.followup(root, { chain, responseFile: response(v) })).status, 'DONE');
  }
  const rev = stateOf(root).chains[chain].rev;
  const before = { state: JSON.stringify(stateOf(root)), gaps: gapsText(root) };
  for (const why of ['fixed, the round limit was reached', 'already fixed in the latest edit', 'gap: left open because we hit the round limit',
    'gap: the limit of three full rounds has been reached', 'gap: the limit was reached after three rounds', '']) {
    const r = review.close(root, { chain, rev, notes: { F2: why } });
    assert.strictEqual(r.status, 'REFUSED', why);
    assert.strictEqual(JSON.stringify(stateOf(root)), before.state);
    assert.strictEqual(gapsText(root), before.gaps);
  }
  const gapsFile = path.join(root, gaps.NAME);
  const realRename = fs.renameSync;
  let gapsFirst = null;
  fs.renameSync = (from, to) => {
    if (to === gapsFile) gapsFirst = !stateOf(root).chains[chain].closed;
    return realRename(from, to);
  };
  let closed;
  try {
    closed = review.close(root, { chain, rev, notes: { F2: 'gap: only triggers on a hand-edited config file; no data at stake' } });
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(closed.status, 'DONE', closed.text);
  assert.strictEqual(gapsFirst, true);
  const text = gapsText(root);
  assert.ok(text.startsWith(before.gaps));
  assert.match(text, /- Problem: F2: two\n[^#]*- Why skipped: only triggers on a hand-edited config file; no data at stake/);
  assert.ok(!text.includes('F1: one'));
  assert.strictEqual(text.match(/F3: three/g).length, 1);
  const c = stateOf(root).chains[chain];
  assert.deepStrictEqual([c.closed, c.rev, c.findings.F2.label, c.findings.F2.status], [true, rev + 1, 'GAP', 'closed']);
  assert.deepStrictEqual(review.openChains(root), []);
  assert.deepStrictEqual(review.openBugs(root), []);
});

test('a failed state write never leaves a gap marked fixed, and a fallback round makes the next round start fresh', async () => {
  const { root, taskFile } = project('t6', { 'src/a.js': 'a0\n' });
  write(root, 'src/a.js', 'a1\n');
  setSpec([{ text: reviewAnswer([finding('gap one', 'src/a.js:1', { severity: 'LOW', label: 'GAP' }), finding('bug two', 'src/a.js:1')]) },
    { text: followAnswer([row('F1', 'RESOLVED'), row('F2', 'MAINTAIN')]) },
    { text: followAnswer([row('F1', 'MAINTAIN'), row('F2', 'MAINTAIN'), row('F3', 'MAINTAIN')]) }]); // (F3: the fallback's finding)
  const chain = await freshChain(root, taskFile, []);
  assert.ok(stateOf(root).chains[chain].codexSession);
  write(root, 'src/a.js', 'a2\n');
  const before = { state: JSON.stringify(stateOf(root)), gaps: gapsText(root) };
  const stateFile = state.files.project(root);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { // the state write that would record F1 as resolved fails
    if (to === stateFile && fs.readFileSync(from, 'utf8').includes('"resolved"')) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
    return realRename(from, to);
  };
  try {
    await assert.rejects(review.followup(root, { chain, responseFile: response('r2') }), /disk failure/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepStrictEqual({ ...stateOf(root), running: {} }, { ...JSON.parse(before.state), running: {} });
  assert.strictEqual(gapsText(root), before.gaps);
  assert.match(gapsText(root), /## G1 · open/);
  // (the failed round's bundle is the one not applied: attempt names can share a second, so their order proves nothing)
  const bundles = fs.readdirSync(path.join(state.projectDir(root), 'bundles')).filter(b => !(stateOf(root).applied || {})[b]);
  assert.strictEqual(bundles.length, 1);
  const failedRound = path.join(state.projectDir(root), 'bundles', bundles[0]);
  const answerFile = path.join(HOME, 't6-answer.json');
  fs.writeFileSync(answerFile, followAnswer([row('F1', 'MAINTAIN'), row('F2', 'MAINTAIN')], { findings: [finding('FALLBACK-ROUND', 'src/a.js:1')] }));
  assert.strictEqual(review.fallback(root, { bundle: failedRound, answerFile }).status, 'DONE');
  const c = stateOf(root).chains[chain];
  assert.deepStrictEqual([c.findings.F1.status, c.codexSession], ['open', null]);
  assert.match(gapsText(root), /## G1 · open/);
  write(root, 'src/a.js', 'a3\n');
  assert.strictEqual((await review.followup(root, { chain, responseFile: response('r3') })).status, 'DONE');
  const last = execCalls().slice(-1)[0];
  assert.notStrictEqual(last.args[1], 'resume');
  assert.match(last.prompt, /This review continues in a new session/);
  assert.match(last.prompt, /FALLBACK-ROUND/);
});

test('a chain keeps its own risky-review prerequisite when another chain escalates the same file', async () => {
  const { root, taskFile } = project('t7', { 'src/a.js': 'a0\n' });
  write(root, 'src/a.js', 'a1\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: { path: 'src/a.js', session: 'A', at: 1, baseline: null } }; });
  const wrong = reviewAnswer([finding('nowhere', 'src/elsewhere.js:1')]);
  const risky = { level: 'risky', files: ['src/a.js'], why: 'it moves money' };
  setSpec([{ text: wrong }, { text: wrong }, { text: reviewAnswer([], risky) }]);
  const old = await review.review(root, { session: 'A', taskFile });
  assert.strictEqual(old.status, 'NOT_DONE');
  const first = await review.review(root, { session: 'A', taskFile });
  assert.strictEqual(first.status, 'DONE', first.text);
  const answerFile = path.join(HOME, 't7-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer([], risky));
  const second = review.fallback(root, { bundle: old.bundle, answerFile });
  assert.strictEqual(second.status, 'DONE', second.text);
  const s = stateOf(root);
  assert.strictEqual(s.escalations[key('src/a.js')].chain, second.chain);
  const closing = review.close(root, { chain: first.chain, rev: s.chains[first.chain].rev, notes: {} });
  assert.strictEqual(closing.status, 'REFUSED');
  assert.match(closing.text, /src\/a\.js was rated risky in this chain/);
});

const GAPS_BEFORE = '# Known gaps\n\nFindings left unfixed on purpose. Entries are never deleted, only marked fixed.\n\n## G1 · open · 2026-10-01 · LOW\n- Where: src/old.js\n- Problem: older\n';
const commitRefusal = root => {
  const denied = hook.handle('bash', { tool_input: { command: 'git commit -m x' }, cwd: root, session_id: 'A' });
  return denied ? denied.hookSpecificOutput.permissionDecisionReason : null;
};

test('crosscheck\'s own gap additions, fixes and close dispositions stay acknowledged, so the commit goes through', async () => {
  const { root, taskFile } = project('t8', { 'src/a.js': 'a0\n', [gaps.NAME]: GAPS_BEFORE });
  seed(root, s => { s.acks = { [key(gaps.NAME)]: sha(GAPS_BEFORE) }; });
  write(root, 'src/a.js', 'a1\n');
  const gap = finding('odd name', 'src/a.js:1', { severity: 'LOW', label: 'GAP' });
  setSpec([{ text: reviewAnswer([gap, finding('off by one', 'src/a.js:1')]) }, { text: followAnswer([row('F1', 'RESOLVED'), row('F2', 'MAINTAIN')]) }]);
  const acknowledged = what => {
    const s = stateOf(root);
    assert.strictEqual(s.acks[key(gaps.NAME)], sha(gapsText(root)), `${what}: the gaps file as written is acknowledged`);
    assert.ok(!s.changes[key(gaps.NAME)], `${what}: and not pending`);
    assert.match(gapsText(root), /## G1 · open · 2026-10-01 · LOW\n- Where: src\/old\.js\n- Problem: older\n/, `${what}: the older entry stays`);
  };
  const chain = await freshChain(root, taskFile, []);
  assert.match(gapsText(root), /## G2 · open · .*\n[^#]*- Problem: F1: odd name/);
  acknowledged('a review');
  assert.strictEqual((await review.followup(root, { chain, responseFile: response('renamed it') })).status, 'DONE');
  assert.match(gapsText(root), /## G2 · fixed ·/);
  acknowledged('a follow-up');
  const closing = review.close(root, { chain, rev: stateOf(root).chains[chain].rev, notes: { F2: 'gap: the sum is only ever shown, never stored' } });
  assert.strictEqual(closing.status, 'DONE', closing.text);
  assert.match(gapsText(root), /## G3 · open · .*\n[^#]*- Problem: F2: off by one/);
  acknowledged('a close');
  assert.strictEqual(commitRefusal(root), null);
});

test('a follow-up refuses while another session has a pending change in a chain file, changing nothing', async () => {
  const { root, taskFile } = project('t9', { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n' });
  write(root, 'src/a.js', 'a1\n');
  write(root, 'src/b.js', 'b1\n');
  setSpec([{ text: reviewAnswer([finding('off by one', 'src/a.js:1')]) }, { text: followAnswer([row('F1', 'RESOLVED')]) }]);
  const chain = await freshChain(root, taskFile, [], { [key('src/b.js')]: { path: 'src/b.js', session: 'A', at: 2, baseline: null } });
  write(root, 'src/a.js', 'a2 by B\n');
  seed(root, s => { // (every file escalated too, so the follow-up would take none: the check still names B's file)
    s.changes[key('src/a.js')] = { path: 'src/a.js', session: 'B', at: 9, baseline: sha('a1\n') };
    s.escalations = { [key('src/a.js')]: { chain: 'C0', at: 1 }, [key('src/b.js')]: { chain: 'C0', at: 1 } };
  });
  const before = JSON.stringify(stateOf(root));
  const gapsBefore = fs.existsSync(path.join(root, gaps.NAME));
  const r = await review.followup(root, { chain, responseFile: response('fixed it') });
  assert.strictEqual(r.status, 'REFUSED');
  assert.match(r.text, /another session has pending changes in src\/a\.js/);
  assert.strictEqual(execCalls().length, 1, 'GPT is not asked');
  assert.strictEqual(JSON.stringify(stateOf(root)), before, 'B\'s record, the acknowledgements, the chain and the reservations are as they were');
  assert.strictEqual(fs.existsSync(path.join(root, gaps.NAME)), gapsBefore);
});

test('a follow-up that concedes a BUG because of the round limit is refused after its one repair, applying nothing', async () => {
  const { root, taskFile } = project('t10', { 'src/a.js': 'a0\n' });
  write(root, 'src/a.js', 'a1\n');
  const limit = { id: 'F1', status: 'CONCEDE', reason: 'The round limit was reached, so this stays unfixed' };
  setSpec([{ text: reviewAnswer([finding('off by one', 'src/a.js:1')]) }, { text: followAnswer([row('F1', 'MAINTAIN')]) }, { text: followAnswer([row('F1', 'MAINTAIN')]) },
    { text: followAnswer([limit]) }, { text: followAnswer([limit]) }]);
  const chain = await freshChain(root, taskFile, []);
  for (const v of ['a2\n', 'a3\n']) {
    write(root, 'src/a.js', v);
    assert.strictEqual((await review.followup(root, { chain, responseFile: response(v) })).status, 'DONE');
  }
  const before = JSON.stringify(stateOf(root));
  write(root, 'src/a.js', 'a4\n');
  const r = await review.followup(root, { chain, responseFile: response('past the limit') });
  assert.strictEqual(r.status, 'NOT_DONE', r.text);
  assert.match(r.text, /F1 is conceded because of the round limit/);
  const [answered, repair] = execCalls().slice(-2);
  assert.match(answered.prompt, /The round limit is reached/);
  assert.ok(repair.prompt.startsWith('Your answer has these problems') && repair.args[1] === 'resume');
  assert.strictEqual(JSON.stringify(stateOf(root)), before, 'F1 stays open, and the chain, acknowledgements and reservations are unchanged');
  assert.deepStrictEqual(review.openBugs(root).map(b => b.id), ['F1']);
});

// Test plan of this task: a follow-up names a file still at the chain's last round version instead of pasting it again.
const UNCHANGED = rel => new RegExp(`### ${rel.replace(/[./]/g, '\\$&')} \\(unchanged since the last round\\)\\n`);
const frozenCopy = (prompt, rel) => fs.readFileSync(prompt.match(new RegExp(`\\n- ${rel.replace(/[./]/g, '\\$&')}: (.+)\\n`))[1], 'utf8');
const lastPrompt = () => execCalls().slice(-1)[0].prompt;

test('follow-ups compare snapshots with the immediately preceding round before and after the limit', async () => {
  const { root, taskFile } = project('t11', { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n' });
  write(root, 'src/a.js', 'A-ONE\n');
  write(root, 'src/b.js', 'B-ONE\n');
  setSpec([{ text: reviewAnswer([finding('off by one', 'src/a.js:1')]) }, { text: followAnswer([row('F1', 'MAINTAIN')]) }]);
  const chain = await freshChain(root, taskFile, [], { [key('src/b.js')]: { path: 'src/b.js', session: 'A', at: 2, baseline: null } });
  const rounds = [['src/a.js', 'A-TWO\n', /-A-ONE\n\+A-TWO/, 'src/b.js', 'B-ONE'], ['src/b.js', 'B-TWO\n', /-B-ONE\n\+B-TWO/, 'src/a.js', 'A-TWO'],
    ['src/a.js', 'A-ONE\n', /-A-TWO\n\+A-ONE/, 'src/b.js', 'B-TWO']]; // (the last one past the limit, back to round 1's bytes)
  for (const [i, [changed, text, diff, same, sameText]] of rounds.entries()) {
    write(root, changed, text);
    const r = await review.followup(root, { chain, responseFile: response(`round ${i + 2}`) });
    assert.strictEqual(r.status, 'DONE', r.text);
    const p = lastPrompt();
    assert.match(p, new RegExp(`### ${changed.replace(/[./]/g, '\\$&')} \\(diff from its last reviewed version\\)`));
    assert.match(p, diff);
    assert.match(p, UNCHANGED(same));
    assert.doesNotMatch(p, new RegExp(`^${sameText}$`, 'm'), `round ${i + 2} doesn't paste ${same} again`);
    assert.strictEqual(frozenCopy(p, same), `${sameText}\n`, 'its frozen copy is still listed');
    assert.strictEqual(/The round limit is reached/.test(p), i === 2);
    assert.deepStrictEqual([stateOf(root).chains[chain].rev, stateOf(root).chains[chain].rounds.length], [i + 2, i + 2]);
  }
});

test('a changed binary file remains visible when the diff is empty past the round limit', async () => {
  const { root, taskFile } = project('t12', { 'src/a.js': 'a0\n' });
  write(root, 'src/a.js', '// \0 marker\nconst v = 1;\n');
  setSpec([{ text: reviewAnswer([finding('off by one', 'src/a.js:2')]) }, { text: followAnswer([row('F1', 'MAINTAIN')]) }]);
  const chain = await freshChain(root, taskFile, []);
  for (const v of ['r2', 'r3']) assert.strictEqual((await review.followup(root, { chain, responseFile: response(v) })).status, 'DONE');
  write(root, 'src/a.js', '// \0 marker\nconst v = 2;\n'); // (git reports only "Binary files differ": no diff text)
  assert.strictEqual((await review.followup(root, { chain, responseFile: response('changed it') })).status, 'DONE');
  const p = lastPrompt();
  assert.match(p, /The round limit is reached/);
  assert.match(p, /### src\/a\.js \(whole file\)\n```\n\/\/ \0 marker\nconst v = 2;\n/);
  assert.doesNotMatch(p, UNCHANGED('src/a.js'));
  assert.strictEqual(frozenCopy(p, 'src/a.js'), '// \0 marker\nconst v = 2;\n');
});

test('the fallback bundle preserves instructions and frozen context for unchanged files', async () => {
  const { root, taskFile } = project('t13', { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n' });
  write(root, 'src/a.js', 'A-ONE\n');
  write(root, 'src/b.js', 'calls a\n');
  setSpec([{ text: reviewAnswer([finding('off by one', 'src/a.js:1')]) }, { fail: 'error: stream disconnected', code: 1 }]);
  const chain = await freshChain(root, taskFile, [], { [key('src/b.js')]: { path: 'src/b.js', session: 'A', at: 2, baseline: null } });
  write(root, 'src/b.js', 'calls a twice\n');
  fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace('R2. Keeps the sum.', 'R2. Keeps the sum, rounded.'));
  const r = await review.followup(root, { chain, responseFile: response('b now calls a twice') });
  assert.strictEqual(r.status, 'GPT_UNAVAILABLE', r.text);
  const bundled = fs.readFileSync(path.join(r.bundle, 'prompt.md'), 'utf8');
  assert.match(bundled, UNCHANGED('src/a.js'));
  assert.match(bundled, /read its frozen copy whenever an open finding, a changed requirement or a caller needs it/);
  assert.match(bundled, /- F1 \[MEDIUM BUG\] off by one/);
  assert.match(bundled, /## Changed requirements\nR2\. Keeps the sum, rounded\.\n/);
  assert.match(bundled, /-calls a\n\+calls a twice/);
  assert.strictEqual(frozenCopy(bundled, 'src/a.js'), 'A-ONE\n');
  write(root, 'src/a.js', 'A-LIVE\n'); // (edited after the bundle was frozen)
  const answerFile = path.join(HOME, 't13-answer.json');
  fs.writeFileSync(answerFile, followAnswer([row('F1', 'MAINTAIN')], { rows: ['R2'] }));
  const done = review.fallback(root, { bundle: r.bundle, answerFile });
  assert.strictEqual(done.status, 'DONE', done.text);
  assert.strictEqual(frozenCopy(bundled, 'src/a.js'), 'A-ONE\n', 'the snapshot keeps its bytes');
  const s = stateOf(root);
  assert.strictEqual(s.chains[chain].findings.F1.status, 'open');
  assert.deepStrictEqual([s.acks[key('src/a.js')], s.changes[key('src/a.js')].baseline], [sha('A-ONE\n'), sha('A-ONE\n')], 'the live edit stays pending');
  assert.strictEqual(s.acks[key('src/b.js')], sha('calls a twice\n'));
});

test('deletion and recreation retain their review material across follow-up rounds', async () => {
  const { root, taskFile } = project('t14', { 'src/a.js': 'a0\n', 'src/b.js': 'b0\n' });
  write(root, 'src/a.js', 'A-ONE\n');
  write(root, 'src/b.js', 'B-ONE\n');
  setSpec([{ text: reviewAnswer([finding('off by one', 'src/b.js:1')]) }, { text: followAnswer([row('F1', 'MAINTAIN')]) }]);
  const chain = await freshChain(root, taskFile, [], { [key('src/b.js')]: { path: 'src/b.js', session: 'A', at: 2, baseline: null } });
  const frozenA = () => stateOf(root).chains[chain].frozen[key('src/a.js')];
  const versions = [frozenA()];
  const prompts = [];
  for (const step of [() => fs.rmSync(path.join(root, 'src/a.js')), () => write(root, 'src/b.js', 'B-TWO\n'), () => write(root, 'src/a.js', 'A-ONE\n')]) {
    step();
    assert.strictEqual((await review.followup(root, { chain, responseFile: response('next') })).status, 'DONE');
    prompts.push(lastPrompt());
    versions.push(frozenA());
  }
  assert.match(prompts[0], /### src\/a\.js \(deleted\)\nIts last version:\n```\nA-ONE\n/);
  assert.match(prompts[1], /### src\/a\.js \(deleted\)\nNo earlier version is known\./);
  assert.match(prompts[2], /### src\/a\.js \(new file, whole\)\n```\nA-ONE\n/);
  for (const p of prompts) assert.doesNotMatch(p, UNCHANGED('src/a.js'));
  assert.deepStrictEqual(versions, [sha('A-ONE\n'), 'deleted', 'deleted', sha('A-ONE\n')]);
});

test('a first-round paired audit still reads unchanged code in full', async () => {
  const { root, taskFile } = project('t15', { 'src/pay.js': 'PAY-ONE\npay line 2\n' });
  const reqHash = sha('R1. Adds numbers.\nR2. Keeps the sum.');
  seed(root, s => { s.plans = { [key('src/pay.js')]: { task: state.pathKey(path.resolve(taskFile)), reqHash, cases: [{ id: 'T1', text: 'a refund runs once', test: 'tests/t.test.js' }], tests: [], at: 1 } }; });
  const clean = session => ({ text: reviewAnswer([]), session });
  fs.writeFileSync(SPEC, JSON.stringify({ byPrompt: [
    { match: 'Cross-check (you are reviewer A)', answers: [{ text: JSON.stringify({ marks: [] }), session: 'sess-A' }] },
    { match: 'Cross-check (you are reviewer B)', answers: [{ text: JSON.stringify({ marks: [] }), session: 'sess-B' }] },
    { match: 'reviewer A. Check', answers: [clean('sess-A')] },
    { match: 'reviewer B. Attack', answers: [clean('sess-B')] },
  ] }));
  fs.rmSync(LOG, { force: true });
  const r = await review.review(root, { session: 'A', taskFile, files: ['src/pay.js'], full: true, risky: true });
  assert.strictEqual(r.status, 'DONE', r.text);
  const reviewers = execCalls().filter(c => c.args[1] !== 'resume'); // (the cross-checks resume the reviewers' sessions)
  assert.strictEqual(reviewers.length, 2);
  for (const c of reviewers) {
    assert.match(c.prompt, /### src\/pay\.js \(whole file\)\n```\nPAY-ONE\npay line 2\n/);
    assert.doesNotMatch(c.prompt, /unchanged since the last round/);
  }
  const s = stateOf(root);
  assert.deepStrictEqual([s.acks[key('src/pay.js')], !!s.riskyReviews[key('src/pay.js')], s.escalations[key('src/pay.js')], s.chains[r.chain].rounds.length],
    [sha('PAY-ONE\npay line 2\n'), true, undefined, 1]);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
