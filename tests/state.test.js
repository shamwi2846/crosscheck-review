// Tests for state.js: review state is never lost or corrupted (test plan P2).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-state-test-'));
process.env.CROSSCHECK_HOME = HOME;
const STATE = path.join(__dirname, '..', 'src', 'state.js');
const state = require(STATE);

const seed = (name, text) => {
  const file = path.join(HOME, name, 'state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

test('existing non-object state is never overwritten', () => {
  const original = '[{"id":"F1","status":"open"}]';
  const file = seed('t1', original);
  let called = false;
  const r = state.update(file, data => { called = true; Object.keys(data).forEach(k => delete data[k]); });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(called, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
});

test('concurrent processes preserve every project update', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck repo ü '));
  assert.strictEqual(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const nested = path.join(repo, 'src', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  const file = state.files.project(state.projectRoot(repo));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ findings: { F0: 'open' }, acks: { 'a.js': 'h1' } }));
  const go = path.join(HOME, 'go');
  const worker = path.join(HOME, 'worker.js');
  fs.writeFileSync(worker, `const fs = require('fs'); const state = require(${JSON.stringify(STATE)});
    while (!fs.existsSync(${JSON.stringify(go)})) {}
    const root = state.projectRoot(process.cwd());
    for (let i = 0; i < 25; i++) {
      const r = state.update(state.files.project(root), d => { d.findings[process.argv[2] + '-' + i] = 'open'; });
      if (!r.ok) { console.error(r.why); process.exit(1); }
    }
    console.log(root);`);
  const run = (cwd, tag) => new Promise(resolve => {
    const child = spawn(process.execPath, [worker, tag], { cwd, env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, root: out.trim() }));
  });
  const both = Promise.all([run(repo, 'A'), run(nested, 'B')]);
  setTimeout(() => fs.writeFileSync(go, ''), 200);
  const [a, b] = await both;
  assert.strictEqual(a.code, 0);
  assert.strictEqual(b.code, 0);
  assert.strictEqual(a.root, b.root);
  const final = state.read(file).data;
  assert.strictEqual(Object.keys(final.findings).length, 51);
  assert.strictEqual(final.findings.F0, 'open');
  assert.deepStrictEqual(final.acks, { 'a.js': 'h1' });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('Windows rename contention preserves atomic replacement', () => {
  const file = seed('t3', JSON.stringify({ findings: { F1: 'open' } }));
  const original = fs.readFileSync(file, 'utf8');
  const realRename = fs.renameSync;
  let failures = 0;
  fs.renameSync = (from, to) => {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(from, 'utf8')), { findings: { F1: 'open', F2: 'open' } });
    assert.strictEqual(fs.readFileSync(to, 'utf8'), original);
    assert.ok(fs.existsSync(`${file}.lock`));
    if (failures < 2) {
      failures++;
      throw Object.assign(new Error('busy'), { code: 'EPERM' });
    }
    return realRename(from, to);
  };
  try {
    assert.strictEqual(state.update(file, d => { d.findings.F2 = 'open'; }).ok, true);
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(failures, 2);
  assert.deepStrictEqual(state.read(file).data, { findings: { F1: 'open', F2: 'open' } });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('a throwing updater commits nothing and releases its lock', () => {
  const file = seed('t4', JSON.stringify({ findings: { F1: 'open' }, acks: { 'a.js': 'h1' } }));
  const original = fs.readFileSync(file, 'utf8');
  assert.throws(() => state.update(file, d => { delete d.findings.F1; throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  assert.ok(!fs.existsSync(`${file}.lock`));
  assert.strictEqual(state.update(file, d => { d.findings.F2 = 'open'; }).ok, true);
  assert.deepStrictEqual(state.read(file).data, { findings: { F1: 'open', F2: 'open' }, acks: { 'a.js': 'h1' } });
});

test("a live driver's lock is never taken, not even one taken just after it was seen abandoned, and an abandoned one is reclaimed", () => {
  const file = seed('t5', JSON.stringify({ findings: { F1: 'open' } }));
  const original = fs.readFileSync(file, 'utf8');
  const lockDir = `${file}.lock`;
  const owner = path.join(lockDir, 'owner');
  const ended = spawnSync(process.execPath, ['-e', '']).pid; // a driver that crashed holding the lock
  fs.mkdirSync(lockDir);
  fs.writeFileSync(owner, `${ended} crashed`);
  // right after this driver has seen that lock abandoned, another driver reclaims it, then stalls for a day (a
  // system sleep, say); it is alive, so its lock must be left alone
  const otherDriver = `${process.pid} other`;
  const realRead = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = (p, ...rest) => {
    const seen = realRead(p, ...rest);
    if (p === owner && !swapped) {
      swapped = true;
      fs.rmSync(lockDir, { recursive: true });
      fs.mkdirSync(lockDir);
      fs.writeFileSync(owner, otherDriver);
      const stalled = new Date(Date.now() - 24 * 3600000);
      fs.utimesSync(lockDir, stalled, stalled);
    }
    return seen;
  };
  let called = false;
  const started = Date.now();
  let busy;
  try {
    busy = state.update(file, () => { called = true; });
  } finally {
    fs.readFileSync = realRead;
  }
  const waited = Date.now() - started;
  assert.ok(swapped);
  assert.strictEqual(busy.ok, false);
  assert.strictEqual(called, false);
  assert.ok(waited >= 7900 && waited < 12000, `waited ${waited} ms`);
  assert.strictEqual(fs.readFileSync(owner, 'utf8'), otherDriver);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(owner, `${ended} crashed`); // (now that driver crashed too)
  assert.strictEqual(state.update(file, d => { d.findings.F2 = 'open'; }).ok, true);
  assert.ok(!fs.existsSync(lockDir));
  assert.deepStrictEqual(state.read(file).data, { findings: { F1: 'open', F2: 'open' } });
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
