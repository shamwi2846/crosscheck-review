// Tests for paired reviews that don't complete: an incomplete pair records nothing, a fallback answer never counts as
// a pair, and a risky file stays escalated and pending until a completed pair reads it (part of test plan P1 of step
// 3, with pair.test.js). Codex is the recording stub, its answers pinned per reviewer and step.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HOME, review, pair, sha, execCalls, stateOf, seed, key, write, response, project, finding, reviewAnswer, marks, followAnswer,
  setPair, plan, pending } = require('./pair-fixture');

test('a failed cross-check applies nothing, and a fallback answer cannot certify a pair', async () => {
  const p = project('t1', { 'src/pay.mqh': 'v0\n' });
  write(p.root, 'src/pay.mqh', 'v1\n');
  seed(p.root, s => {
    s.changes = { [key('src/pay.mqh')]: pending('src/pay.mqh') };
    s.plans = { [key('src/pay.mqh')]: plan(p) };
    s.escalations = { [key('src/pay.mqh')]: { chain: 'C0', at: 1 } };
    s.chains = { C0: { rev: 1, began: Date.now() - 60000, rounds: [], closed: false, files: { [key('src/pay.mqh')]: 'src/pay.mqh' }, frozen: {}, findings: {}, risky: { [key('src/pay.mqh')]: 1 } } };
  });
  const bad = marks([['B1', 'CONFIRM'], ['B1', 'CONFIRM'], ['B9', 'CONFIRM'], ['B2', 'SAME_AS', 'A7'], ['B3', 'DISPUTE', null, '  ']]);
  setPair({ A: [reviewAnswer([finding('stop loss missing', 'src/pay.mqh:1')])], B: [reviewAnswer([finding('b1', 'src/pay.mqh:1'), finding('b2', 'src/pay.mqh:1'), finding('b3', 'src/pay.mqh:1'), finding('b4', 'src/pay.mqh:1')])],
    xA: [bad, marks([['B1', 'CONFIRM'], ['B2', 'CONFIRM'], ['B3', 'CONFIRM'], ['B4', 'CONFIRM']])], xB: [{ fail: 'error: no such session', code: 1 }] });
  const before = JSON.stringify(stateOf(p.root));
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  const calls = execCalls();
  const xA = calls.filter(c => c.prompt.includes('Cross-check (you are reviewer A)') || c.prompt.startsWith('Your answer has these problems'));
  assert.ok(xA.length >= 2 && xA.every(c => c.args[1] === 'resume' && c.args.includes('sess-A')));
  const xB = calls.filter(c => c.prompt.includes('Cross-check (you are reviewer B)'));
  assert.ok(xB.length >= 1 && xB.every(c => c.args[1] === 'resume' && c.args.includes('sess-B')));
  assert.ok(!calls.some(c => c.args[1] !== 'resume' && c.prompt.includes('Cross-check')), 'a cross-check never starts a fresh session');
  const empty = { acks: {}, running: {}, applied: {}, skips: {}, needsPlan: {}, riskyReviews: {}, riskyVersions: {} }; // (the maps admission adds)
  assert.deepStrictEqual({ ...stateOf(p.root), running: {} }, { ...empty, ...JSON.parse(before) });
  assert.ok(fs.existsSync(path.join(r.bundle, 'manifest.json')));
  const answerFile = path.join(HOME, 't1-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer());
  const fb = review.fallback(p.root, { bundle: r.bundle, answerFile });
  assert.strictEqual(fb.status, 'DONE', fb.text);
  const s = stateOf(p.root);
  assert.deepStrictEqual(s.riskyReviews, {});
  assert.ok(s.escalations[key('src/pay.mqh')]);
  assert.ok(!s.chains[fb.chain].paired);
  const closing = review.close(p.root, { chain: 'C0', rev: 1, notes: {} });
  assert.strictEqual(closing.status, 'REFUSED');
  assert.match(closing.text, /src\/pay\.mqh was rated risky in this chain/);
});

test('a fallback chain keeps its trading file risky: its own pair comes first, and a follow-up rated normal then still needs its plan, at xhigh', async () => {
  const p = project('t1b', { 'src/EA.mq5': 'e0\n' });
  write(p.root, 'src/EA.mq5', 'e1\n');
  seed(p.root, s => { s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') }; s.skips = { [key('src/EA.mq5')]: { task: p.task, reqHash: p.reqHash, why: 'w' } }; });
  setPair({ A: [reviewAnswer()], B: [{ fail: 'error: no such session', code: 1 }] });
  // (marked risky: a trading file whose task skipped its plan otherwise gets the normal review)
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  const answerFile = path.join(HOME, 't1b-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer());
  const fb = review.fallback(p.root, { bundle: r.bundle, answerFile });
  assert.strictEqual(fb.status, 'DONE', fb.text);
  assert.ok(stateOf(p.root).changes[key('src/EA.mq5')], 'without a completed pair it stays pending');
  assert.match((await review.followup(p.root, { chain: fb.chain, responseFile: response('nothing changed') })).text, /every file of the chain is escalated/);
  // (the fresh follow-up's history holds reviewer A's prompt, so the stub routes it to A's answers)
  setPair({ A: [reviewAnswer(), followAnswer()], B: [reviewAnswer()] });
  assert.strictEqual((await review.review(p.root, { session: 'A', taskFile: p.taskFile })).status, 'DONE');
  assert.strictEqual(stateOf(p.root).acks[key('src/EA.mq5')], sha('e1\n'), 'its pair completed: acknowledged with its skip');
  write(p.root, 'src/EA.mq5', 'e2\n');
  const f1 = await review.followup(p.root, { chain: fb.chain, responseFile: response('tightened it') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  assert.strictEqual(stateOf(p.root).acks[key('src/EA.mq5')], sha('e2\n'));
  assert.ok(execCalls().some(c => c.prompt.includes('This is a follow-up round') && c.args.includes('model_reasoning_effort=xhigh')));
  // (new requirements leave the skip stale: the chain's last rating was normal, but its trading file still needs a plan)
  fs.writeFileSync(p.taskFile, fs.readFileSync(p.taskFile, 'utf8').replace('R2. Keeps the lot within limits.', 'R2. Keeps the lot within the new limits.'));
  write(p.root, 'src/EA.mq5', 'e3\n');
  const f2 = await review.followup(p.root, { chain: fb.chain, responseFile: response('changed again') });
  assert.strictEqual(f2.status, 'REFUSED', 'a normal rating never drops the plan it needs');
  assert.match(f2.text, /test plan first: no current test plan for this task: src\/EA\.mq5 \(/);
});

test('a planned trading file stays pending after a fallback until a pair completes, and the fallback chain\'s follow-up keeps that acknowledgement', async () => {
  const p = project('t1c', { 'src/EA.mq5': 'e0\n' });
  write(p.root, 'src/EA.mq5', 'e1\n');
  seed(p.root, s => { s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') }; s.plans = { [key('src/EA.mq5')]: plan(p) }; });
  setPair({ A: [reviewAnswer()], B: [{ fail: 'error: no such session', code: 1 }] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  const waiting = what => {
    const s = stateOf(p.root);
    assert.deepStrictEqual([s.acks[key('src/EA.mq5')], s.changes[key('src/EA.mq5')], s.riskyReviews[key('src/EA.mq5')]],
      [undefined, pending('src/EA.mq5'), undefined], `${what}: still pending, its baseline kept, no paired receipt`);
  };
  waiting('the incomplete pair');
  seed(p.root, s => { delete s.escalations[key('src/EA.mq5')]; }); // (as a driver from before admission escalated risky files left it)
  const answerFile = path.join(HOME, 't1c-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer([finding('a loose lot check', 'src/EA.mq5:1', { severity: 'LOW', label: 'GAP' })]));
  const fb = review.fallback(p.root, { bundle: r.bundle, answerFile });
  assert.strictEqual(fb.status, 'DONE', fb.text);
  assert.ok(stateOf(p.root).chains[fb.chain].findings.F1, 'the fallback\'s finding is recorded');
  waiting('the fallback');
  assert.ok(stateOf(p.root).escalations[key('src/EA.mq5')], 'it needs its own paired review');
  assert.match((await review.followup(p.root, { chain: fb.chain, responseFile: response('tightened it') })).text, /every file of the chain is escalated/);
  waiting('a refused single follow-up');
  setPair({ A: [reviewAnswer(), followAnswer([{ id: 'F1', status: 'RESOLVED', reason: 'the lot check is tightened' }])], B: [reviewAnswer()] });
  const paired = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(paired.status, 'DONE', paired.text);
  const acknowledged = what => {
    const s = stateOf(p.root);
    assert.deepStrictEqual([s.acks[key('src/EA.mq5')], s.changes[key('src/EA.mq5')], s.escalations[key('src/EA.mq5')]], [sha('e1\n'), undefined, undefined], what);
  };
  acknowledged('a completed pair acknowledges it');
  assert.ok(stateOf(p.root).riskyReviews[key('src/EA.mq5')]);
  const f1 = await review.followup(p.root, { chain: fb.chain, responseFile: response('tightened it') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  acknowledged('the fallback chain\'s follow-up leaves the acknowledgement as it is');
  assert.strictEqual(review.close(p.root, { chain: fb.chain, rev: stateOf(p.root).chains[fb.chain].rev, notes: {} }).status, 'DONE');
});

test('a file reviewed as risky by hand still needs a pair after a fallback, in a later ordinary review too', async () => {
  const p = project('t1d', { 'src/payments.js': 'p0\n' });
  write(p.root, 'src/payments.js', 'p1\n');
  seed(p.root, s => { // (its earlier version was reviewed: that acknowledgement must stay as it is until a pair covers p1)
    s.acks = { [key('src/payments.js')]: sha('p0\n') };
    s.changes = { [key('src/payments.js')]: pending('src/payments.js') };
    s.plans = { [key('src/payments.js')]: plan(p) };
  });
  const both = [finding('a refund can run twice', 'src/payments.js:1')];
  setPair({ A: [reviewAnswer(both)], B: [reviewAnswer(both)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [{ fail: 'error: no such session', code: 1 }] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  assert.deepStrictEqual(Object.keys(stateOf(p.root).chains), [], 'the incomplete pair applies nothing');
  const answerFile = path.join(HOME, 't1d-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer([finding('a refund can run twice', 'src/payments.js:1', { severity: 'LOW', label: 'GAP' })]));
  const fb = review.fallback(p.root, { bundle: r.bundle, answerFile });
  assert.strictEqual(fb.status, 'DONE', fb.text);
  let s = stateOf(p.root);
  assert.ok(s.chains[fb.chain].findings.F1, 'the fallback\'s finding is recorded');
  assert.deepStrictEqual([s.acks[key('src/payments.js')], s.changes[key('src/payments.js')], s.riskyReviews[key('src/payments.js')]],
    [sha('p0\n'), pending('src/payments.js'), undefined], 'the fallback alone acknowledges nothing and grants no receipt');
  assert.ok(!s.chains[fb.chain].paired);
  assert.match((await review.followup(p.root, { chain: fb.chain, responseFile: response('nothing yet') })).text, /every file of the chain is escalated/, 'its single follow-up is refused');
  setPair({ A: [reviewAnswer(both)], B: [reviewAnswer(both)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [marks([['A1', 'SAME_AS', 'B1']])] });
  const later = await review.review(p.root, { session: 'A', taskFile: p.taskFile }); // (no --risky this time)
  assert.strictEqual(later.status, 'DONE', later.text);
  assert.ok(execCalls().some(c => c.prompt.includes('reviewer B. Attack')) && execCalls().some(c => c.prompt.includes('Cross-check (you are reviewer B)')), 'it is reviewed as a pair, cross-checks included');
  s = stateOf(p.root);
  assert.deepStrictEqual([s.acks[key('src/payments.js')], s.changes[key('src/payments.js')], s.escalations[key('src/payments.js')]], [sha('p1\n'), undefined, undefined]);
});

test('a risky review whose pair didn\'t complete is paired again on a plain retry, and acknowledges nothing before that', async () => {
  const p = project('t1e', { 'src/payments.js': 'p0\n' });
  write(p.root, 'src/payments.js', 'p1\n');
  seed(p.root, s => { s.changes = { [key('src/payments.js')]: pending('src/payments.js') }; s.plans = { [key('src/payments.js')]: plan(p) }; });
  const both = [finding('a refund can run twice', 'src/payments.js:1')];
  setPair({ A: [reviewAnswer(both)], B: [reviewAnswer(both)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [{ fail: 'error: no such session', code: 1 }] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  let s = stateOf(p.root);
  assert.ok(s.escalations[key('src/payments.js')] && !s.acks[key('src/payments.js')] && s.changes[key('src/payments.js')], 'it now needs its own paired review');
  setPair({ A: [reviewAnswer(both)], B: [reviewAnswer(both)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [marks([['A1', 'SAME_AS', 'B1']])] });
  const retry = await review.review(p.root, { session: 'A', taskFile: p.taskFile }); // (no --risky this time)
  assert.strictEqual(retry.status, 'DONE', retry.text);
  assert.ok(execCalls().some(c => c.prompt.includes('reviewer B. Attack')), 'the retry is a pair');
  s = stateOf(p.root);
  assert.deepStrictEqual([s.acks[key('src/payments.js')], s.escalations[key('src/payments.js')]], [sha('p1\n'), undefined], 'only the completed pair acknowledges it');
});

test('when only GPT B\'s first review fails, B alone runs again beside A\'s: A\'s BUG stays open, nothing counts before B is done, and B\'s failed turns are set aside', async () => {
  const { waitFor } = require('./pair-fixture');
  const p = project('t9r', { 'src/payments.js': 'p0\n' });
  write(p.root, 'src/payments.js', 'p1\n');
  const k = key('src/payments.js');
  seed(p.root, s => { s.changes = { [k]: pending('src/payments.js') }; s.acks = { [k]: 'the last reviewed version' }; s.plans = { [k]: plan(p) }; });
  const bug = reviewAnswer([finding('a refund can be paid twice', 'src/payments.js:1', { severity: 'HIGH', test: 'pay once' })]);
  const hold = fs.mkdtempSync(path.join(HOME, 't9r-hold-'));
  // (B's first answer and its repair are both unusable; its new try is held, finds nothing and confirms A's BUG)
  setPair({ A: [bug], B: ['B-FAILED not JSON', 'B-FAILED still not JSON', { text: reviewAnswer(), hold }], xB: [marks([['A1', 'CONFIRM']])] });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  await waitFor(path.join(hold, 'started'));
  const meanwhile = stateOf(p.root);
  assert.deepStrictEqual([meanwhile.acks[k], !!meanwhile.changes[k], (meanwhile.riskyReviews || {})[k]], ['the last reviewed version', true, undefined], 'nothing counts while B runs again');
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  const fresh = execCalls().filter(c => c.args[1] !== 'resume');
  assert.deepStrictEqual(['reviewer A. Check', 'reviewer B. Attack'].map(m => fresh.filter(c => c.prompt.includes(m)).length), [1, 2], 'A once; B\'s failed review and its one new try');
  assert.ok(stateOf(p.root).riskyReviews[k], 'the completed pair counts');
  assert.deepStrictEqual(review.openBugs(p.root).map(f => [f.title, f.label]), [['a refund can be paid twice', 'BUG']], 'A\'s BUG stays open, so a commit is refused');
  const names = fs.readdirSync(r.bundle);
  assert.ok(names.some(f => f.startsWith('discarded-')), 'B\'s failed turns were set aside');
  assert.ok(names.filter(f => f.startsWith('turn-')).every(f => !fs.readFileSync(path.join(r.bundle, f), 'utf8').includes('B-FAILED')), 'no replayed turn holds them');
});

test('an unavailable reviewer leaves the pair incomplete, saying GPT was unavailable', async () => {
  const ok = { status: 'OK', answer: JSON.parse(reviewAnswer()), session: 's' };
  const r = await pair.runPair({ prompt: 'p', materialize: () => [],
    runOne: async (prompt, o) => (o.label === '1-B' ? { status: 'GPT_UNAVAILABLE', why: 'usage limit' } : ok) });
  assert.deepStrictEqual([r.status, r.unavailable], ['PAIR_INCOMPLETE', true]);
  assert.match(r.why, /reviewer B's review didn't complete \(usage limit\)/);
  const both = await pair.runPair({ prompt: 'p', materialize: () => [], runOne: async (prompt, o) => (o.label === '1-A'
    ? { status: 'NOT_DONE', why: 'still invalid after its repair' } : { status: 'GPT_UNAVAILABLE', why: 'timeout' }) });
  assert.deepStrictEqual([both.status, both.unavailable], ['PAIR_INCOMPLETE', true], 'A\'s bad answer doesn\'t hide that B\'s GPT was down');
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('Muse failing in its cross-check is replaced by a complete GPT pair before a risky file counts as reviewed, and follow-ups stay GPT\'s', async () => {
  const { state, waitFor } = require('./pair-fixture');
  const museSpec = path.join(HOME, 'muse-spec.json');
  const museLog = path.join(HOME, 'muse-calls.jsonl');
  Object.assign(process.env, { FAKE_MUSE_SPEC: museSpec, FAKE_MUSE_LOG: museLog });
  const config = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...config, museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')], museVerified: '9.9.9-test', museSkills: ['bundled:git'] }));
  assert.ok(state.update(state.files.global(), g => { g.muse = true; }).ok);
  const museRuns = () => fs.readFileSync(museLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(c => c.args && c.args[0] === 'exec' && c.args.includes('meta')).length;
  const p = project('t9m', { 'src/payments.js': 'p0\n' });
  write(p.root, 'src/payments.js', 'p1\n');
  const k = key('src/payments.js');
  seed(p.root, s => {
    s.changes = { [k]: pending('src/payments.js') };
    s.acks = { [k]: 'the last reviewed version' };
    s.plans = { [k]: plan(p) };
    s.escalations = { [k]: { chain: null, at: 1 } }; // (risky: its review is a pair)
  });
  const bug = reviewAnswer([finding('a refund can be paid twice', 'src/payments.js:1', { severity: 'HIGH', test: 'pay once' })]);
  const hold = fs.mkdtempSync(path.join(HOME, 't9m-hold-'));
  setPair({ A: [bug, bug], B: [{ text: reviewAnswer(), hold }], xA: [marks([['B1', 'CONFIRM']]), marks([])], xB: [marks([['A1', 'CONFIRM']])] });
  // (Muse's first answer needs its repair, so its turns outnumber the redo's and one would stay unless set aside)
  fs.writeFileSync(museSpec, JSON.stringify({ exec: [{ text: 'not JSON' }, { text: reviewAnswer([finding('MUSE-ONLY refund race', 'src/payments.js:1')]) },
    { fail: 'usage limit reached for this subscription' }] }));
  fs.rmSync(museLog, { force: true });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile });
  await waitFor(path.join(hold, 'started')); // (the replacement GPT B is reviewing)
  const meanwhile = stateOf(p.root);
  assert.deepStrictEqual([meanwhile.acks[k], !!meanwhile.changes[k], !!meanwhile.escalations[k], (meanwhile.riskyReviews || {})[k]],
    ['the last reviewed version', true, true, undefined], 'nothing counts while the replacement pair runs');
  const shared = state.read(state.files.global()).data;
  assert.ok(shared.museCooldownUntil > Date.now() && !(shared.cooldownUntil > Date.now()), 'Muse cools down; GPT stays available');
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  assert.match(r.text, /Muse didn't take part: its cross-check didn't complete \(usage limit reached/);
  const s = stateOf(p.root);
  assert.ok(s.riskyReviews[k] && !s.escalations[k], 'the completed GPT pair counts');
  const findings = Object.values(s.chains[r.chain].findings);
  assert.deepStrictEqual(findings.map(f => [f.title, f.label]), [['a refund can be paid twice', 'BUG']], 'the BUG stands; Muse\'s finding went with its run');
  const turns = fs.readdirSync(r.bundle).filter(f => f.startsWith('turn-'));
  assert.ok(turns.length && turns.every(f => !fs.readFileSync(path.join(r.bundle, f), 'utf8').includes('MUSE-ONLY')), 'no replayed turn holds the abandoned run');
  const before = museRuns();
  setPair({ follow: [followAnswer([{ id: 'F1', status: 'MAINTAIN', reason: 'not fixed yet' }])] });
  const f = await review.followup(p.root, { chain: r.chain, responseFile: response('nothing yet') });
  assert.strictEqual(f.status, 'DONE', f.text);
  assert.strictEqual(museRuns(), before, 'a follow-up never runs Muse');
  const followups = execCalls().filter(c => c.prompt.includes('This is a follow-up round'));
  assert.ok(followups.length === 1 && followups[0].args[1] === 'resume' && followups[0].args.includes('sess-A'), 'one GPT, resuming reviewer A');
  assert.ok(state.update(state.files.global(), g => { delete g.muse; delete g.museCooldownUntil; }).ok);
});

test('when GPT A\'s and Muse\'s cross-checks both fail, a normal review is still redone without Muse, and says why', async () => {
  const { state, waitFor } = require('./pair-fixture'); // eslint-disable-line no-unused-vars
  const museSpec = path.join(HOME, 'muse-spec-2.json');
  const museLog = path.join(HOME, 'muse-calls-2.jsonl');
  Object.assign(process.env, { FAKE_MUSE_SPEC: museSpec, FAKE_MUSE_LOG: museLog });
  const config = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...config, museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')], museVerified: '9.9.9-test', museSkills: ['bundled:git'] }));
  assert.ok(state.update(state.files.global(), g => { g.muse = true; delete g.museCooldownUntil; }).ok);
  const p = project('t9n', { 'src/notes.js': 'n0\n' });
  write(p.root, 'src/notes.js', 'n1\n');
  seed(p.root, s => { s.changes = { [key('src/notes.js')]: pending('src/notes.js') }; });
  const found = reviewAnswer([finding('a note can be lost', 'src/notes.js:1')]);
  setPair({ A: [found], xA: [{ fail: 'error: no such session', code: 1 }], single: [reviewAnswer()] });
  fs.writeFileSync(museSpec, JSON.stringify({ exec: [{ text: found }, { fail: 'usage limit reached for this subscription' }] }));
  fs.rmSync(museLog, { force: true });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  assert.match(r.text, /Muse didn't take part: its cross-check didn't complete \(usage limit reached/);
  assert.strictEqual(execCalls().filter(c => c.prompt.includes('You review a code change') && !/reviewer [AB]\./.test(c.prompt)).length, 1, 'redone as one GPT review');
  assert.ok(state.update(state.files.global(), g => { delete g.muse; delete g.museCooldownUntil; }).ok);
});

test('when GPT A and Muse both fail their first review, a normal review hands its bundle on as GPT unavailable, and says why Muse is missing', async () => {
  const { state } = require('./pair-fixture');
  const museSpec = path.join(HOME, 'muse-spec-3.json');
  const museLog = path.join(HOME, 'muse-calls-3.jsonl');
  Object.assign(process.env, { FAKE_MUSE_SPEC: museSpec, FAKE_MUSE_LOG: museLog });
  const config = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...config, museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')], museVerified: '9.9.9-test', museSkills: ['bundled:git'] }));
  assert.ok(state.update(state.files.global(), g => { g.muse = true; delete g.museCooldownUntil; }).ok);
  const p = project('t9o', { 'src/notes.js': 'n0\n' });
  write(p.root, 'src/notes.js', 'n1\n');
  seed(p.root, s => { s.changes = { [key('src/notes.js')]: pending('src/notes.js') }; });
  setPair({ A: [{ fail: 'error: the service is down', code: 1 }] });
  fs.writeFileSync(museSpec, JSON.stringify({ exec: [{ fail: 'the model is overloaded' }, { fail: 'the model is overloaded' }] }));
  fs.rmSync(museLog, { force: true });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.ok(r.unavailable && r.bundle && fs.existsSync(path.join(r.bundle, 'manifest.json')), `the fallback reviewer gets the bundle: ${r.status} ${r.text}`);
  assert.match(r.text, /Muse didn't take part: its review didn't complete \(the model is overloaded\)/);
  assert.ok(state.update(state.files.global(), g => { delete g.muse; delete g.museCooldownUntil; }).ok);
});
