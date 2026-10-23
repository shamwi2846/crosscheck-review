// Tests for hook.js (test plan P2 of step 4): the gates that keep unplanned trading edits, unreviewed commits,
// unreviewed plans and a second desktop operator out, and the baseline that keeps a review honest.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck hook test ü '));
process.env.CROSSCHECK_HOME = path.join(HOME, 'state');
const state = require('../src/state');
const review = require('../src/review');
const hook = require('../src/hook');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const key = rel => state.pathKey(rel);
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const seedGlobal = fn => assert.ok(state.update(state.files.global(), fn).ok);
const stateOf = root => state.read(state.files.project(root)).data;
const denial = answer => answer && answer.hookSpecificOutput && answer.hookSpecificOutput.permissionDecision === 'deny'
  ? answer.hookSpecificOutput.permissionDecisionReason : null;

// A git project with committed files.
function project(name, committed = {}) {
  const root = path.join(HOME, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [rel, text] of Object.entries({ 'README.md': 'r\n', ...committed })) fs.writeFileSync(path.join(root, rel), text);
  const g = args => assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  return fs.realpathSync.native(root);
}
const writeTask = (root, session, reqs) => {
  const file = state.files.task(root, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# task\n\n## Requirements\n${reqs}\n\n## Notes\nanything\n`);
  return review.sessionTask(root, session);
};
const edit = (root, rel, session) => hook.handle('edit', { session_id: session, cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, rel), content: 'x' } });

test('a trading Write needs a current plan or skip, and its baseline is the original or the last reviewed version', () => {
  const root = project('t1', { 'src/EA.mq5': 'committed\n' });
  fs.writeFileSync(path.join(root, 'src/EA.mq5'), 'O uncommitted\n');
  const k = key('src/EA.mq5');
  const PATH = process.env.PATH;
  const noGit = fn => { process.env.PATH = ''; try { return fn(); } finally { process.env.PATH = PATH; } }; // (an edit makes no git call)
  assert.match(denial(edit(root, 'src/EA.mq5', 'S')), /task file/);
  let task = writeTask(root, 'S', 'R1. Trades safely.');
  seed(root, s => { s.plans = { [k]: { task: 'another task', reqHash: task.reqHash, cases: [] } }; });
  assert.match(denial(noGit(() => edit(root, 'src/EA.mq5', 'S'))), /testplan --files "src\/EA\.mq5"/);
  assert.deepStrictEqual(stateOf(root).changes || {}, {}, 'a denied edit records nothing');
  seed(root, s => { s.skips = { [k]: { task: task.id, reqHash: task.reqHash, why: 'w' } }; });
  assert.strictEqual(noGit(() => edit(root, 'src/EA.mq5', 'S')), null);
  const baseline = stateOf(root).changes[k].baseline;
  assert.strictEqual(fs.readFileSync(path.join(state.projectDir(root), 'snap', baseline), 'utf8'), 'O uncommitted\n');
  fs.writeFileSync(path.join(root, 'src/EA.mq5'), 'written by Claude\n');
  task = writeTask(root, 'S', 'R1. Trades safely.\nR2. Keeps a stop loss.');
  assert.match(denial(edit(root, 'src/EA.mq5', 'S')), /no longer counts/, 'the old skip is stale');
  seed(root, s => { s.skips[k] = { task: task.id, reqHash: task.reqHash, why: 'w' }; s.escalations = { [k]: { chain: 'C1', at: 1 } }; });
  assert.match(denial(edit(root, 'src/EA.mq5', 'S')), /skip no longer counts/);
  seed(root, s => { delete s.escalations[k]; s.needsPlan = { [k]: [{ task: task.id, reqHash: task.reqHash }] }; });
  assert.match(denial(edit(root, 'src/EA.mq5', 'S')), /skip no longer counts/);
  seed(root, s => { s.plans[k] = { task: task.id, reqHash: task.reqHash, cases: [] }; });
  assert.strictEqual(noGit(() => edit(root, 'src/EA.mq5', 'S')), null);
  assert.strictEqual(stateOf(root).changes[k].baseline, baseline, 'later edits keep the original');
  // reviewed and acknowledged, then changed by a shell command: the next baseline is the reviewed version
  const reviewed = sha('written by Claude\n');
  fs.copyFileSync(path.join(root, 'src/EA.mq5'), path.join(state.projectDir(root), 'snap', reviewed));
  seed(root, s => { s.acks = { [k]: reviewed }; delete s.changes[k]; });
  fs.writeFileSync(path.join(root, 'src/EA.mq5'), 'shell change\n');
  assert.strictEqual(noGit(() => edit(root, 'src/EA.mq5', 'S')), null);
  assert.strictEqual(stateOf(root).changes[k].baseline, reviewed);
  // through a linked project folder, the file keeps its project-relative key
  const link = path.join(HOME, 't1 link');
  fs.symlinkSync(root, link, 'junction');
  assert.strictEqual(edit(link, 'README.md', 'S'), null);
  assert.strictEqual(stateOf(root).changes[key('README.md')].path, 'README.md');
});

