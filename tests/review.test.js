// Tests for review.js, fresh reviews: only frozen versions count, state changes happen in one locked write, and a
// run that fails applies nothing (test plan P1 of step 2b). Codex is the recording stub fake-codex.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck review test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CROSSCHECK_HOME, 'config.json'), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js') }));
const STATE = path.join(__dirname, '..', 'src', 'state.js');
const state = require(STATE);
const review = require('../src/review');
const gaps = require('../src/gaps');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const setSpec = spec => { fs.writeFileSync(SPEC, JSON.stringify(spec)); fs.rmSync(LOG, { force: true }); };
const execCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.kind === 'exec');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 300 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const stateOf = root => state.read(state.files.project(root)).data;
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const key = rel => state.pathKey(rel);

// A git project with committed files, a task file and the given working-tree contents.
function project(name, committed, task = 'R1. Adds numbers.\nR2. Keeps the sum.') {
  const root = path.join(HOME, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [rel, text] of Object.entries(committed)) fs.writeFileSync(path.join(root, rel), text);
  const g = args => assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const taskFile = path.join(HOME, `${name}-task.md`);
  fs.writeFileSync(taskFile, `# ${name}\n\n## Requirements\n${task}\n\n## Notes\nNOTES-SENTINEL: Claude's reasoning\n`);
  return { root, taskFile, git: g };
}
const answerOf = (over = {}) => JSON.stringify({ verdict: 'NO_ISSUES', findings: [],
  requirements: [{ id: 'R1', status: 'MET', evidence: 'src/a.js:1' }, { id: 'R2', status: 'MET', evidence: 'src/a.js:1' }],
  possibly_missing: [], class: { level: 'normal', files: [], why: 'plain code' }, coverage: 'all checked', ...over });
const gapFinding = { severity: 'LOW', title: 'odd name', location: 'src/a.js:2', trigger: 'reading it', harm: 'none', failure: 'confusing',
  fix: 'rename', test: null, label: 'GAP', reqs: [] };
const change = (rel, session, at, baseline) => ({ path: rel, session, at, baseline });

