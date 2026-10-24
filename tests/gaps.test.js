// Tests for gaps.js: the record of known gaps is never lost, never rewritten, and holds no personal details
// (test plan P1 of step 2a).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck gaps test ü '));
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), USERPROFILE: HOME, HOME });
const GAPS = path.join(__dirname, '..', 'src', 'gaps.js');
const gaps = require(GAPS);
const state = require('../src/state');

const project = name => {
  const root = path.join(HOME, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
};
// A file as the old setup wrote it: prose, two entries, an extra field, CRLF line endings.
const LEGACY = [
  '# Known gaps', '', 'Findings left unfixed on purpose, written by gpt.js.', '',
  '## G2 · open · 2026-10-18 · HIGH', '- Task: old task', '- Where: src/state.js:10', '- Problem: old problem A',
  '- Trigger: rare', '- Fix: - — test: -', '- Log: a.md', '- Why skipped: harmless', '- Note: an extra field', '',
  '## G12 · open · 2026-10-19 · LOW', '- Task: old task', '- Where: src/gaps.js:4', '- Problem: old problem B',
  '- Trigger: rare', '- Fix: -', '- Log: b.md', '- Why skipped: harmless', '',
].join('\r\n');
const finding = (problem, where = 'src/state.js:30') => ({ task: 'step 2a', where: [where], problem, trigger: 't', severity: 'MEDIUM', fix: 'f', log: 'c.md', why: 'w' });
const gapsFile = root => path.join(root, gaps.NAME);
const lockDir = root => `${state.files.project(root)}.lock`;

test('concurrent additions preserve every finding and allocate unique ids', async () => {
  const root = project('t1');
  fs.writeFileSync(gapsFile(root), LEGACY);
  const go = path.join(HOME, 'go');
  const worker = path.join(HOME, 'worker.js');
  fs.writeFileSync(worker, `const fs = require('fs'); const gaps = require(${JSON.stringify(GAPS)});
    while (!fs.existsSync(${JSON.stringify(go)})) {}
    const own = process.argv[2];
    const shared = { task: 'step 2a', where: ['src/shared.js:1'], problem: 'shared problem', trigger: 't', severity: 'LOW', fix: 'f', log: 'c.md', why: 'w' };
    console.log(JSON.stringify(gaps.add(${JSON.stringify(root)}, [{ ...shared, problem: own, where: ['src/' + own + '.js:1'] }, shared])));`);
  const run = tag => new Promise(resolve => {
    const child = spawn(process.execPath, [worker, tag], { env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => resolve(JSON.parse(out)));
  });
  const both = Promise.all([run('a'), run('b')]);
  setTimeout(() => fs.writeFileSync(go, ''), 200);
  const results = await both;
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  const text = fs.readFileSync(gapsFile(root), 'utf8');
  assert.ok(text.startsWith(LEGACY));
  const added = gaps.list(root).entries.slice(2);
  assert.deepStrictEqual(added.map(e => e.id).sort(), ['G13', 'G14', 'G15']);
  assert.deepStrictEqual(added.map(e => e.fields.Problem).sort(), ['a', 'b', 'shared problem']);
});

test('legacy records survive addition and closure without their text being rewritten', () => {
  const root = project('t2');
  fs.writeFileSync(gapsFile(root), LEGACY);
  assert.deepStrictEqual(gaps.add(root, [finding('new problem')]), { ok: true, ids: ['G13'] });
  const afterAdd = fs.readFileSync(gapsFile(root), 'utf8');
  assert.ok(afterAdd.startsWith(LEGACY));
  assert.deepStrictEqual(gaps.add(root, [finding('new problem')]), { ok: true, ids: [] }); // (recorded once)
  assert.strictEqual(gaps.mark(root, 'G2', 'fixed').ok, true);
  assert.strictEqual(gaps.mark(root, 'G12', 'fixed — was a real bug').ok, true);
  const expected = afterAdd.replace('## G2 · open · 2026-10-18 · HIGH\r\n', '## G2 · fixed · 2026-10-18 · HIGH\r\n')
    .replace('## G12 · open · 2026-10-19 · LOW\r\n', '## G12 · fixed — was a real bug · 2026-10-19 · LOW\r\n');
  assert.strictEqual(fs.readFileSync(gapsFile(root), 'utf8'), expected);
  assert.deepStrictEqual(gaps.list(root).entries.map(e => [e.id, e.status]), [['G2', 'fixed'], ['G12', 'fixed — was a real bug'], ['G13', 'open']]);
  assert.deepStrictEqual(gaps.openFor(root, path.join(root, 'src', 'state.js')).map(e => e.id), ['G13']);
  assert.deepStrictEqual(gaps.openFor(root, path.join(root, 'src', 'gaps.js')), []);
});

test('a failed atomic replacement leaves the original gaps file, no temporary file and no lock', () => {
  const root = project('t3');
  fs.writeFileSync(gapsFile(root), LEGACY);
  const realRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (from, to) => {
    if (to !== gapsFile(root)) return realRename(from, to);
    attempts++;
    assert.ok(fs.readFileSync(from, 'utf8').startsWith(LEGACY) && fs.readFileSync(from, 'utf8').includes('busy problem'));
    assert.strictEqual(fs.readFileSync(to, 'utf8'), LEGACY);
    assert.ok(fs.existsSync(lockDir(root)));
    throw Object.assign(new Error('busy'), { code: 'EACCES' });
  };
  try {
    assert.throws(() => gaps.add(root, [finding('busy problem')]), /busy/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(attempts > 1);
  assert.strictEqual(fs.readFileSync(gapsFile(root), 'utf8'), LEGACY);
  assert.deepStrictEqual(fs.readdirSync(root), [gaps.NAME]);
  assert.ok(!fs.existsSync(lockDir(root)));
});

test('an unreadable gaps file is never replaced with an empty history', () => {
  const root = project('t4');
  fs.writeFileSync(gapsFile(root), LEGACY);
  const realRead = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (p === gapsFile(root)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return realRead(p, ...rest);
  };
  let result;
  try {
    result = gaps.add(root, [finding('lost problem')]);
  } finally {
    fs.readFileSync = realRead;
  }
  assert.strictEqual(result.ok, false);
  assert.match(result.why, /can't be read/);
  assert.strictEqual(fs.readFileSync(gapsFile(root), 'utf8'), LEGACY);
  assert.ok(!fs.existsSync(lockDir(root)));
});

test('new entries hold no personal details, in paths or in free text', () => {
  const root = project('t5');
  const where = `${path.join(root, 'src', 'state.js')}:27`;
  const r = gaps.add(root, [{
    task: 'step 2a', where: [where], severity: 'LOW', fix: `see ${root.replace(/\\/g, '/')}/src/state.js`,
    problem: `reviewer@example.test saw it in ${path.join(HOME, 'other', 'notes.txt')}`, trigger: `run from ${root}`,
    log: path.join(HOME, 'logs', 'run.md'), why: 'harmless',
  }]);
  assert.deepStrictEqual(r, { ok: true, ids: ['G1'] });
  const text = fs.readFileSync(gapsFile(root), 'utf8');
  for (const secret of [root, root.replace(/\\/g, '/'), HOME, HOME.replace(/\\/g, '/'), 'reviewer@example.test']) {
    assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `the file still holds ${secret}`);
  }
  const [entry] = gaps.list(root).entries;
  assert.strictEqual(entry.fields.Where, 'src/state.js:27');
  assert.strictEqual(entry.fields.Log, 'run.md');
  assert.match(entry.fields.Problem, /<e-mail> saw it in ~[\\/]other[\\/]notes\.txt/);
});

test('a home folder at the filesystem root leaves paths readable', () => {
  const root = project('t6');
  const tool = path.join(path.parse(HOME).root, 'tools', 'app.js'); // (outside the project; no personal detail)
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  Object.assign(process.env, { USERPROFILE: path.parse(HOME).root, HOME: path.parse(HOME).root });
  try {
    assert.deepStrictEqual(gaps.add(root, [finding(`breaks ${tool}`, 'src/state.js:27')]), { ok: true, ids: ['G1'] });
  } finally {
    Object.assign(process.env, saved);
  }
  assert.strictEqual(gaps.list(root).entries[0].fields.Where, 'src/state.js:27');
  assert.strictEqual(gaps.list(root).entries[0].fields.Problem, `breaks ${tool}`);
  assert.deepStrictEqual(gaps.openFor(root, path.join(root, 'src', 'state.js')).map(e => e.id), ['G1']);
});

test('gap bookkeeping counts as reviewed only from the reviewed text it changed, after its state write', () => {
  const review = require('../src/review');
  const sha = text => require('crypto').createHash('sha256').update(text).digest('hex');
  const key = state.pathKey(gaps.NAME);
  const stateOf = root => state.read(state.files.project(root)).data;
  const handEdited = LEGACY.replace(/## G2 [\s\S]*?\r\n\r\n/, ''); // (a hand edit deletes G2's HIGH finding)
  const chain = { rev: 1, began: 1, rounds: ['r1'], closed: false, files: {}, frozen: {}, task: { title: 'task' },
    findings: { F1: { label: 'BUG', status: 'open', severity: 'MEDIUM', title: 'off by one', location: 'src/a.js:1', trigger: 't', harm: 'h', fix: 'f', test: null } } };
  const reviewed = (name, more = () => {}) => {
    const root = project(name);
    fs.writeFileSync(gapsFile(root), LEGACY);
    assert.ok(state.update(state.files.project(root), s => { s.acks = { [key]: sha(LEGACY) }; s.chains = { C1: JSON.parse(JSON.stringify(chain)) }; more(s); }).ok);
    return root;
  };
  const writers = { // (gap --add and gap --fixed as the CLI runs them, and a close that records a BUG as a gap)
    add: root => gaps.add(root, [finding('new problem')], review.acknowledgeGaps(root)),
    mark: root => gaps.mark(root, 'G12', 'fixed', review.acknowledgeGaps(root)),
    close: root => review.close(root, { chain: 'C1', notes: { F1: 'gap: the feature is off' }, rev: 1 }),
  };
  for (const [name, write] of Object.entries(writers)) {
    const clean = reviewed(`t7-${name}-clean`);
    write(clean);
    assert.notStrictEqual(fs.readFileSync(gapsFile(clean), 'utf8'), LEGACY, `${name} wrote`);
    assert.strictEqual(stateOf(clean).acks[key], sha(fs.readFileSync(gapsFile(clean))), `${name}: its own write counts as reviewed`);
    // (the writer reads a hand edit, then the file is restored to its reviewed bytes, so a second read would match)
    const raced = reviewed(`t7-${name}-raced`);
    fs.writeFileSync(gapsFile(raced), handEdited);
    const realRead = fs.readFileSync;
    let restored = false;
    fs.readFileSync = (p, ...rest) => {
      const out = realRead(p, ...rest);
      if (!restored && p === gapsFile(raced)) { restored = true; fs.writeFileSync(p, LEGACY); }
      return out;
    };
    try {
      write(raced);
    } finally {
      fs.readFileSync = realRead;
    }
    assert.ok(restored && !fs.readFileSync(gapsFile(raced), 'utf8').includes('## G2 '), `${name} kept the text it read`);
    assert.strictEqual(stateOf(raced).acks[key], sha(LEGACY), `${name}: the hand deletion is never acknowledged`);
    // (a pending change keeps the file pending, even one whose text matches its reviewed version)
    const held = reviewed(`t7-${name}-pending`, s => { s.changes = { [key]: { path: gaps.NAME, session: 'A', at: 1, baseline: sha(LEGACY) } }; });
    write(held);
    assert.deepStrictEqual([stateOf(held).acks[key], !!stateOf(held).changes[key]], [sha(LEGACY), true], `${name}: still pending`);
  }
  const fresh = project('t7-fresh'); // (a file crosscheck creates has no reviewed version: it stays unreviewed)
  gaps.add(fresh, [finding('first')], review.acknowledgeGaps(fresh));
  assert.strictEqual((stateOf(fresh).acks || {})[key], undefined);
  const failing = reviewed('t7-failing');
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === state.files.project(failing)) throw Object.assign(new Error('busy'), { code: 'EACCES' });
    return realRename(from, to);
  };
  try {
    assert.throws(() => gaps.add(failing, [finding('later')], review.acknowledgeGaps(failing)), /busy/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.match(fs.readFileSync(gapsFile(failing), 'utf8'), /- Problem: later/);
  assert.strictEqual(stateOf(failing).acks[key], sha(LEGACY), 'a failed state write leaves the new text unreviewed');
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
