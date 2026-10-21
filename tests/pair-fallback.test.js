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
  const empty = { acks: {}, running: {}, applied: {}, skips: {}, needsPlan: {}, riskyReviews: {} }; // (the maps admission adds)
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
  seed(p.root, s => { s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') }; });
  setPair({ A: [reviewAnswer()], B: [{ fail: 'error: no such session', code: 1 }] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  const answerFile = path.join(HOME, 't1b-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer());
  const fb = review.fallback(p.root, { bundle: r.bundle, answerFile });
  assert.strictEqual(fb.status, 'DONE', fb.text);
  assert.ok(stateOf(p.root).changes[key('src/EA.mq5')], 'without a plan it stays pending');
  assert.match((await review.followup(p.root, { chain: fb.chain, responseFile: response('nothing changed') })).text, /every file of the chain is escalated/);
  // (the fresh follow-up's history holds reviewer A's prompt, so the stub routes it to A's answers)
  setPair({ A: [reviewAnswer(), followAnswer()], B: [reviewAnswer()] });
  assert.strictEqual((await review.review(p.root, { session: 'A', taskFile: p.taskFile })).status, 'DONE');
  assert.ok(stateOf(p.root).changes[key('src/EA.mq5')], 'its pair completed, but without a plan it stays pending');
  const f1 = await review.followup(p.root, { chain: fb.chain, responseFile: response('nothing changed') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  assert.ok(stateOf(p.root).changes[key('src/EA.mq5')], 'a normal rating never drops the plan it needs');
  assert.ok(execCalls().some(c => c.prompt.includes('This is a follow-up round') && c.args.includes('model_reasoning_effort=xhigh')));
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