test('a fresh review selects at admission and records frozen results after durable gaps', async () => {
  const { root, taskFile, git } = project('t1', { 'src/a.js': 'v0 committed\n', 'src/b.js': 'b\n', 'src/dé.js': 'deleted text\n' });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'v2 current\n');
  fs.writeFileSync(path.join(root, 'src/b.js'), 'b changed\n');
  git(['rm', '-q', 'src/dé.js']);
  const baselineText = 'v1 uncommitted baseline\n';
  fs.mkdirSync(path.join(state.projectDir(root), 'snap'), { recursive: true });
  fs.writeFileSync(path.join(state.projectDir(root), 'snap', sha(baselineText)), baselineText);
  seed(root, s => { // (src/dé.js was deleted by a shell command, so it has no change record)
    s.changes = { [key('src/a.js')]: change('src/a.js', 'A', 1, sha(baselineText)), [key('src/b.js')]: change('src/b.js', 'A', 2, null) };
  });
  fs.writeFileSync(path.join(root, gaps.NAME), '# Known gaps\n\n## G4 · open · 2026-10-01 · LOW\n- Where: src/x.js\n- Problem: old\n');
  assert.ok(gaps.addLesson(root, 'LESSON-SENTINEL').ok);
  const evidence = path.join(HOME, 't1-evidence.txt'); // (newer than every file still there, but a file was deleted)
  fs.writeFileSync(evidence, 'tests passed');
  setSpec({ exec: [{ text: answerOf({ verdict: 'ISSUES_FOUND', findings: [gapFinding],
    requirements: [{ id: 'R1', status: 'MET', evidence: 'src/a.js:1' }, { id: 'R2', status: 'PARTIAL', evidence: 'no sum check' }] }) }] });
  // another driver holds the state lock and hands src/b.js to session B while this review waits to be admitted
  const held = path.join(HOME, 't1-held');
  const other = spawn(process.execPath, ['-e', `const state = require(${JSON.stringify(STATE)});
    state.update(state.files.project(${JSON.stringify(root)}), s => {
      require('fs').writeFileSync(${JSON.stringify(held)}, '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      s.changes[${JSON.stringify(key('src/b.js'))}].session = 'B';
    });`], { env: process.env });
  const otherDone = new Promise(r => other.on('close', r));
  await waitFor(held);
  // the gap entry must be on disk before the state records the result
  const gapsFile = path.join(root, gaps.NAME);
  const realRename = fs.renameSync;
  let gapsWrittenFirst = null;
  fs.renameSync = (from, to) => {
    if (to === gapsFile) gapsWrittenFirst = !Object.keys(stateOf(root).chains || {}).length;
    return realRename(from, to);
  };
  let r;
  try {
    r = await review.review(root, { session: 'A', files: [process.platform === 'win32' ? 'SRC/DÉ.JS' : 'src/dé.js'], taskFile, evidenceFile: evidence });
  } finally {
    fs.renameSync = realRename;
  }
  await otherDone;
  assert.strictEqual(r.status, 'DONE', r.text);
  assert.strictEqual(gapsWrittenFirst, true);
  assert.match(fs.readFileSync(gapsFile, 'utf8'), /\n## G5 · open · \S+ · LOW\n- Task: t1\n- Where: src\/a\.js:2\n- Problem: F1: odd name\n/);
  const [call] = execCalls();
  assert.match(call.prompt, /R2\. Keeps the sum\./);
  assert.ok(!call.prompt.includes('NOTES-SENTINEL'));
  assert.match(call.prompt, /LESSON-SENTINEL/);
  assert.match(call.prompt, /Supplied by Claude and unverified; STALE: a reviewed file was deleted/);
  assert.match(call.prompt, /-v1 uncommitted baseline\n\+v2 current/);
  assert.ok(!call.prompt.includes('v0 committed'));
  assert.match(call.prompt, /### src\/dé\.js \(deleted\)\nIts last version:\n```\ndeleted text/);
  assert.ok(call.prompt.includes(`- src/a.js: ${path.join(state.projectDir(root), 'snap', sha('v2 current\n'))}`));
  assert.ok(call.prompt.includes('- src/dé.js: (deleted)'));
  assert.ok(!call.prompt.includes('src/b.js'));
  const s = stateOf(root);
  const chain = s.chains[r.chain];
  assert.deepStrictEqual(Object.keys(chain.findings), ['F1', 'F2']);
  assert.deepStrictEqual([chain.findings.F1.label, chain.findings.F1.key, chain.findings.F1.gap], ['GAP', key('src/a.js'), 'G5']);
  assert.deepStrictEqual([chain.findings.F2.label, chain.findings.F2.severity, chain.findings.F2.key, chain.findings.F2.reqs], ['BUG', 'MEDIUM', null, ['R2']]);
  assert.ok(fs.readFileSync(path.join(root, gaps.NAME), 'utf8').startsWith('# Known gaps\n\n## G4 · open · 2026-10-01 · LOW\n- Where: src/x.js\n- Problem: old\n'));
  assert.deepStrictEqual(Object.keys(s.acks).sort(), [key('src/a.js'), key('src/dé.js')].sort());
  assert.strictEqual(s.acks[key('src/dé.js')], review.DELETED);
  assert.deepStrictEqual(Object.keys(s.changes), [key('src/b.js')]);
  assert.strictEqual(s.changes[key('src/b.js')].session, 'B');
  assert.strictEqual(s.applied[chain.rounds[0]], true);
  assert.strictEqual(chain.rev, 1);
  assert.deepStrictEqual(s.running, {});
});

test('a newer hooked edit stays pending with its owner kept and the frozen copy as its baseline', async () => {
  const { root, taskFile } = project('t2', { 'src/a.js': 'a0\n', 'src/c.js': 'c0\n' });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'a1\n');
  fs.writeFileSync(path.join(root, 'src/c.js'), 'c1\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: change('src/a.js', 'A', 1, null), [key('src/c.js')]: change('src/c.js', 'A', 2, null) }; });
  const hold = fs.mkdtempSync(path.join(HOME, 't2-hold-'));
  setSpec({ exec: [{ hold, text: answerOf() }] });
  const running = review.review(root, { session: 'A', taskFile });
  await waitFor(path.join(hold, 'started'));
  seed(root, s => { s.changes[key('src/a.js')] = { ...s.changes[key('src/a.js')], session: 'B', at: 99, note: 'kept' }; });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'a2 edited by B\n');
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  const s = stateOf(root);
  const a = s.changes[key('src/a.js')];
  assert.deepStrictEqual([a.session, a.at, a.note, a.baseline], ['B', 99, 'kept', sha('a1\n')]);
  assert.strictEqual(s.acks[key('src/a.js')], undefined);
  assert.strictEqual(s.acks[key('src/c.js')], sha('c1\n'));
  assert.strictEqual(s.changes[key('src/c.js')], undefined);
  assert.deepStrictEqual(s.running, {});
});

