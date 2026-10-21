// Tests for review.js follow-ups, closing and the fallback: chains keep their ids, scope and history, a stale chain
// revision changes nothing, and nothing closes without a real reason (test plan P2 of step 2b; what a round shows GPT
// is in followup-material.test.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HOME, state, review, gaps, sha, setSpec, execCalls, waitFor, stateOf, seed, key, write, gapsText, project, finding, reviewAnswer,
  followAnswer, row, response, freshChain } = require('./followup-fixture');
const hook = require('../src/hook');

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

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