test('the desktop stays GPT\'s while its driver or worker lives, and Claude\'s tools need this session\'s window', async () => {
  const screen = session => hook.handle('screen', { session_id: session, cwd: HOME, tool_name: 'mcp__computer-use__screenshot', tool_input: {} });
  const sleeper = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const ended = child => new Promise(resolve => { child.on('exit', resolve); child.kill(); });
  const driver = sleeper();
  const worker = sleeper();
  seedGlobal(g => Object.assign(g, { off: true, screen: { session: 'S', until: Date.now() + 60000 }, desktop: { pid: driver.pid, workers: [worker.pid], project: 'p' } }));
  assert.match(denial(screen('S')), /GPT is operating the desktop/, 'even with the switch off');
  await ended(driver);
  assert.match(denial(screen('S')), /GPT is operating the desktop/, 'its worker still owns it');
  await ended(worker);
  seedGlobal(g => { g.off = false; });
  assert.strictEqual(screen('S'), null);
  assert.match(denial(screen('T')), /Another Claude session/);
  seedGlobal(g => { g.screen.until = Date.now() - 1; });
  assert.match(denial(screen('S')), /allow-screen/);
  seedGlobal(g => { g.screen.until = Date.now() + 60000; });
  fs.writeFileSync(state.files.global(), '{ not json');
  assert.match(denial(screen('S')), /refused/);
  // (the real entry point, reading stdin and writing stdout, fails closed too)
  const real = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'hook.js'), 'screen'], { input: JSON.stringify({ session_id: 'S', tool_name: 'mcp__computer-use__screenshot' }), encoding: 'utf8' });
  assert.match(denial(JSON.parse(real.stdout)), /refused/);
  fs.rmSync(state.files.global());
});

test('a commit is refused while the chosen repository has unreviewed changes or an open BUG', () => {
  const a = project('t3 a');
  const b = project('t3 b with spaces', { 'src/old.js': 'old\n' });
  fs.writeFileSync(path.join(b, 'src/old.js'), 'changed by a shell\n');
  fs.writeFileSync(path.join(b, 'src/new.js'), 'new\n');
  fs.writeFileSync(path.join(b, 'scratch.txt'), 'untracked, not ours\n');
  seed(b, s => {
    s.acks = { [key('src/old.js')]: sha('old\n') };
    s.changes = { [key('src/new.js')]: { path: 'src/new.js', session: 'S', at: 1, baseline: null } };
    s.chains = { C1: { closed: false, files: { [key('src/old.js')]: 'src/old.js' }, findings: { F1: { label: 'BUG', status: 'open', location: 'src/old.js:1', title: 'loses data' } } } };
    s.running = { [key('src/old.js')]: { attempt: 'a1', pid: process.pid } }; // (a follow-up running doesn't hide the BUG)
  });
  const commit = () => hook.handle('bash', { session_id: 'S', cwd: a, tool_name: 'Bash', tool_input: { command: `git -c "core.sshCommand=ssh -C -i key" -C "${b}" -c "user.name=Test User" commit -m change` } });
  const first = denial(commit());
  assert.match(first, /src\/old\.js/);
  assert.match(first, /src\/new\.js/);
  assert.doesNotMatch(first, /scratch/);
  seed(b, s => { s.acks[key('src/old.js')] = sha('changed by a shell\n'); s.acks[key('src/new.js')] = sha('new\n'); });
  assert.match(denial(commit()), /open BUG/);
  seed(b, s => { s.chains.C1.findings.F1.status = 'resolved'; });
  assert.strictEqual(commit(), null);
});