test('changed requirements acknowledge nothing, and a risky rating stays escalated', async () => {
  const { root, taskFile } = project('t3', { 'src/a.js': 'a0\n', 'src/m.js': 'm0\n' });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'a1\n');
  fs.writeFileSync(path.join(root, 'src/m.js'), 'm1 moves money\n');
  seed(root, s => { s.changes = { [key('src/a.js')]: change('src/a.js', 'A', 1, null), [key('src/m.js')]: change('src/m.js', 'A', 2, null) }; });
  const hold = fs.mkdtempSync(path.join(HOME, 't3-hold-'));
  setSpec({ exec: [{ hold, text: answerOf({ class: { level: 'risky', files: ['src/m.js'], why: 'it moves money' } }) }] });
  const running = review.review(root, { session: 'A', taskFile });
  await waitFor(path.join(hold, 'started'));
  fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace('R2. Keeps the sum.', 'R2. Keeps the sum, rounded.'));
  fs.writeFileSync(path.join(hold, 'go'), '');
  const r = await running;
  assert.strictEqual(r.status, 'DONE', r.text);
  let s = stateOf(root);
  assert.deepStrictEqual(s.acks, {});
  assert.deepStrictEqual(Object.keys(s.changes).sort(), [key('src/a.js'), key('src/m.js')].sort());
  assert.ok(s.chains[r.chain]);
  assert.strictEqual(s.escalations[key('src/m.js')].chain, r.chain);
  const calls = execCalls().length;
  const again = await review.review(root, { session: 'A', files: ['src/m.js'], taskFile });
  assert.strictEqual(again.status, 'REFUSED');
  assert.match(again.text, /paired review/);
  assert.strictEqual(execCalls().length, calls);
  s = stateOf(root);
  assert.ok(s.escalations[key('src/m.js')]);
  assert.ok(s.changes[key('src/m.js')]);
});

test('a dead reservation is reclaimed, but an overlapping live review can neither take nor clear one', async () => {
  const { root, taskFile } = project('t4', { 'src/a.js': 'a0\n' });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'a1\n');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  seed(root, s => {
    s.changes = { [key('src/a.js')]: change('src/a.js', 'A', 1, null) };
    s.running = { [key('src/a.js')]: { attempt: 'crashed', pid: dead }, [key('src/other.js')]: { attempt: 'other', pid: process.pid } };
  });
  const hold = fs.mkdtempSync(path.join(HOME, 't4-hold-'));
  setSpec({ exec: [{ hold, text: answerOf() }] });
  const first = review.review(root, { session: 'A', taskFile });
  await waitFor(path.join(hold, 'started'));
  const mark = stateOf(root).running[key('src/a.js')];
  assert.strictEqual(mark.pid, process.pid);
  assert.notStrictEqual(mark.attempt, 'crashed');
  const second = await review.review(root, { session: 'B', files: [process.platform === 'win32' ? 'SRC/A.JS' : 'src/a.js'], taskFile });
  assert.strictEqual(second.status, 'REFUSED');
  assert.match(second.text, /already in a running review/);
  assert.strictEqual(execCalls().length, 1);
  assert.deepStrictEqual(stateOf(root).running[key('src/a.js')], mark);
  fs.writeFileSync(path.join(hold, 'go'), '');
  assert.strictEqual((await first).status, 'DONE');
  const s = stateOf(root);
  assert.deepStrictEqual(s.running, { [key('src/other.js')]: { attempt: 'other', pid: process.pid } });
  assert.strictEqual(s.acks[key('src/a.js')], sha('a1\n'));
});

