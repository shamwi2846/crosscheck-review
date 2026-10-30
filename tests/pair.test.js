// Tests for pair.js and paired reviews in review.js: a completed pair's merge is deterministic, its receipts free the
// files it read in full, and a risky file needs the test plan the reviewers saw (test plan P1 of step 3; pairs that
// don't complete and the fallback are in pair-fallback.test.js). Codex is the recording stub, its answers pinned per
// reviewer and step.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HOME, state, review, pair, answer, gaps, sha, execCalls, lookups, waitFor, stateOf, seed, key, write, response, project, finding, rows,
  reviewAnswer, marks, followAnswer, setPair, plan, pending } = require('./pair-fixture');

const GAPS_BEFORE = '# Known gaps\n\nFindings left unfixed on purpose. Entries are never deleted, only marked fixed.\n\n## G1 · open · 2026-10-01 · LOW\n- Where: src/old.js\n- Problem: older\n';
const gapsNow = root => fs.readFileSync(path.join(root, gaps.NAME), 'utf8');

test('a completed pair acknowledges a planned payments file, and its gap entries stay acknowledged through a follow-up and a close', async () => {
  const p = project('t1f', { 'src/payments.js': 'p0\n', [gaps.NAME]: GAPS_BEFORE });
  write(p.root, 'src/payments.js', 'p1\n');
  seed(p.root, s => { s.acks = { [key(gaps.NAME)]: sha(GAPS_BEFORE) }; s.changes = { [key('src/payments.js')]: pending('src/payments.js') }; s.plans = { [key('src/payments.js')]: plan(p) }; });
  const found = [finding('a refund can run twice', 'src/payments.js:1'), finding('odd name', 'src/payments.js:2', { severity: 'LOW', label: 'GAP' })];
  setPair({ A: [reviewAnswer(found)], B: [reviewAnswer(found)], xA: [marks([['B1', 'SAME_AS', 'A1'], ['B2', 'SAME_AS', 'A2']])], xB: [marks([['A1', 'SAME_AS', 'B1'], ['A2', 'SAME_AS', 'B2']])],
    follow: [followAnswer([{ id: 'F1', status: 'MAINTAIN', reason: 'refunds still repeat' }, { id: 'F2', status: 'RESOLVED', reason: 'renamed' }])] });
  const acknowledged = what => {
    const s = stateOf(p.root);
    assert.deepStrictEqual([s.acks[key(gaps.NAME)], s.changes[key(gaps.NAME)]], [sha(gapsNow(p.root)), undefined], what);
    assert.match(gapsNow(p.root), /- Problem: older/, `${what}: the older entry stays`);
  };
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  assert.strictEqual(r.status, 'DONE', r.text);
  const s = stateOf(p.root);
  assert.deepStrictEqual([s.acks[key('src/payments.js')], s.changes[key('src/payments.js')], !!s.riskyReviews[key('src/payments.js')]], [sha('p1\n'), undefined, true]);
  assert.match(gapsNow(p.root), /- Problem: F2: odd name/);
  acknowledged('the pair');
  assert.strictEqual((await review.followup(p.root, { chain: r.chain, responseFile: response('renamed it') })).status, 'DONE');
  assert.match(gapsNow(p.root), /· fixed ·/);
  acknowledged('a follow-up');
  assert.strictEqual(review.close(p.root, { chain: r.chain, rev: stateOf(p.root).chains[r.chain].rev, notes: { F1: 'gap: refunds are switched off in this build' } }).status, 'DONE');
  assert.match(gapsNow(p.root), /- Problem: F1: a refund can run twice/);
  acknowledged('a close');
});