test('a PowerShell leading location change cannot bypass the destination repository\'s commit guard', () => {
  const a = project('t3s a');
  const b = project('t3s b', { 'src/payments.js': 'old\n' });
  fs.writeFileSync(path.join(b, 'src/payments.js'), 'changed by Claude\n');
  seed(b, s => {
    s.acks = { [key('src/payments.js')]: sha('old\n') };
    s.chains = { C1: { closed: false, files: { [key('src/payments.js')]: 'src/payments.js' }, findings: { F1: { label: 'BUG', status: 'open', location: 'src/payments.js:1', title: 'loses money' } } } };
  });
  // [tool, command]: Set-Location by any of its names and in any letter case, with or without -Path or -LiteralPath;
  // a new line ends the folder change as ; and && do, for Bash's cd too
  const forms = [['PowerShell', `Set-Location '${b}'; git commit -m change`], ['PowerShell', `sl -LiteralPath "${b}" && git commit -m change`],
    ['PowerShell', `CHDIR -path '${b}'\ngit commit -m change`], ['PowerShell', `Cd '${b}'; git commit -m change`],
    ['Bash', `cd "${b}"\ngit commit -m change`]];
  const commit = ([tool, command]) => hook.handle('bash', { session_id: 'S', cwd: a, tool_name: tool, tool_input: { command } });
  for (const form of forms) {
    const first = denial(commit(form));
    assert.match(first || '', /src\/payments\.js/, form[1]);
    assert.match(first, /open BUG/, form[1]);
  }
  // (Bash has no Set-Location: there that command fails, and the commit after `;` runs in B itself)
  const bash = hook.handle('bash', { session_id: 'S', cwd: b, tool_name: 'Bash', tool_input: { command: `Set-Location '${a}'; git commit -m change` } });
  assert.match(denial(bash) || '', /src\/payments\.js/);
  seed(b, s => { s.acks[key('src/payments.js')] = sha('changed by Claude\n'); });
  for (const form of forms) assert.doesNotMatch(denial(commit(form)) || 'allowed', /differ from their last reviewed version/, form[1]);
  for (const form of forms) assert.match(denial(commit(form)) || '', /open BUG/, `${form[1]}: the BUG still blocks`);
  seed(b, s => { s.chains.C1.findings.F1.status = 'resolved'; });
  for (const form of forms) assert.strictEqual(commit(form), null, form[1]);
});