test('an answer still wrong after its one repair applies nothing and keeps its bundle', async () => {
  const { root, taskFile } = project('t5', { 'src/a.js': 'a0\n' });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'a1\n');
  seed(root, s => {
    s.changes = { [key('src/a.js')]: change('src/a.js', 'A', 7, null) };
    s.acks = { [key('src/z.js')]: 'old' };
    s.escalations = { [key('src/y.js')]: { chain: 'Cold', at: 1 } };
    s.chains = { Cold: { rev: 3, closed: false, findings: {} } };
  });
  fs.writeFileSync(path.join(root, gaps.NAME), '# Known gaps\n');
  const before = stateOf(root);
  const wrong = answerOf({ verdict: 'ISSUES_FOUND', findings: [{ ...gapFinding, location: 'src/unreviewed.js:3', label: 'BUG' }] });
  setSpec({ exec: [{ text: wrong }, { text: wrong }, { text: answerOf() }] });
  const r = await review.review(root, { session: 'A', taskFile });
  assert.strictEqual(r.status, 'NOT_DONE');
  assert.match(r.text, /still has problems after its repair/);
  const calls = execCalls();
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[1].args.slice(0, 2), ['exec', 'resume']);
  assert.ok(calls[1].args.includes('0123abcd-0000-4000-8000-00000000c0de'));
  assert.deepStrictEqual(stateOf(root), { ...before, running: {}, applied: {} });
  assert.strictEqual(fs.readFileSync(path.join(root, gaps.NAME), 'utf8'), '# Known gaps\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(r.bundle, 'manifest.json'), 'utf8'));
  assert.deepStrictEqual(manifest.files[key('src/a.js')], { path: 'src/a.js', at: 7, session: 'A', baseline: null, frozen: sha('a1\n') });
  assert.ok(manifest.admittedAt > 0);
  assert.ok(fs.existsSync(path.join(r.bundle, 'prompt.md')));
});

test('named files without a hook record stay pending when edited, and are next diffed from their reviewed version', async () => {
  const { root, taskFile } = project('t6', { 'src/n.js': 'n0\n', 'src/p.js': `top\nOLD\n${'mid\n'.repeat(20)}far\n` });
  fs.writeFileSync(path.join(root, 'src/n.js'), 'n1\n');
  const reviewedP = `top\nFIX\n${'mid\n'.repeat(20)}far\n`;
  fs.writeFileSync(path.join(root, 'src/p.js'), reviewedP);
  const hold = fs.mkdtempSync(path.join(HOME, 't6-hold-'));
  setSpec({ exec: [{ hold, text: answerOf() }, { text: answerOf() }] });
  const running = review.review(root, { files: ['src/n.js', 'src/p.js'], taskFile });
  await waitFor(path.join(hold, 'started'));
  fs.writeFileSync(path.join(root, 'src/n.js'), 'n2 shell edit\n');
  fs.writeFileSync(path.join(hold, 'go'), '');
  assert.strictEqual((await running).status, 'DONE');
  const s = stateOf(root);
  assert.deepStrictEqual(s.changes[key('src/n.js')] && [s.changes[key('src/n.js')].session, s.changes[key('src/n.js')].baseline], [null, sha('n1\n')]);
  assert.strictEqual(s.acks[key('src/p.js')], sha(reviewedP));
  // a shell edit reverts the reviewed fix (back to HEAD's line) and changes a distant line
  const evidence = path.join(HOME, 't6-evidence.txt');
  fs.writeFileSync(evidence, 'tests passed');
  const old = new Date(Date.now() - 3600000);
  fs.utimesSync(evidence, old, old);
  fs.writeFileSync(path.join(root, 'src/p.js'), `top\nOLD\n${'mid\n'.repeat(20)}far2\n`);
  assert.strictEqual((await review.review(root, { files: ['src/p.js'], taskFile, evidenceFile: evidence })).status, 'DONE');
  const prompt = execCalls()[1].prompt;
  assert.match(prompt, /-FIX\n\+OLD/);
  assert.match(prompt, /-far\n\+far2/);
  assert.match(prompt, /Supplied by Claude and unverified; STALE: it is older than the last change to a reviewed file/);
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
