// Tests for pair.js and paired reviews in review.js: a pair records only when all four runs complete, its merge is
// deterministic, its receipts free the files it read in full, and a risky file needs the test plan the reviewers
// saw (test plan P1 of step 3). Codex is the recording stub, its answers pinned per reviewer and step.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck pair test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CROSSCHECK_HOME, 'config.json'), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js') }));
const state = require('../src/state');
const review = require('../src/review');
const pair = require('../src/pair');
const answer = require('../src/answer');
const gaps = require('../src/gaps');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const execCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.kind === 'exec');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 400 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const stateOf = root => state.read(state.files.project(root)).data;
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const key = rel => state.pathKey(rel);
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const response = text => { const f = path.join(HOME, `response-${crypto.randomBytes(3).toString('hex')}.md`); fs.writeFileSync(f, text); return f; };

function project(name, files) {
  const root = path.join(HOME, name);
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'base']]) {
    assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  }
  const taskFile = path.join(HOME, `${name}-task.md`);
  const requirements = 'R1. Places the order safely.\nR2. Keeps the lot within limits.';
  fs.writeFileSync(taskFile, `# ${name}\n\n## Requirements\n${requirements}\n`);
  return { root, taskFile, task: state.pathKey(path.resolve(taskFile)), reqHash: sha(requirements) };
}
const finding = (title, location, over = {}) => ({ severity: 'MEDIUM', title, location, trigger: 't', harm: 'h', failure: 'f', fix: 'x', test: null, label: 'BUG', reqs: [], ...over });
const rows = (r1 = 'MET', r2 = 'MET') => [{ id: 'R1', status: r1, evidence: 'e1' }, { id: 'R2', status: r2, evidence: 'e2' }];
const normal = { level: 'normal', files: [], why: '-' };
const reviewAnswer = (findings = [], { cls = normal, reqs = rows() } = {}) => JSON.stringify({
  verdict: findings.length || reqs.some(r => r.status === 'NOT_MET' || r.status === 'PARTIAL') ? 'ISSUES_FOUND' : 'NO_ISSUES',
  findings, requirements: reqs, possibly_missing: [], class: cls, coverage: 'c' });
const marks = list => JSON.stringify({ marks: list.map(([id, mark, sameAs = null, evidence = mark === 'DISPUTE' ? 'src/x.js:1 guards it' : '']) => ({ id, mark, evidence, same_as: sameAs })) });
const followAnswer = (followups = [], cls = normal) => JSON.stringify({ verdict: followups.some(f => f.status === 'MAINTAIN') ? 'ISSUES_REMAIN' : 'RESOLVED',
  followups, findings: [], requirements: [], possibly_missing: [], class: cls, coverage: 'c' });
// The stub's answers by prompt: each reviewer's review and cross-check, and follow-ups (which resume reviewer A).
function setPair({ A = [], B = [], xA = [], xB = [], follow = [], single = [] }) {
  const withSession = (list, session) => list.map(a => (typeof a === 'string' ? { text: a, session } : { session, ...a }));
  fs.writeFileSync(SPEC, JSON.stringify({ byPrompt: [
    { match: 'Cross-check (you are reviewer A)', answers: withSession(xA, 'sess-A') },
    { match: 'Cross-check (you are reviewer B)', answers: withSession(xB, 'sess-B') },
    { match: 'reviewer A. Check', answers: withSession(A, 'sess-A') },
    { match: 'reviewer B. Attack', answers: withSession(B, 'sess-B') },
    { match: 'This is a follow-up round', answers: withSession(follow, 'sess-A') },
    { match: 'You review a code change', answers: withSession(single, 'sess-S') }, // (a single review: last, as pairs' prompts hold it too)
  ] }));
  fs.rmSync(LOG, { force: true });
}
const plan = (p, files) => ({ task: p.task, reqHash: p.reqHash, cases: [{ id: 'T1', text: 'an order without a stop is refused', test: 'tests/t.test.js' }], tests: files || [], at: 1 });
const pending = (rel, session = 'A') => ({ path: rel, session, at: 1, baseline: null });

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