test('a review and its follow-up each look the docs server up once, and every run of the attempt gets that one', async () => {
  const p = project('t1d', { 'src/EA.mq5': 'e0\n' });
  write(p.root, 'src/EA.mq5', 'e1\n');
  seed(p.root, s => { s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') }; s.plans = { [key('src/EA.mq5')]: plan(p) }; });
  // (each lookup answers a newer version, as a docs server that updates itself would)
  const entry = v => ({ out: JSON.stringify({ name: 'mql5-docs', enabled: true,
    transport: { type: 'stdio', command: 'C:/node.exe', args: [`C:/docs/${v}/server.mjs`], env: { MQL5_DOCS_DATA: `C:/docs/${v}` }, env_vars: [], cwd: null } }) });
  const found = [finding('a lot can exceed the limit', 'src/EA.mq5:1')];
  const unrated = reviewAnswer(found, { reqs: rows().slice(0, 1) }); // (R2 left out, so its repair resumes the session)
  setPair({ A: [unrated, reviewAnswer(found)], B: [reviewAnswer(found)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [marks([['A1', 'SAME_AS', 'B1']])],
    follow: [followAnswer([]), followAnswer([{ id: 'F1', status: 'RESOLVED', reason: 'capped' }])], docs: [entry('0.1.4'), entry('0.1.5'), entry('0.1.6')] });
  const serverOf = c => c.args.filter(a => a.startsWith('mcp_servers.mql5-docs.args=')).join('');
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  const reviewRuns = execCalls();
  assert.strictEqual(reviewRuns.length, 5, 'two reviewers, a repair and two cross-checks');
  assert.deepStrictEqual([...new Set(reviewRuns.map(serverOf))], ['mcp_servers.mql5-docs.args=["C:/docs/0.1.4/server.mjs"]']);
  assert.strictEqual(lookups().length, 1, 'one lookup for the attempt');
  const reviewers = reviewRuns.filter(c => /reviewer [AB]\. (Check|Attack)/.test(c.prompt) && c.args[1] !== 'resume');
  assert.ok(reviewers.length === 2 && reviewers.every(c => /MQL5 docs tools/.test(c.prompt)), 'both reviewers\' prompts have the note');
  const f = await review.followup(p.root, { chain: r.chain, responseFile: response('capped the lot') });
  assert.strictEqual(f.status, 'DONE', f.text);
  const followRuns = execCalls().slice(reviewRuns.length);
  assert.strictEqual(followRuns.length, 2, 'the follow-up and its repair');
  assert.deepStrictEqual([...new Set(followRuns.map(serverOf))], ['mcp_servers.mql5-docs.args=["C:/docs/0.1.5/server.mjs"]']);
  assert.match(followRuns[0].prompt, /MQL5 docs tools/);
  assert.strictEqual(lookups().length, 2, 'the follow-up looked it up once more');
  // (an attempt whose lookup finds no server keeps that: no run gets one or the note, though a later lookup would)
  const q = project('t1e', { 'src/EA.mq5': 'e0\n' });
  write(q.root, 'src/EA.mq5', 'e1\n');
  seed(q.root, s => { s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') }; s.plans = { [key('src/EA.mq5')]: plan(q) }; });
  setPair({ A: [unrated, reviewAnswer(found)], B: [reviewAnswer(found)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [marks([['A1', 'SAME_AS', 'B1']])],
    docs: [{ code: 1 }, entry('0.1.5')] });
  const off = await review.review(q.root, { session: 'A', taskFile: q.taskFile });
  assert.strictEqual(off.status, 'DONE', off.text);
  assert.strictEqual(execCalls().length, 5);
  assert.ok(execCalls().every(c => !c.args.some(a => a.startsWith('mcp_servers.')) && !/MQL5 docs tools/.test(c.prompt)), 'no run gets a server or the note');
  assert.strictEqual(lookups().length, 1);
});

test('a follow-up is refused for another session\'s change in an escalated chain file, starting no reviewer', async () => {
  const p = project('t1g', { 'src/payments.js': 'p0\n', 'src/notes.js': 'n0\n' });
  write(p.root, 'src/payments.js', 'p1\n');
  write(p.root, 'src/notes.js', 'n1\n');
  seed(p.root, s => { s.changes = { [key('src/payments.js')]: pending('src/payments.js'), [key('src/notes.js')]: pending('src/notes.js') }; });
  setPair({ single: [reviewAnswer([finding('off by one', 'src/notes.js:1')])] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  write(p.root, 'src/payments.js', 'p2 by B\n');
  seed(p.root, s => {
    s.changes[key('src/payments.js')] = { path: 'src/payments.js', session: 'B', at: 9, baseline: sha('p1\n') };
    s.escalations = { [key('src/payments.js')]: { chain: 'C0', at: 1 } };
  });
  const before = [JSON.stringify(stateOf(p.root)), execCalls().length];
  const f = await review.followup(p.root, { chain: r.chain, responseFile: response('fixed it') });
  assert.strictEqual(f.status, 'REFUSED');
  assert.match(f.text, /another session has pending changes in src\/payments\.js/);
  assert.deepStrictEqual([JSON.stringify(stateOf(p.root)), execCalls().length], before, 'nothing changes and no reviewer starts');
});

test('a concession because of the round limit gets its repair, only the repaired answer applies, and the same reason can\'t close', async () => {
  const p = project('t1h', { 'src/payments.js': 'p0\n' });
  write(p.root, 'src/payments.js', 'p1\n');
  seed(p.root, s => { s.changes = { [key('src/payments.js')]: pending('src/payments.js') }; });
  const maintain = { id: 'F1', status: 'MAINTAIN', reason: 'a payment can still be sent twice' };
  setPair({ single: [reviewAnswer([finding('a payment can be sent twice', 'src/payments.js:1')])],
    follow: [followAnswer([maintain]), followAnswer([maintain]), followAnswer([{ id: 'F1', status: 'CONCEDE', reason: 'the round limit was reached' }]), followAnswer([maintain])] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  for (const v of ['p2\n', 'p3\n']) {
    write(p.root, 'src/payments.js', v);
    assert.strictEqual((await review.followup(p.root, { chain: r.chain, responseFile: response(v) })).status, 'DONE');
  }
  write(p.root, 'src/payments.js', 'p4\n');
  const rev = stateOf(p.root).chains[r.chain].rev;
  const f = await review.followup(p.root, { chain: r.chain, responseFile: response('past it') });
  assert.strictEqual(f.status, 'DONE', f.text);
  const [conceded, repair] = execCalls().slice(-2);
  assert.ok(repair.prompt.startsWith('Your answer has these problems') && repair.args[1] === 'resume' && repair.args.includes(conceded.session), 'one repair, in the same session');
  const c = stateOf(p.root).chains[r.chain];
  assert.deepStrictEqual([c.rev, c.rounds.length, c.findings.F1.status, c.findings.F1.label], [rev + 1, 4, 'open', 'BUG'], 'only the repaired MAINTAIN applied');
  const before = JSON.stringify(stateOf(p.root));
  const closing = review.close(p.root, { chain: r.chain, rev: c.rev, notes: { F1: 'gap: the round limit was reached' } });
  assert.strictEqual(closing.status, 'REFUSED');
  assert.strictEqual(JSON.stringify(stateOf(p.root)), before);
  assert.ok(!fs.existsSync(path.join(p.root, gaps.NAME)), 'no gap is written');
});

test('a paired review\'s gap write cannot acknowledge a manual edit made while it ran', async () => {
  const p = project('t1i', { 'src/payments.js': 'p0\n', [gaps.NAME]: GAPS_BEFORE });
  write(p.root, 'src/payments.js', 'p1\n');
  seed(p.root, s => { s.acks = { [key(gaps.NAME)]: sha(GAPS_BEFORE) }; s.changes = { [key('src/payments.js')]: pending('src/payments.js') }; s.plans = { [key('src/payments.js')]: plan(p) }; });
  const hold = fs.mkdtempSync(path.join(HOME, 't1i-hold-'));
  const gap = [finding('odd name', 'src/payments.js:2', { severity: 'LOW', label: 'GAP' })];
  setPair({ A: [{ hold, text: reviewAnswer(gap) }], B: [reviewAnswer(gap)], xA: [marks([['B1', 'SAME_AS', 'A1']])], xB: [marks([['A1', 'SAME_AS', 'B1']])] });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  await waitFor(path.join(hold, 'started'));
  fs.writeFileSync(path.join(p.root, gaps.NAME), `${GAPS_BEFORE}\n## G9 · open · 2026-10-02 · LOW\n- Where: src/manual.js\n- Problem: written by hand\n`);
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  assert.ok(/written by hand/.test(gapsNow(p.root)) && /- Problem: F1: odd name/.test(gapsNow(p.root)) && /- Problem: older/.test(gapsNow(p.root)), 'the manual entry stays, with the new one');
  assert.strictEqual(stateOf(p.root).acks[key(gaps.NAME)], sha(GAPS_BEFORE), 'its acknowledgement stays where it was');
});

test('plan authorization stays bound to the task, its requirements and the frozen plan', async () => {
  const files = { 'src/EA.mq5': 'e0\n', 'src/preset.set': 'p0\n', 'src/Risk.mqh': 'r0\n', 'src/Lots.mqh': 'l0\n', 'src/store.js': 's0\n' };
  const p = project('t2', files);
  for (const rel of Object.keys(files)) write(p.root, rel, `${files[rel].trim()} changed\n`);
  const k = Object.fromEntries(Object.keys(files).map(rel => [rel, key(rel)]));
  seed(p.root, s => {
    s.changes = Object.fromEntries(Object.keys(files).map(rel => [k[rel], pending(rel)]));
    s.escalations = { [k['src/EA.mq5']]: { chain: 'Cx', at: 1 } };
    s.skips = { [k['src/EA.mq5']]: { task: p.task, reqHash: p.reqHash, why: 'w' }, [k['src/preset.set']]: { task: p.task, reqHash: p.reqHash, why: 'w' } };
    s.plans = { [k['src/Risk.mqh']]: { ...plan(p), task: 'another task' }, [k['src/Lots.mqh']]: { ...plan(p), reqHash: 'an old hash' }, [k['src/store.js']]: plan(p) };
  });
  const hold = fs.mkdtempSync(path.join(HOME, 't2-hold-'));
  const risky = { level: 'risky', files: ['src/EA.mq5'], why: 'orders' };
  setPair({ A: [{ hold, text: reviewAnswer([], { cls: risky }) }], B: [reviewAnswer()], xA: [marks([])], xB: [marks([])],
    follow: [followAnswer()] });
  // (another task's plan and one from older requirements don't count, so the review isn't run; the escalated EA's
  // skip still does, since GPT hasn't rated it risky for this task)
  const before = review.withMaps(stateOf(p.root));
  const unplanned = await review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  assert.strictEqual(unplanned.status, 'REFUSED');
  assert.match(unplanned.text, /^REFUSED: test plan first: no current test plan for this task: src\/Risk\.mqh, src\/Lots\.mqh \(/);
  assert.deepStrictEqual([stateOf(p.root), execCalls().length], [before, 0], 'nothing reserved, GPT never asked');
  seed(p.root, s => { for (const rel of ['src/Risk.mqh', 'src/Lots.mqh']) s.plans[k[rel]] = plan(p); });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  await waitFor(path.join(hold, 'started'));
  seed(p.root, s => { s.plans[k['src/store.js']] = { ...plan(p), cases: [{ id: 'T9', text: 'replaced', test: 'x' }] }; });
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  assert.ok(!execCalls().some(c => c.prompt.includes('Cross-check')), 'a pair with no findings on either side skips the cross-check');
  let s = stateOf(p.root);
  assert.deepStrictEqual(Object.keys(s.acks).sort(), [k['src/preset.set'], k['src/Risk.mqh'], k['src/Lots.mqh']].sort());
  assert.match(r.text, /not acknowledged until they have a current test plan[^\n]*src\/EA\.mq5, src\/store\.js/);
  assert.deepStrictEqual(s.needsPlan[k['src/EA.mq5']], [{ task: p.task, reqHash: p.reqHash }]);
  assert.ok(!s.escalations[k['src/EA.mq5']]); // (the pair read it in full)
  const skipOnly = await review.followup(p.root, { chain: r.chain, responseFile: response('nothing changed') });
  assert.strictEqual(skipOnly.status, 'REFUSED', 'its skip never counts once GPT rated it risky for this task');
  assert.match(skipOnly.text, /test plan first: no current test plan for this task: src\/EA\.mq5 \(/);
  seed(p.root, x => { x.plans[k['src/EA.mq5']] = plan(p); });
  const f1 = await review.followup(p.root, { chain: r.chain, responseFile: response('EA plan written') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  assert.match(execCalls().slice(-1)[0].prompt, /## Test plans\n[\s\S]*- T9: replaced/, 'a plan that counts in this round is shown to it');
  s = stateOf(p.root);
  assert.ok(s.acks[k['src/store.js']], 'this follow-up froze the replacement plan, so it counts now');
  for (const rel of Object.keys(files)) assert.ok(s.acks[k[rel]], `${rel} acknowledged`);
});

test('one merge keeps the BUG author\'s account, row provenance and dispute evidence', () => {
  const twinA = finding('lot rounding', 'src/a.js:3', { severity: 'MEDIUM', title: 'A view', test: null });
  const twinB = finding('lot rounding', 'src/a.js:3', { severity: 'HIGH', title: 'B view', test: 'lot 0.015 -> 0.01', label: 'GAP' }); // (mixed labels: a BUG, in A's words)
  const a = { verdict: 'ISSUES_FOUND', findings: [], requirements: rows('NOT_MET', 'NOT_MET'), possibly_missing: ['pa'], class: { level: 'normal', files: ['src/helper.js'], why: 'wa' }, coverage: 'ca' };
  const b = { verdict: 'ISSUES_FOUND', findings: [], requirements: rows('MET', 'PARTIAL'), possibly_missing: ['pb'], class: { level: 'risky', files: ['src/other.js'], why: 'wb' }, coverage: 'cb' };
  const found = {
    A: { A1: twinA, A2: finding('gap twin', '-', { label: 'GAP' }), A3: finding('confirmed', '-'), A4: finding('disputed', '-', { reqs: ['R1'] }),
      A5: finding('R2 is NOT MET', '-', { reqs: ['R2'] }) },
    B: { B1: twinB, B2: finding('gap twin b', '-', { label: 'GAP' }), B3: finding('b on R2', '-', { reqs: ['R2'] }) },
  };
  const marksBy = { A: JSON.parse(marks([['B1', 'SAME_AS', 'A1'], ['B2', 'SAME_AS', 'A2'], ['B3', 'DISPUTE', null, 'R2 is checked at src/a.js:9']])).marks,
    B: JSON.parse(marks([['A1', 'SAME_AS', 'B1'], ['A2', 'SAME_AS', 'B2'], ['A3', 'CONFIRM'], ['A4', 'DISPUTE', null, 'src/a.js:5 refuses it'], ['A5', 'CONFIRM']])).marks };
  const m = pair.merge(a, b, found, marksBy);
  const by = Object.fromEntries(m.findings.map(f => [f.title, f]));
  assert.deepStrictEqual(m.findings.map(f => [f.title, f.label, f.agreement]), [
    ['A view', 'BUG', 'both'], ['gap twin', 'GAP', 'both'], ['confirmed', 'BUG', 'confirmed by B'],
    ['disputed', 'GAP', 'disputed by B: src/a.js:5 refuses it'], ['R2 is NOT MET', 'BUG', 'confirmed by B'], ['b on R2', 'GAP', 'disputed by A: R2 is checked at src/a.js:9']]);
  assert.deepStrictEqual([by['A view'].severity, by['A view'].test, by['A view'].by], ['MEDIUM', null, 'A+B'], 'one account, the BUG author\'s, never a mix');
  // (R1: only A rated it unmet, and A's one finding naming it was disputed, so B's MET stands; R2: both rated it unmet)
  assert.deepStrictEqual(m.requirements.map(r => r.status), ['MET', 'NOT_MET']);
  for (const r of m.requirements) assert.ok(m.findings.some(f => f.reqs.includes(r.id)), `${r.id} is linked, so no extra BUG is made for it`);
  assert.deepStrictEqual(m.class, { level: 'risky', files: ['src/other.js'], why: 'A: wa / B: wb' });
  assert.deepStrictEqual([m.possibly_missing, m.coverage, m.verdict], [['pa', 'pb'], 'A: ca / B: cb', 'ISSUES_FOUND']);
  assert.match(answer.render(m), /pair: disputed by B: src\/a\.js:5 refuses it/);
});

test('another task\'s paired review of a file keeps this task\'s plan requirement for it', async () => {
  const p = project('t6', { 'src/helper.js': 'h0\n' });
  write(p.root, 'src/helper.js', 'h1 sizes lots\n');
  const otherTask = path.join(HOME, 't6-other-task.md');
  fs.writeFileSync(otherTask, '# other\n\n## Requirements\nR1. Places the order safely.\nR2. Keeps the lot within limits.\nR3. Something else.\n');
  const other = { task: state.pathKey(path.resolve(otherTask)), reqHash: sha('R1. Places the order safely.\nR2. Keeps the lot within limits.\nR3. Something else.') };
  seed(p.root, s => { s.changes = { [key('src/helper.js')]: pending('src/helper.js') }; });
  const risky = { level: 'risky', files: ['src/helper.js'], why: 'it sizes lots' };
  const threeRows = [...rows(), { id: 'R3', status: 'MET', evidence: 'e3' }];
  setPair({ single: [reviewAnswer([], { cls: risky })], A: [reviewAnswer([], { reqs: threeRows, cls: risky })], B: [reviewAnswer([], { reqs: threeRows })],
    xA: [marks([])], xB: [marks([])], follow: [followAnswer()] });
  const first = await review.review(p.root, { session: 'A', taskFile: p.taskFile }); // (task 1, a normal review that rates it risky)
  assert.strictEqual(first.status, 'DONE', first.text);
  seed(p.root, s => { s.plans = { [key('src/helper.js')]: plan(other) }; });
  const paired = await review.review(p.root, { files: ['src/helper.js'], taskFile: otherTask }); // (task 2, escalated: a pair)
  assert.strictEqual(paired.status, 'DONE', paired.text);
  let s = stateOf(p.root);
  assert.deepStrictEqual(s.needsPlan[key('src/helper.js')].map(r => r.task), [p.task, other.task], 'each task keeps its own record');
  assert.ok(!s.escalations[key('src/helper.js')]);
  write(p.root, 'src/helper.js', 'h2 changed in task 1\n');
  const again = await review.followup(p.root, { chain: first.chain, responseFile: response('rated normal now') });
  assert.strictEqual(again.status, 'REFUSED', 'task 1 still needs its own plan for the file it found risky');
  assert.match(again.text, /test plan first: no current test plan for this task: src\/helper\.js \(/);
  assert.strictEqual(stateOf(p.root).acks[key('src/helper.js')], sha('h1 sizes lots\n'), 'its new version isn\'t acknowledged');
});

test('new risky files need their own pair, during a paired review and its follow-ups', async () => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const p = project('t4', { 'src/EA.mq5': 'e0\n', 'src/h1.js': `${body}\n`, 'src/h2.js': `${body}\n` });
  write(p.root, 'src/EA.mq5', 'e1\n');
  write(p.root, 'src/new.js', 'a new helper; its text says (diff from x)\n'); // (new: shown in full, whatever it says)
  write(p.root, 'src/h1.js', `H1\n${body.split('\n').slice(1).join('\n')}\n`); // (diffs only)
  write(p.root, 'src/h2.js', `H2\n${body.split('\n').slice(1).join('\n')}\n`);
  const all = ['src/EA.mq5', 'src/new.js', 'src/h1.js', 'src/h2.js'];
  const began = Date.now() - 60000;
  const committed = snapshotOf(p.root, `${body}\n`); // (h1 and h2 existed: their baseline is the committed text)
  seed(p.root, s => {
    s.changes = Object.fromEntries(all.map(rel => [key(rel), { ...pending(rel), baseline: /h\d/.test(rel) ? committed : null }]));
    s.plans = Object.fromEntries(all.map(rel => [key(rel), plan(p)]));
    s.escalations = { [key('src/EA.mq5')]: { chain: 'C0', at: began } };
    s.chains = { C0: { rev: 1, began, rounds: [], closed: false, files: { [key('src/EA.mq5')]: 'src/EA.mq5' }, frozen: {}, findings: {}, risky: { [key('src/EA.mq5')]: began } } };
  });
  const riskyOf = files => ({ level: 'risky', files, why: 'it sizes lots' });
  const maintainGap = { id: 'F2', status: 'MAINTAIN', reason: 'still disputed' };
  // A also rates R2 NOT MET without a finding: that row becomes its own finding A2, which B disputes
  // (B reports the same bug, rated higher, and each marks the other's as SAME_AS)
  const twinB = finding('no stop loss either', 'src/EA.mq5:1', { severity: 'HIGH', test: 'an order without a stop loss is refused' });
  setPair({ A: [reviewAnswer([finding('no stop loss', 'src/EA.mq5:1')], { reqs: rows('MET', 'NOT_MET') }), reviewAnswer(), reviewAnswer()],
    B: [reviewAnswer([twinB], { cls: riskyOf(['src/h1.js']) }), reviewAnswer(), reviewAnswer()], xA: [marks([['B1', 'SAME_AS', 'A1']])],
    xB: [marks([['A1', 'SAME_AS', 'B1'], ['A2', 'DISPUTE', null, 'R2 is enforced at src/h2.js:1']])],
    follow: [followAnswer([{ id: 'F1', status: 'RESOLVED', reason: 'stop added' }, maintainGap], riskyOf(['src/h2.js', 'src/EA.mq5', 'src/new.js'])),
      followAnswer([maintainGap]), followAnswer([maintainGap], riskyOf(['src/h1.js']))] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  let s = stateOf(p.root);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.bundle, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual([s.chains[r.chain].paired, s.chains[r.chain].rounds.length], [true, 1]);
  assert.deepStrictEqual(s.riskyReviews, { [key('src/EA.mq5')]: manifest.admittedAt, [key('src/new.js')]: manifest.admittedAt }, 'the files it read in full');
  assert.deepStrictEqual(Object.keys(s.escalations), [key('src/h1.js')], 'B rated the diff-only h1 risky: it needs its own pair');
  assert.deepStrictEqual(Object.keys(s.chains[r.chain].risky), [key('src/h1.js')]);
  assert.deepStrictEqual(Object.keys(s.changes), [key('src/h1.js')]);
  assert.deepStrictEqual(Object.values(s.chains[r.chain].findings).map(f => [f.title, f.severity, f.test, f.label, f.agreement]),
    [['no stop loss either', 'HIGH', 'an order without a stop loss is refused', 'BUG', 'both'], ['R2 is NOT MET', 'MEDIUM', null, 'GAP', 'disputed by B: R2 is enforced at src/h2.js:1']]);
  assert.match(fs.readFileSync(path.join(p.root, gaps.NAME), 'utf8'), /- Problem: F2: R2 is NOT MET\n[^#]*- Why skipped: pair: disputed by B: R2 is enforced at src\/h2\.js:1/);
  const turns = fs.readdirSync(r.bundle).filter(f => f.startsWith('turn-')).sort();
  assert.deepStrictEqual(turns, ['turn-1-A-1.md', 'turn-1-B-1.md', 'turn-2-A-1.md', 'turn-2-B-1.md']);
  assert.match(fs.readFileSync(path.join(r.bundle, 'turn-2-B-1.md'), 'utf8'),
    /## Your findings\n- B1 \[HIGH BUG\] no stop loss either[^\n]*\n\n## Reviewer A's findings\n- A1 \[MEDIUM BUG\] no stop loss[^\n]*\n- A2 \[MEDIUM BUG\] R2 is NOT MET/);
  assert.strictEqual(review.close(p.root, { chain: 'C0', rev: 1, notes: {} }).status, 'DONE', 'its pair read EA.mq5 in full');
  write(p.root, 'src/EA.mq5', 'e2 with a stop\n');
  write(p.root, 'src/h2.js', `H2 again\n${body.split('\n').slice(1).join('\n')}\n`);
  const f1 = await review.followup(p.root, { chain: r.chain, responseFile: response('stop added') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  const call = execCalls().slice(-1)[0];
  assert.deepStrictEqual([call.args[1], call.args.includes('sess-A'), call.args.includes('model_reasoning_effort=xhigh')], ['resume', true, true]);
  s = stateOf(p.root);
  assert.deepStrictEqual(Object.keys(s.escalations).sort(), [key('src/h1.js'), key('src/h2.js')].sort(), 'h2 newly risky: its own pair; EA.mq5 and new.js were read in full');
  assert.deepStrictEqual(Object.keys(s.changes).sort(), [key('src/h1.js'), key('src/h2.js')].sort(), 'EA.mq5 and new.js have current plans');
  assert.strictEqual((await review.followup(p.root, { chain: r.chain, responseFile: response('all normal now') })).status, 'DONE');
  s = stateOf(p.root);
  assert.deepStrictEqual(Object.keys(s.escalations).sort(), [key('src/h1.js'), key('src/h2.js')].sort(), 'a normal rating lifts no escalation');
  const refused = review.close(p.root, { chain: r.chain, rev: s.chains[r.chain].rev, notes: {} });
  assert.strictEqual(refused.status, 'REFUSED');
  assert.match(refused.text, /src\/h1\.js was rated risky in this chain[\s\S]*src\/h2\.js was rated risky in this chain/);
  // (h1 and h2: escalated, so a pair; h2's pending record has no session, since no hook saw its edit, so it is named)
  const ownPair = await review.review(p.root, { session: 'A', files: ['src/h2.js'], taskFile: p.taskFile });
  assert.strictEqual(ownPair.status, 'DONE', ownPair.text);
  s = stateOf(p.root);
  assert.ok(s.riskyReviews[key('src/h1.js')] > s.chains[r.chain].began && s.riskyReviews[key('src/h2.js')] > s.chains[r.chain].began,
    JSON.stringify({ riskyReviews: s.riskyReviews, began: s.chains[r.chain].began, text: ownPair.text }));
  assert.deepStrictEqual([s.escalations, s.changes], [{}, {}]);
  // a later version of h1, rated risky again in the original chain, needs a pair of its own: the older receipt won't do
  write(p.root, 'src/h1.js', `H1 v2\n${body.split('\n').slice(1).join('\n')}\n`);
  assert.strictEqual((await review.followup(p.root, { chain: r.chain, responseFile: response('h1 changed again') })).status, 'DONE');
  s = stateOf(p.root);
  const stale = review.close(p.root, { chain: r.chain, rev: s.chains[r.chain].rev, notes: {} });
  assert.strictEqual(stale.status, 'REFUSED');
  assert.match(stale.text, /src\/h1\.js was rated risky in this chain/);
  assert.strictEqual((await review.review(p.root, { files: ['src/h1.js'], taskFile: p.taskFile })).status, 'DONE');
  s = stateOf(p.root);
  assert.strictEqual(review.close(p.root, { chain: r.chain, rev: s.chains[r.chain].rev, notes: {} }).status, 'DONE');
});

test('a file edited during its paired review gets no receipt and stays escalated', async () => {
  const p = project('t7', { 'src/pay.js': 'p0\n' });
  write(p.root, 'src/pay.js', 'p1\n');
  const began = Date.now() - 60000;
  seed(p.root, s => {
    s.changes = { [key('src/pay.js')]: pending('src/pay.js') };
    s.plans = { [key('src/pay.js')]: plan(p) };
    s.escalations = { [key('src/pay.js')]: { chain: 'C0', at: began } };
    s.chains = { C0: { rev: 1, began, rounds: [], closed: false, files: { [key('src/pay.js')]: 'src/pay.js' }, frozen: {}, findings: {}, risky: { [key('src/pay.js')]: began } } };
  });
  const hold = fs.mkdtempSync(path.join(HOME, 't7-hold-'));
  setPair({ A: [{ hold, text: reviewAnswer() }], B: [reviewAnswer()] });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile });
  await waitFor(path.join(hold, 'started'));
  write(p.root, 'src/pay.js', 'p2 edited while the pair reviewed p1\n');
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  const s = stateOf(p.root);
  assert.strictEqual(s.riskyReviews[key('src/pay.js')], undefined, 'the pair reviewed p1, not p2');
  assert.ok(s.escalations[key('src/pay.js')], 'p2 still needs a paired review');
  assert.ok(s.changes[key('src/pay.js')]);
  assert.strictEqual(review.close(p.root, { chain: 'C0', rev: 1, notes: {} }).status, 'REFUSED');
});

test('parallel risky reviewers share the whole code, decoded callers and frozen plan tests', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `engine line ${i + 1}`);
  const callers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/c${String(i + 1).padStart(2, '0')}.js`, `uses engine ${i}\n`]));
  const p = project('t5', { 'src/engine.js': `${lines.join('\n')}\n`, 'tests/engine.test.js': 'test v0\n', ...callers });
  fs.writeFileSync(path.join(p.root, 'src/c03.js'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF16 calls engine\n', 'utf16le')]));
  write(p.root, 'src/zz-untracked.js', 'untracked engine caller\n');
  write(p.root, 'src/engine.js', `${['CHANGED', ...lines.slice(1)].join('\n')}\n`);
  seed(p.root, s => {
    s.changes = { [key('src/engine.js')]: { path: 'src/engine.js', session: 'A', at: 1, baseline: snapshotOf(p.root, `${lines.join('\n')}\n`) } };
    s.plans = { [key('src/engine.js')]: plan(p, ['tests/engine.test.js']) };
  });
  const holdA = fs.mkdtempSync(path.join(HOME, 't5-a-'));
  const holdB = fs.mkdtempSync(path.join(HOME, 't5-b-'));
  const wrong = reviewAnswer([finding('nowhere', 'src/nowhere.js:1')]);
  setPair({ A: [{ hold: holdA, text: wrong }, reviewAnswer()], B: [{ hold: holdB, text: wrong }, reviewAnswer()], xA: [marks([])], xB: [marks([])] });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  await waitFor(path.join(holdA, 'started'));
  await waitFor(path.join(holdB, 'started'));
  write(p.root, 'src/c01.js', 'changed after freezing\n');
  write(p.root, 'tests/engine.test.js', 'test changed after freezing\n');
  fs.writeFileSync(path.join(holdA, 'go'), '');
  fs.writeFileSync(path.join(holdB, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  const calls = execCalls();
  const first = role => calls.find(c => c.prompt.includes(role) && c.args[1] !== 'resume');
  const [a, b] = [first('reviewer A. Check'), first('reviewer B. Attack')];
  for (const c of [a, b]) {
    assert.ok(c.args.includes('model_reasoning_effort=xhigh') && !c.args.includes('--ephemeral'));
    assert.match(c.prompt, /-engine line 1\n\+CHANGED/);
    assert.match(c.prompt, /### src\/engine\.js \(whole file, read in full\)\n```\nCHANGED\nengine line 2/);
    assert.match(c.prompt, /- T1: an order without a stop is refused \(test: tests\/t\.test\.js\)/);
    assert.match(c.prompt, /\(1 more not shown\)/);
    assert.ok(c.prompt.includes('- src/c03.js: '), 'the UTF-16 caller is found');
    assert.ok(!c.prompt.includes('- src/zz-untracked.js: '), 'sorted: the 21st caller is cut off');
  }
  assert.match(b.prompt, /money and trading: [^\n]+\n- data: [^\n]+\n- security: [^\n]+\n- general: /);
  const snapOf = (prompt, label) => prompt.match(new RegExp(`${label}: (.+)`))[1].trim();
  assert.strictEqual(fs.readFileSync(snapOf(a.prompt, '- src/c01\\.js'), 'utf8'), 'uses engine 0\n');
  assert.strictEqual(fs.readFileSync(snapOf(a.prompt, '- frozen test tests/engine\\.test\\.js'), 'utf8'), 'test v0\n');
  const repairs = calls.filter(c => c.prompt.startsWith('Your answer has these problems'));
  assert.deepStrictEqual(repairs.map(c => c.args.includes('sess-A') || c.args.includes('sess-B')), [true, true]);
  const s = stateOf(p.root);
  assert.deepStrictEqual(Object.keys(s.acks), [key('src/engine.js')]);
  assert.deepStrictEqual(Object.keys(s.riskyReviews), [key('src/engine.js')]);
});

// A snapshot as review.js writes it (by content hash), for a seeded baseline.
function snapshotOf(root, text) {
  const file = path.join(state.projectDir(root), 'snap', sha(text));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return sha(text);
}

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test('a normal review\'s pair with Muse can\'t certify a file Muse newly rates risky: it is escalated and waits for its plan and its own paired review', async () => {
  const museSpec = path.join(HOME, 'muse-spec.json');
  const museLog = path.join(HOME, 'muse-calls.jsonl');
  Object.assign(process.env, { FAKE_MUSE_SPEC: museSpec, FAKE_MUSE_LOG: museLog });
  const config = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...config, museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')], museVerified: '9.9.9-test', museSkills: ['bundled:git'] }));
  assert.ok(state.update(state.files.global(), g => { g.muse = true; }).ok);
  const p = project('t-muse-risky', { 'src/other.js': 'o\n' });
  write(p.root, 'src/refund.js', 'refund once\n');
  const k = key('src/refund.js');
  seed(p.root, s => { s.changes = { [k]: pending('src/refund.js') }; });
  setPair({ A: [reviewAnswer()], xA: [marks([['B1', 'CONFIRM']])] });
  const risky = { level: 'risky', files: ['src/refund.js'], why: 'it moves money' };
  fs.writeFileSync(museSpec, JSON.stringify({ exec: [{ text: reviewAnswer([finding('a refund can be paid twice', 'src/refund.js:1', { severity: 'HIGH', test: 'pay once' })], { cls: risky }) },
    { text: marks([]) }] }));
  fs.rmSync(museLog, { force: true });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  const s = stateOf(p.root);
  const chain = s.chains[r.chain];
  assert.deepStrictEqual(Object.values(chain.findings).map(f => [f.title, f.label, f.status]), [['a refund can be paid twice', 'BUG', 'open']]);
  assert.ok(s.escalations[k] && s.changes[k] && !s.acks[k], 'escalated, pending, not acknowledged');
  assert.ok(!(s.riskyReviews || {})[k] && !chain.paired, 'no receipt, and not a paired chain');
  const f = await review.followup(p.root, { chain: r.chain, responseFile: response('fixed') });
  assert.strictEqual(f.status, 'REFUSED', f.text);
  assert.match(f.text, /escalated: each needs its own paired review first/, 'a follow-up can\'t stand in for its plan and paired review');
  assert.ok(state.update(state.files.global(), g => { delete g.muse; }).ok);
});

// ---- The merge's rules (test plan of the cross-check task) ----

test('a one-sided SAME_AS can\'t erase a separate refund failure: both bugs stay, each with its own fix', () => {
  const retry = finding('a retry pays a refund twice', 'src/refund.js:4', { severity: 'HIGH', trigger: 'the bank call times out', fix: 'an idempotency key', test: 'retry pays once', reqs: ['R1'] });
  const webhook = finding('two webhooks pay a refund twice', 'src/hooks.js:9', { severity: 'HIGH', trigger: 'webhooks arrive together', fix: 'a row lock', test: 'parallel webhooks pay once', reqs: ['R2'] });
  const a = JSON.parse(reviewAnswer([retry], { reqs: rows() }));
  const b = JSON.parse(reviewAnswer([webhook], { reqs: rows() }));
  const m = pair.merge(a, b, { A: { A1: retry }, B: { B1: webhook } },
    { A: JSON.parse(marks([['B1', 'CONFIRM']])).marks, B: JSON.parse(marks([['A1', 'SAME_AS', 'B1']])).marks });
  assert.deepStrictEqual(m.findings.map(f => [f.title, f.label, f.agreement, f.fix, f.test, f.reqs]), [
    ['a retry pays a refund twice', 'BUG', 'confirmed by B', 'an idempotency key', 'retry pays once', ['R1']],
    ['two webhooks pay a refund twice', 'BUG', 'confirmed by A', 'a row lock', 'parallel webhooks pay once', ['R2']]]);
});

test('checked cross-check judgements can\'t demote a destructive-migration BUG, and a judgement or reason left out is refused', () => {
  const migration = (title, label) => finding(title, 'src/migrate.js:7', { severity: 'HIGH', label, test: 'rows survive', harm: 'rows are deleted' });
  const found = { A: { A1: migration('drops rows on rerun', 'GAP'), A2: migration('no rollback on failure', 'BUG'), A3: migration('wrong target table', 'BUG') }, B: {} };
  const asked = { otherIds: ['A1', 'A2', 'A3'], ownIds: [] };
  const sent = marks([['A1', 'CONFIRM', null, '', 'BUG'], ['A2', 'CONFIRM', null, '', 'GAP'], ['A3', 'UNCLEAR', null, 'the migration runner is not in my material']]);
  const checked = answer.read('crosscheck', sent, asked);
  assert.deepStrictEqual([checked.problems, checked.answer], [[], JSON.parse(sent)], 'valid marks pass unchanged');
  const a = JSON.parse(reviewAnswer(Object.values(found.A)));
  const m = pair.merge(a, JSON.parse(reviewAnswer()), found, { A: [], B: checked.answer.marks });
  assert.deepStrictEqual(m.findings.map(f => [f.title, f.label]), [['drops rows on rerun', 'BUG'], ['no rollback on failure', 'BUG'], ['wrong target table', 'BUG']]);
  const bare = answer.read('crosscheck', marks([['A1', 'CONFIRM', null, '', null], ['A2', 'UNCLEAR', null, ' '], ['A3', 'DISPUTE', null, 'src/migrate.js:2 guards it']]), asked);
  assert.ok(bare.problems.some(p => /A1 is confirmed without your label/.test(p)) && bare.problems.some(p => /A2 is marked UNCLEAR without saying/.test(p)), bare.problems.join('; '));
});

test('a reviewer that found nothing must still check the other\'s bug before the pair counts, and only that side needs its session', async () => {
  const bypass = finding('authorization can be bypassed', 'src/auth.js:2', { severity: 'HIGH', test: 'a stranger is refused' });
  const runs = [];
  const runOne = sessions => async (prompt, options, side) => {
    runs.push(options.label);
    if (options.label === '1-A') return { status: 'OK', answer: JSON.parse(reviewAnswer()), session: sessions.A };
    if (options.label === '1-B') return { status: 'OK', answer: JSON.parse(reviewAnswer([bypass])), session: sessions.B };
    if (options.label === '2-A' && side === 'A' && options.resume === sessions.A) return { status: 'OK', answer: JSON.parse(marks([['B1', 'CONFIRM']])) };
    throw new Error(`unexpected run ${side} ${options.label}`);
  };
  const done = await pair.runPair({ prompt: 'review', runOne: runOne({ A: 'sess-A', B: null }), materialize: review.findingsOf });
  assert.deepStrictEqual([done.status, done.pairComplete, runs], ['OK', true, ['1-A', '1-B', '2-A']], 'B, with nothing to mark, needs no session and no cross-check');
  assert.deepStrictEqual(done.answer.findings.map(f => [f.title, f.label, f.agreement]), [['authorization can be bypassed', 'BUG', 'confirmed by A']]);
  runs.length = 0;
  const unchecked = await pair.runPair({ prompt: 'review', runOne: runOne({ A: null, B: 'sess-B' }), materialize: review.findingsOf });
  assert.deepStrictEqual([unchecked.status, unchecked.pairComplete, runs.some(l => l.startsWith('2-'))], ['PAIR_INCOMPLETE', undefined, false], 'A must check B1 and can\'t: no pair');
});

test('a receipt spares a later round only for the very version its pair certified, never for an edit or a receipt without a version', async () => {
  const p = project('t-receipt', { 'src/auth.js': 'v0\n' });
  const k = key('src/auth.js');
  const risky = { level: 'risky', files: ['src/auth.js'], why: 'it guards logins' };
  write(p.root, 'src/auth.js', 'v1\n');
  seed(p.root, s => { s.changes = { [k]: pending('src/auth.js') }; s.plans = { [k]: plan(p) }; });
  setPair({ A: [reviewAnswer()], B: [reviewAnswer()] });
  const paired = await review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  assert.strictEqual(paired.status, 'DONE', paired.text);
  const receipt = stateOf(p.root).riskyReviews[k];
  assert.deepStrictEqual([!!receipt, stateOf(p.root).riskyVersions[k]], [true, sha('v1\n')], 'the receipt names the version it certified');
  const ordinary = async () => { setPair({ single: [reviewAnswer([], { cls: risky })] }); return review.review(p.root, { files: ['src/auth.js'], taskFile: p.taskFile }); };
  const same = await ordinary(); // (the certified version, rated risky again by an ordinary review: no second pair)
  assert.strictEqual(same.status, 'DONE', same.text);
  assert.deepStrictEqual([stateOf(p.root).escalations[k], stateOf(p.root).acks[k]], [undefined, sha('v1\n')]);
  write(p.root, 'src/auth.js', 'v2\n'); // (an edit: the receipt doesn't cover it)
  const edited = await ordinary();
  const s = stateOf(p.root);
  assert.ok(s.escalations[k] && s.changes[k] && s.acks[k] === sha('v1\n'), 'escalated, pending, still acknowledged at v1');
  assert.strictEqual(s.riskyReviews[k], receipt, 'an ordinary review mints no receipt');
  assert.strictEqual(review.close(p.root, { chain: edited.chain, rev: s.chains[edited.chain].rev, notes: {} }).status, 'REFUSED', 'its chain waits for its own pair');
  const q = project('t-receipt-legacy', { 'src/auth.js': 'v0\n' });
  const lk = key('src/auth.js');
  write(q.root, 'src/auth.js', 'v1\n');
  seed(q.root, s2 => { s2.acks = { [lk]: sha('v1\n') }; s2.riskyReviews = { [lk]: Date.now() }; s2.plans = { [lk]: plan(q) }; }); // (a receipt from before versions were recorded)
  setPair({ single: [reviewAnswer([], { cls: risky })] });
  const legacy = await review.review(q.root, { files: ['src/auth.js'], taskFile: q.taskFile });
  assert.strictEqual(legacy.status, 'DONE', legacy.text);
  assert.ok(stateOf(q.root).escalations[lk], 'a receipt without a version never spares a pair');
});

test('Muse can use a risky file shown whole without it being pasted twice, while a diff-only file\'s copy stays inline, and its BUG is recorded', async () => {
  const museSpec = path.join(HOME, 'muse-spec-whole.json');
  const museLog = path.join(HOME, 'muse-calls-whole.jsonl');
  Object.assign(process.env, { FAKE_MUSE_SPEC: museSpec, FAKE_MUSE_LOG: museLog });
  const config = JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...config, museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')], museVerified: '9.9.9-test', museSkills: ['bundled:git'] }));
  assert.ok(state.update(state.files.global(), g => { g.muse = true; delete g.museCooldownUntil; }).ok);
  const lines = sentinel => Array.from({ length: 30 }, (_, i) => (i === 27 ? sentinel : `line ${i + 1}`));
  const pay = lines('PAY-SENTINEL refund once');
  const helper = lines('HELPER-SENTINEL format amounts');
  const p = project('t-whole', { 'src/pay.js': `${pay.join('\n')}\n`, 'src/helper.js': `${helper.join('\n')}\n` });
  write(p.root, 'src/pay.js', `${['changed', ...pay.slice(1)].join('\n')}\n`);
  write(p.root, 'src/helper.js', `${['changed', ...helper.slice(1)].join('\n')}\n`);
  const [kp, kh] = [key('src/pay.js'), key('src/helper.js')];
  const changed = (rel, text) => ({ ...pending(rel), baseline: snapshotOf(p.root, `${text.join('\n')}\n`) }); // (edits, shown as diffs)
  seed(p.root, s => { s.changes = { [kp]: changed('src/pay.js', pay), [kh]: changed('src/helper.js', helper) }; s.plans = { [kp]: plan(p) }; });
  setPair({ A: [reviewAnswer()], xA: [marks([['B1', 'CONFIRM']])] });
  fs.writeFileSync(museSpec, JSON.stringify({ exec: [{ text: reviewAnswer([finding('a refund is paid twice', 'src/pay.js:28', { severity: 'HIGH', test: 'pay once' })]) }] }));
  fs.rmSync(museLog, { force: true });
  const r = await review.review(p.root, { session: 'A', files: ['src/pay.js'], taskFile: p.taskFile, risky: true });
  assert.strictEqual(r.status, 'DONE', r.text);
  const sent = fs.readFileSync(museLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(c => c.args[0] === 'exec' && c.args.includes('meta')).prompt;
  const [shown, inline] = sent.split('## The listed copies, inline');
  assert.match(sent, /use only what this prompt holds: the files it shows whole, and the copies inline at the end/);
  assert.ok(shown.includes('PAY-SENTINEL') && !inline.includes('PAY-SENTINEL'), 'the risky file is shown whole once, not pasted again');
  assert.ok(!shown.includes('HELPER-SENTINEL') && inline.includes('HELPER-SENTINEL'), 'the diff-only file\'s copy is inline');
  const bugs = Object.values(stateOf(p.root).chains[r.chain].findings).map(f => [f.title, f.label, f.status]);
  assert.deepStrictEqual(bugs, [['a refund is paid twice', 'BUG', 'open']]);
  assert.ok(state.update(state.files.global(), g => { delete g.muse; }).ok);
});

test('a requirement only one side rated unmet follows that side\'s own findings, even when a merged pair names it through the other side', () => {
  const a = JSON.parse(reviewAnswer([], { reqs: rows('NOT_MET', 'MET') }));
  const b = JSON.parse(reviewAnswer([], { reqs: rows('MET', 'MET') }));
  const found = { A: { A1: finding('R1 is NOT MET', '-', { reqs: ['R1'] }), A2: finding('slow query', 'src/a.js:3') }, B: { B1: finding('slow query', 'src/a.js:3', { reqs: ['R1'] }) } };
  const m = pair.merge(a, b, found, { A: JSON.parse(marks([['B1', 'SAME_AS', 'A2']])).marks,
    B: JSON.parse(marks([['A1', 'DISPUTE', null, 'src/a.js:9 meets R1'], ['A2', 'SAME_AS', 'B1']])).marks });
  assert.deepStrictEqual(m.requirements.map(r => r.status), ['MET', 'MET'], 'A\'s only finding naming R1 was disputed, so B\'s MET stands');
});
