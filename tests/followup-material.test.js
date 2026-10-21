// Tests for what a follow-up round shows GPT: diffs since the chain's last round, files still at that round's
// snapshot named rather than pasted again, and changed, deleted or re-created files never hidden (with
// followup.test.js; the narrow-round case is from test plan P2 of step 2b).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HOME, SPEC, LOG, state, review, gaps, sha, setSpec, execCalls, stateOf, seed, key, write, gapsText, project, finding, reviewAnswer,
  followAnswer, row, response, freshChain } = require('./followup-fixture');

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

// The test plan of follow-ups naming a file still at the chain's last round version instead of pasting it again.
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