test('a Git Bash leading cd cannot bypass the target repository\'s commit guard on Windows', { skip: process.platform !== 'win32' && 'Git Bash drive paths are Windows-only' }, () => {
  const a = project('t3g a');
  const b = project("t3g O'Brien's b", { 'src/old.js': 'old\n' }); // (spaces and apostrophes, unquoted only once)
  fs.writeFileSync(path.join(b, 'src/old.js'), 'changed by Claude\n');
  seed(b, s => {
    s.acks = { [key('src/old.js')]: sha('old\n') };
    s.chains = { C1: { closed: false, files: { [key('src/old.js')]: 'src/old.js' }, findings: { F1: { label: 'BUG', status: 'open', location: 'src/old.js:1', title: 'loses data' } } } };
  });
  const gitBash = p => `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`; // (C:\x\y as Git Bash spells it: /c/x/y)
  const fromProfile = path.relative(os.homedir(), b).replace(/\\/g, '/');
  // [tool, command]: Git Bash's ~ is its HOME (here a folder other than the profile), PowerShell's ~ the profile folder
  const forms = [['Bash', `cd "${gitBash(b)}" && git commit -m change`], ['Bash', `git -C "${gitBash(b)}" commit -m change`],
    ['Bash', `cd ~/"${path.basename(b)}" && git commit -m change`], ['Bash', `git -C ~/"${path.basename(b)}" commit -m change`],
    ...(fromProfile.startsWith('..') || path.isAbsolute(fromProfile) ? [] : [['PowerShell', `cd ~/"${fromProfile}"; git commit -m change`],
      ['PowerShell', `cd "~/${fromProfile}"; git commit -m change`]])]; // (PowerShell reads ~ inside quotes too)
  const HOME_BEFORE = process.env.HOME;
  process.env.HOME = gitBash(path.dirname(b));
  try {
    const commit = ([tool, command]) => hook.handle('bash', { session_id: 'S', cwd: a, tool_name: tool, tool_input: { command } });
    for (const form of forms) {
      const first = denial(commit(form));
      assert.match(first || '', /src\/old\.js/, form[1]);
      assert.match(first, /open BUG/, form[1]);
    }
    // (PowerShell passes a program a quoted "~" as it is: git -C "~/repo" commits in the folder named ~ below cwd)
    const literal = project(path.join('t3g lit', '~', 'repo'), { 'src/lit.js': 'lit\n' });
    fs.writeFileSync(path.join(literal, 'src/lit.js'), 'changed\n');
    const native = hook.handle('bash', { session_id: 'S', cwd: path.join(HOME, 't3g lit'), tool_name: 'PowerShell', tool_input: { command: 'git -C "~/repo" commit -m change' } });
    assert.match(denial(native) || '', /src\/lit\.js/);
    // (a quoted "~" is a folder named ~: from B, that cd fails, and the commit after `;` runs in B, not in A under HOME)
    const quoted = hook.handle('bash', { session_id: 'S', cwd: b, tool_name: 'Bash', tool_input: { command: `cd "~/${path.basename(a)}"; git commit -m change` } });
    assert.match(denial(quoted) || '', /src\/old\.js/);
    // (a long path in an earlier git -C made a nested pattern take exponential time, so the guard timed out and let it through)
    const started = Date.now();
    assert.match(denial(commit(['Bash', `git -C C:/${'a'.repeat(40)} status && git -C "${gitBash(b)}" commit -m change`])) || '', /src\/old\.js/);
    assert.ok(Date.now() - started < 2000, `the guard answered in ${Date.now() - started} ms`);
    seed(b, s => { s.acks[key('src/old.js')] = sha('changed by Claude\n'); });
    for (const form of forms) assert.doesNotMatch(denial(commit(form)) || 'allowed', /differ from their last reviewed version/, form[1]);
    for (const form of forms) assert.match(denial(commit(form)) || '', /open BUG/, `${form[1]}: the BUG still blocks`);
    seed(b, s => { s.chains.C1.findings.F1.status = 'resolved'; });
    for (const form of forms) assert.strictEqual(commit(form), null, form[1]);
  } finally {
    if (HOME_BEFORE === undefined) delete process.env.HOME; else process.env.HOME = HOME_BEFORE;
  }
});