test('a fallback chain keeps its trading file risky: a follow-up rated normal still needs its plan, at xhigh', async () => {
  const p = project('t1b', { 'src/EA.mq5': 'e0\n' });
  write(p.root, 'src/EA.mq5', 'e1\n');
  seed(p.root, s => { s.changes = { [key('src/EA.mq5')]: pending('src/EA.mq5') }; });
  // (the fresh follow-up's history holds reviewer A's prompt, so the stub routes it to A's answers)
  setPair({ A: [reviewAnswer(), followAnswer()], B: [{ fail: 'error: no such session', code: 1 }] });
  const r = await review.review(p.root, { session: 'A', taskFile: p.taskFile });
  assert.strictEqual(r.status, 'PAIR_INCOMPLETE', r.text);
  const answerFile = path.join(HOME, 't1b-answer.json');
  fs.writeFileSync(answerFile, reviewAnswer());
  const fb = review.fallback(p.root, { bundle: r.bundle, answerFile });
  assert.strictEqual(fb.status, 'DONE', fb.text);
  assert.ok(stateOf(p.root).changes[key('src/EA.mq5')], 'without a plan it stays pending');
  const f1 = await review.followup(p.root, { chain: fb.chain, responseFile: response('nothing changed') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  assert.ok(stateOf(p.root).changes[key('src/EA.mq5')], 'a normal rating never drops the plan it needs');
  assert.ok(execCalls().some(c => c.prompt.includes('This is a follow-up round') && c.args.includes('model_reasoning_effort=xhigh')));
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
    follow: [followAnswer(), followAnswer()] });
  const running = review.review(p.root, { session: 'A', taskFile: p.taskFile, risky: true });
  await waitFor(path.join(hold, 'started'));
  seed(p.root, s => { s.plans[k['src/store.js']] = { ...plan(p), cases: [{ id: 'T9', text: 'replaced', test: 'x' }] }; });
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  assert.ok(!execCalls().some(c => c.prompt.includes('Cross-check')), 'a pair with no findings on either side skips the cross-check');
  let s = stateOf(p.root);
  assert.deepStrictEqual(Object.keys(s.acks), [k['src/preset.set']]);
  assert.match(r.text, /not acknowledged until they have a current test plan[^\n]*src\/EA\.mq5/);
  assert.deepStrictEqual(s.needsPlan[k['src/EA.mq5']], [{ task: p.task, reqHash: p.reqHash }]);
  assert.ok(!s.escalations[k['src/EA.mq5']]); // (the pair read it in full)
  const f1 = await review.followup(p.root, { chain: r.chain, responseFile: response('nothing changed') });
  assert.strictEqual(f1.status, 'DONE', f1.text);
  assert.match(execCalls().slice(-1)[0].prompt, /## Test plans\n[\s\S]*- T9: replaced/, 'a plan that counts in this round is shown to it');
  s = stateOf(p.root);
  assert.ok(!s.acks[k['src/EA.mq5']], 'its skip never counts once GPT rated it risky for this task');
  for (const rel of ['src/Risk.mqh', 'src/Lots.mqh']) assert.ok(!s.acks[k[rel]], rel);
  assert.ok(s.acks[k['src/store.js']], 'this follow-up froze the replacement plan, so it counts now');
  seed(p.root, x => { for (const rel of ['src/EA.mq5', 'src/Risk.mqh', 'src/Lots.mqh', 'src/store.js']) x.plans[k[rel]] = plan(p); });
  const f2 = await review.followup(p.root, { chain: r.chain, responseFile: response('plans written') });
  assert.strictEqual(f2.status, 'DONE', f2.text);
  s = stateOf(p.root);
  for (const rel of Object.keys(files)) assert.ok(s.acks[k[rel]], `${rel} acknowledged`);
});

test('one merge keeps severity, row provenance and dispute evidence', () => {
  const twinA = finding('lot rounding', 'src/a.js:3', { severity: 'MEDIUM', title: 'A view', test: null });
  const twinB = finding('lot rounding', 'src/a.js:3', { severity: 'HIGH', title: 'B view', test: 'lot 0.015 -> 0.01', label: 'GAP' }); // (mixed labels: a BUG)
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
    ['B view', 'BUG', 'both'], ['gap twin', 'GAP', 'both'], ['confirmed', 'BUG', 'confirmed by B'],
    ['disputed', 'GAP', 'disputed by B: src/a.js:5 refuses it'], ['R2 is NOT MET', 'BUG', 'confirmed by B'], ['b on R2', 'GAP', 'disputed by A: R2 is checked at src/a.js:9']]);
  assert.deepStrictEqual([by['B view'].severity, by['B view'].test, by['B view'].by], ['HIGH', 'lot 0.015 -> 0.01', 'A+B']);
  assert.deepStrictEqual(m.requirements.map(r => r.status), ['NOT_MET', 'NOT_MET']);
  for (const r of m.requirements) assert.ok(m.findings.some(f => f.reqs.includes(r.id)), `${r.id} is linked, so no extra BUG is made for it`);
  assert.deepStrictEqual(m.class, { level: 'risky', files: ['src/other.js'], why: 'A: wa / B: wb' });
  assert.deepStrictEqual([m.possibly_missing, m.coverage, m.verdict], [['pa', 'pb'], 'A: ca / B: cb', 'ISSUES_FOUND']);
  assert.match(answer.render(m), /pair: disputed by B: src\/a\.js:5 refuses it/);
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
  assert.strictEqual(again.status, 'DONE', again.text);
  s = stateOf(p.root);
  assert.ok(s.changes[key('src/helper.js')], 'task 1 still needs its own plan for the file it found risky');
  assert.match(again.text, /not acknowledged until they have a current test plan[^\n]*src\/helper\.js/);
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