test('leaving plan mode needs a review or skip of the plan presented', () => {
  const reviewed = '# Plan\n\nStep one.\nStep two.\n';
  const file = path.join(HOME, 't4-plan.md');
  fs.writeFileSync(file, reviewed);
  seedGlobal(g => { g.plans = { [hook.planHash(reviewed)]: { at: Date.now() } }; });
  const exit = input => hook.handle('plan', { session_id: 'S', cwd: HOME, tool_name: 'ExitPlanMode', tool_input: input });
  assert.strictEqual(exit({ planFilePath: file }), null);
  const utf16 = path.join(HOME, 't4-plan-utf16.md'); // (as Windows PowerShell saves it)
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(reviewed, 'utf16le')]));
  assert.strictEqual(exit({ planFilePath: utf16 }), null);
  assert.strictEqual(exit({ plan: '  # Plan\r\n\r\nStep one.   Step two.' }), null);
  const changed = '# Plan\n\nStep one.\nStep three.\n';
  assert.match(denial(exit({ plan: changed, planFilePath: file })), /plan --file/);
  seedGlobal(g => { g.plans[hook.planHash(changed)] = { at: Date.now(), skip: 'too small to matter' }; });
  assert.strictEqual(exit({ plan: changed, planFilePath: file }), null);
});

test('Stop blocks once on an open BUG in any of the session\'s projects, and only reminds about changes', () => {
  const a = project('t5 a');
  const b = project('t5 b');
  seedGlobal(g => { g.sessions = { S: { roots: [b], at: Date.now() } }; });
  seed(b, s => {
    s.changes = { [key('src/x.js')]: { path: 'src/x.js', session: 'S', at: 1, baseline: null } };
    s.running = { [key('src/x.js')]: { attempt: 'a1', pid: process.pid } };
    s.chains = { C1: { closed: false, files: { [key('src/x.js')]: 'src/x.js' }, findings: {
      F1: { label: 'BUG', status: 'open', location: 'src/x.js:1', title: 'wrong sum' },
      F2: { label: 'GAP', status: 'open', location: 'src/x.js:2', title: 'odd name' } } } };
  });
  const stop = active => hook.handle('stop', { session_id: 'S', cwd: a, stop_hook_active: active });
  assert.strictEqual(stop(false).decision, 'block');
  assert.match(stop(false).reason, /C1 F1/);
  const again = stop(true);
  assert.notStrictEqual(again && again.decision, 'block');
  seed(b, s => { s.chains.C1.findings.F1.status = 'resolved'; });
  const done = stop(false);
  assert.notStrictEqual(done && done.decision, 'block');
  assert.match(done.systemMessage, /src\/x\.js/);
  fs.writeFileSync(state.files.global(), '{ not json');
  assert.match(stop(false).systemMessage, /couldn't check/, 'an unreadable state is said, not silent');
  fs.rmSync(state.files.global());
});

test('session start reports the state, and its cleanup keeps what an open chain needs and does nothing while off', () => {
  const root = project('t6');
  const bundles = path.join(state.projectDir(root), 'bundles');
  const old = (name, manifest) => {
    fs.mkdirSync(path.join(bundles, name), { recursive: true });
    fs.writeFileSync(path.join(bundles, name, 'manifest.json'), JSON.stringify(manifest));
    const then = new Date(Date.now() - 31 * 86400000);
    fs.utimesSync(path.join(bundles, name), then, then);
  };
  old('failed-followup', { chain: 'C1' });
  old('unused', { chain: null });
  old('crashed', { chain: null });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  seed(root, s => {
    s.chains = { C1: { closed: false, rounds: ['round-1'], files: {}, findings: {} } };
    s.running = { [key('src/y.js')]: { attempt: 'crashed', pid: Number(dead) } }; // (a review whose driver crashed)
  });
  const start = () => hook.handle('session', { session_id: 'S', cwd: root, source: 'startup' }).hookSpecificOutput.additionalContext;
  seedGlobal(g => { g.off = true; });
  const before = fs.readFileSync(state.files.project(root), 'utf8');
  assert.match(start(), /OFF/);
  assert.deepStrictEqual([fs.readdirSync(bundles).sort(), fs.readFileSync(state.files.project(root), 'utf8')], [['crashed', 'failed-followup', 'unused'], before]);
  seedGlobal(g => { g.off = false; });
  assert.match(start(), /crosscheck is on: 0 unreviewed change\(s\), 1 open review chain\(s\), 0 open BUG/);
  assert.deepStrictEqual(fs.readdirSync(bundles), ['failed-followup']);
});
