// Tests for install.js (test plan P1 of step 6a, then of the old setup's retirement), in isolated profiles: only
// crosscheck's own hooks are replaced and every other hook kept, --restore is wrong usage, nothing runs while a review
// does, a failed switch puts back everything written, live state is never touched, and no personal detail reaches the
// repository.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck install test ü '));
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), CODEX_HOME: path.join(HOME, 'codex') });
const state = require('../src/state');
const installer = require('../install');

const REPO = path.join(__dirname, '..');
const quiet = { yes: true, checks: false, say: () => {} };
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const commands = settings => Object.values(settings.hooks || {}).flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));
// every file under a folder, by its relative path, with its bytes
function tree(dir, skip = () => false) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); const rel = path.relative(dir, f); if (skip(rel)) continue; if (e.isDirectory()) walk(f); else out[rel] = fs.readFileSync(f).toString('base64'); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
const liveState = () => tree(state.HOME, rel => rel === 'config.json');

// A fresh Claude Code profile with the settings, CLAUDE.md and agent it had before (each optional), and live state.
function profile(name, { settings, claudeMd, agent } = {}) {
  const dir = path.join(HOME, name);
  process.env.CLAUDE_CONFIG_DIR = dir;
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  if (claudeMd !== undefined) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd);
  if (agent !== undefined) fs.writeFileSync(path.join(dir, 'agents', 'fallback-reviewer.md'), agent);
  for (const p of ['proj-a', 'proj-b']) {
    fs.mkdirSync(path.join(state.HOME, p, 'snap'), { recursive: true });
    fs.mkdirSync(path.join(state.HOME, p, 'bundles', 'x1'), { recursive: true });
    fs.writeFileSync(path.join(state.HOME, p, 'state.json'), JSON.stringify({ chains: { C1: { closed: false, findings: { F1: { label: 'BUG', status: 'open' } } } }, changes: { 'a.js': { path: 'a.js' } } }));
    fs.writeFileSync(path.join(state.HOME, p, 'snap', 'abc'), 'snapshot');
    fs.writeFileSync(path.join(state.HOME, p, 'bundles', 'x1', 'prompt.md'), 'prompt');
  }
  fs.writeFileSync(state.files.global(), JSON.stringify({ off: false, plans: {} }));
  return { dir, settings: path.join(dir, 'settings.json'), claudeMd: path.join(dir, 'CLAUDE.md'), agent: path.join(dir, 'agents', 'fallback-reviewer.md'), code: path.join(dir, 'crosscheck') };
}
// (the retired setup's hook is now a hook like any other; an earlier crosscheck install's hooks are replaced)
const gate = { type: 'command', command: 'node "C:/Users/someone/.claude/gpt/gate.js" pre-edit', timeout: 15 };
const earlier = event => ({ type: 'command', command: `node "C:/old/place/crosscheck/hook.js" ${event}`, timeout: 30 });
const oldSettings = () => ({ theme: 'dark', env: { KEEP: '1' }, hooks: {
  PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [earlier('edit'), gate, { type: 'command', command: 'prettier --check', timeout: 5 }] },
    { matcher: 'ExitPlanMode', hooks: [earlier('plan')] }],
  PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo the old crosscheck/hook.js is gone' }, { type: 'command', command: 'node --check /tmp/crosscheck/hook.js' }] }],
  Stop: [{ hooks: [earlier('stop')] }],
  UserPromptSubmit: [{ hooks: [earlier('prompt')] }],
} });
// The retired setup's folder with a live review's record, and a former first-install backup of another profile.
function retired(dir) {
  fs.mkdirSync(path.join(dir, 'gpt', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gpt', 'gate.js'), '// the retired gate\n');
  fs.writeFileSync(path.join(dir, 'gpt', 'state', 'aa.json'), JSON.stringify({ root: process.cwd(), running: { [process.pid]: { files: [] } } }));
  const backup = path.join(state.HOME, 'backup');
  fs.mkdirSync(backup, { recursive: true });
  for (const [f, text] of [['settings.json', '{"hooks": {}}'], ['CLAUDE.md', 'rules before\n'], ['fallback-reviewer.md', 'agent before\n'],
    ['done.json', JSON.stringify({ at: '2026-10-20T00:00:00.000Z', absent: [], profile: path.join(HOME, 'another profile') })]]) fs.writeFileSync(path.join(backup, f), text);
  return { gpt: path.join(dir, 'gpt'), backup };
}

test('install replaces only crosscheck\'s hooks, keeps every other hook and setting, twice alike, and leaves the rest alone', async () => {
  const p = profile('t1', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  const old = retired(p.dir);
  fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test', codexJs: path.join(HOME, 'no codex here.js') }));
  const before = [tree(old.gpt), liveState()];
  const renameSync = fs.renameSync;
  let atSwitch = null;
  fs.renameSync = (from, to) => { // (what exists when settings.json, the switch, is written)
    // (settings.json itself is there too, up to the rename: an install killed meanwhile never loses it)
    if (to === p.settings) atSwitch = [path.join(p.code, 'hook.js'), path.join(p.code, 'RULES.md'), p.agent, state.files.config(), p.claudeMd, p.settings].map(f => fs.existsSync(f));
    return renameSync(from, to);
  };
  let said = '';
  let asked = 0;
  try {
    const r = await installer.install({ checks: false, ask: async () => { asked++; return true; }, say: text => { said += text; } });
    assert.strictEqual(r.code, 0, r.text);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(asked, 1, 'the preview is approved first');
  assert.match(said, /any earlier crosscheck hooks are replaced/);
  assert.doesNotMatch(said, /old setup/);
  assert.deepStrictEqual(atSwitch, [true, true, true, true, true, true], 'everything else is in place before the switch');
  const s = json(p.settings);
  assert.deepStrictEqual([s.theme, s.env], ['dark', { KEEP: '1' }]);
  const all = commands(s);
  assert.ok(!all.some(c => /old\/place/.test(c)), 'no earlier crosscheck hook is left');
  assert.ok([gate.command, 'prettier --check', 'echo the old crosscheck/hook.js is gone', 'node --check /tmp/crosscheck/hook.js'].every(c => all.includes(c)), 'every other hook stays');
  const editGroup = s.hooks.PreToolUse.find(g => g.hooks.some(h => h.command === 'prettier --check'));
  assert.deepStrictEqual([editGroup.matcher, editGroup.hooks], ['Edit|Write|MultiEdit|NotebookEdit', [gate, { type: 'command', command: 'prettier --check', timeout: 5 }]]);
  const hookJs = path.join(p.code, 'hook.js').replace(/\\/g, '/');
  const ours = event => all.filter(c => c === `node "${hookJs}" ${event}`).length;
  assert.deepStrictEqual(['session', 'edit', 'bash', 'plan', 'screen', 'stop'].map(ours), [1, 1, 1, 1, 1, 1]);
  // each of ours under its event and complete matcher, written out here (doctor's expectations come from registration())
  const ourPrefix = `node "${hookJs}" `;
  const placed = Object.entries(s.hooks).flatMap(([event, groups]) => groups.flatMap(g => g.hooks
    .filter(h => h.command.startsWith(ourPrefix)).map(h => [event, g.matcher || '', h.command.slice(ourPrefix.length), h.onFailure || ''])));
  assert.deepStrictEqual(placed.sort(), [
    ['SessionStart', '', 'session', ''],
    ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'edit', ''],
    ['PreToolUse', 'Bash|PowerShell', 'bash', ''],
    ['PreToolUse', 'ExitPlanMode', 'plan', ''],
    ['PreToolUse', 'mcp__computer-use__.*|mcp__remote-devices__computer.*', 'screen', 'block'],
    ['Stop', '', 'stop', ''],
  ].sort());
  assert.strictEqual(s.hooks.UserPromptSubmit, undefined, 'a group left empty goes');
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.deepStrictEqual(json(p.settings), s, 'a second install changes nothing');
  assert.deepStrictEqual([tree(old.gpt), liveState()], before, 'live state, the retired folder and the former backup are untouched');
  // the installed doctor's hooks check passes with the retired gate's hook still there
  const doctor = spawnSync(process.execPath, [path.join(p.code, 'crosscheck.js'), 'doctor'], { cwd: HOME, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: p.dir } });
  assert.match(doctor.stdout.split('\n').find(l => l.slice(8).startsWith('Hooks:')) || '', /^ok /, doctor.stdout);
  // the installed copy keeps its state in its own profile, even where neither variable is set (its CLI run by hand)
  const env = { ...process.env };
  delete env.CROSSCHECK_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const home = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(p.code, 'state.js'))}).HOME)`], { env, encoding: 'utf8' }).stdout;
  assert.strictEqual(home, path.join(p.dir, 'crosscheck-state'));
  fs.rmSync(old.backup, { recursive: true, force: true });
});

test('the removed restore option is wrong usage and changes no file', async () => {
  const p = profile('t2', { settings: oldSettings(), claudeMd: 'rules now\n', agent: 'agent now\n' });
  assert.strictEqual((await installer.install(quiet)).code, 0);
  const old = retired(p.dir);
  const before = [tree(p.dir), liveState()];
  const r = spawnSync(process.execPath, [path.join(REPO, 'install.js'), '--restore'], { input: 'y\n', encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: p.dir } });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stdout, /Usage: node install\.js \[--yes\] \(not --restore\)/);
  assert.doesNotMatch(r.stdout, /\[y\/N\]/, 'nothing is asked');
  assert.deepStrictEqual([tree(p.dir), liveState()], before);
  fs.rmSync(old.backup, { recursive: true, force: true });
});

test('the MQL5 docs server is read from a plain Codex config, comments included, and left off otherwise', () => {
  const config = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const docs = text => { fs.writeFileSync(config, text); return installer.docsServer(); };
  const server = docs("[other]\nx = 1\n\n[mcp_servers.mql5-chm]\ncommand = 'C:\\Program Files\\node.exe' # the runtime\nargs = ['C:/docs/server.mjs', \"--names=a,b\"] # the server\n");
  assert.deepStrictEqual([server.command, server.args], ['C:\\Program Files\\node.exe', ['C:/docs/server.mjs', '--names=a,b']]);
  assert.strictEqual(docs("[mcp_servers.mql5-chm]\ncommand = 'node'\nargs = ['a' 'b']\n"), null, 'args it can\'t read leave the docs off, never args dropped');
  assert.strictEqual(docs("[mcp_servers.mql5-chm]\ncommand = 'node'\nargs = []\nenabled = false # off\n"), null);
  assert.strictEqual(docs("[mcp_servers.mql5-chm]\ncommand = 'node'\n[mcp_servers.mql5-chm.env]\nKEY = 'x'\n"), null);
  fs.rmSync(config);
});

test('install waits while a review runs in any project, also one started while it asks, changing nothing', async () => {
  const p = profile('t4', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  const running = path.join(state.HOME, 'proj-b', 'state.json');
  fs.writeFileSync(running, JSON.stringify({ running: { 'a.js': { attempt: 'x1', pid: process.pid } } }));
  const before = [tree(p.dir), liveState(), read(state.files.config())];
  const r = await installer.install(quiet);
  assert.strictEqual(r.code, 1, r.text);
  assert.match(r.text, /review is running \(proj-b\)/);
  assert.deepStrictEqual([tree(p.dir), liveState(), read(state.files.config())], before);
  fs.writeFileSync(running, JSON.stringify({}));
  // a review that another project starts while install asks: the check after the answer refuses
  const late = path.join(state.HOME, 'proj-c', 'state.json');
  let asked = null;
  const ask = async () => {
    fs.mkdirSync(path.dirname(late), { recursive: true });
    fs.writeFileSync(late, JSON.stringify({ running: { job: { attempt: 'x2', pid: process.pid } } }));
    asked = [tree(p.dir), liveState(), read(state.files.config())];
    return true;
  };
  const r2 = await installer.install({ checks: false, ask, say: () => {} });
  assert.strictEqual(r2.code, 1, r2.text);
  assert.match(r2.text, /review is running \(proj-c\)/);
  assert.deepStrictEqual([tree(p.dir), liveState(), read(state.files.config())], asked);
  fs.rmSync(path.dirname(late), { recursive: true, force: true });
});

test('a failed switch on a full disk puts back everything written, and input that ends without an answer is a no', async () => {
  // an update whose switch fails on a full disk: the installed code and rules, CLAUDE.md, the agent and config.json
  // are put back without writing anything new, a file the update brought is gone again, and settings.json is unchanged
  const q = profile('t5', { settings: oldSettings(), claudeMd: 'kept rules\n', agent: 'kept agent\n' });
  fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test' }));
  assert.strictEqual((await installer.install(quiet)).code, 0);
  for (const f of fs.readdirSync(q.code)) fs.writeFileSync(path.join(q.code, f), `the installed old version of ${f}\n`);
  fs.rmSync(path.join(q.code, 'pair.js')); // (not in the installed copy, so the update creates it)
  const kept = [tree(q.code), read(q.settings), read(q.claudeMd), read(q.agent), read(state.files.config())];
  const live = liveState();
  const { renameSync, writeFileSync } = fs;
  let full = false;
  fs.renameSync = (from, to) => { if (to === q.settings && from.endsWith('.tmp')) { full = true; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } return renameSync(from, to); };
  fs.writeFileSync = (...args) => { if (full) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return writeFileSync(...args); };
  try {
    await assert.rejects(installer.install(quiet), e => /disk full/.test(e.message) && !/not put back/.test(e.message));
  } finally {
    Object.assign(fs, { renameSync, writeFileSync });
  }
  assert.deepStrictEqual([tree(q.code), read(q.settings), read(q.claudeMd), read(q.agent), read(state.files.config())], kept);
  assert.ok(!fs.existsSync(path.join(q.code, 'pair.js')), 'the file the failed update created is gone');
  assert.ok(!fs.readdirSync(q.dir).some(f => /crosscheck-before|\.tmp$/.test(f)), 'no file left aside');
  assert.deepStrictEqual(liveState(), live);
  // input that ends without an answer is a no
  const { Readable } = require('stream');
  assert.strictEqual(await installer.confirm('Install? ', Readable.from([])), false);
});

test('install keeps the config changes made while it asked, a removed verification and a value it would set included, and writes under the config lock', async () => {
  const p = profile('t7', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-old', custom: { a: 1, b: 2 }, codexVerified: '0.162.1' }));
  const docs = { command: 'node', args: ['C:/docs/server.mjs'], tools: ['mql5_chm_status'] };
  const ask = async () => { // (meanwhile doctor took the verification away, the docs server was set by hand, and more changed)
    const { codexVerified, ...rest } = json(state.files.config());
    fs.writeFileSync(state.files.config(), JSON.stringify({ ...rest, model: 'gpt-new', custom: { a: 1, b: 3 }, added: true, mql5Docs: docs }));
    return true;
  };
  const renameSync = fs.renameSync;
  let lockedAtWrite = null;
  fs.renameSync = (from, to) => { if (to === state.files.config()) lockedAtWrite = fs.existsSync(`${state.files.config()}.lock`); return renameSync(from, to); };
  let r;
  try {
    r = await installer.install({ checks: false, ask, say: () => {} });
  } finally {
    fs.renameSync = renameSync;
  }
  assert.strictEqual(r.code, 0, r.text);
  const written = json(state.files.config());
  assert.deepStrictEqual([written.model, written.custom, written.added, written.mql5Docs, 'codexVerified' in written], ['gpt-new', { a: 1, b: 3 }, true, docs, false]);
  assert.strictEqual(lockedAtWrite, true, 'no locked update (doctor\'s) can slip in between the read and the write');
  assert.ok(!fs.existsSync(`${state.files.config()}.lock`), 'and the lock is released');
  assert.ok(fs.existsSync(path.join(p.code, 'hook.js')) && commands(json(p.settings)).some(c => c.includes('crosscheck/hook.js')), 'installed as usual');
});

test('install writes nothing when config.json becomes unreadable while it asks', async () => {
  const p = profile('t8', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test' }));
  assert.strictEqual((await installer.install(quiet)).code, 0); // (an installed copy, which the refused update must leave alone)
  let armed = false;
  let snapshot = null;
  const ask = async () => {
    fs.writeFileSync(state.files.config(), '{"model": "gpt-te');
    snapshot = [tree(p.dir), tree(state.HOME)];
    armed = true;
    return true;
  };
  const mutations = [];
  const names = ['writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'linkSync', 'copyFileSync', 'mkdirSync'];
  const real = Object.fromEntries(names.map(n => [n, fs[n]]));
  const lock = target => String(target) === state.HOME || String(target).startsWith(`${state.files.config()}.lock`); // (taken and given back)
  for (const n of names) fs[n] = (...args) => { if (armed && !lock(args[0])) mutations.push(n); return real[n](...args); };
  let r;
  try {
    r = await installer.install({ checks: false, ask, say: () => {} });
  } finally {
    Object.assign(fs, real);
  }
  assert.strictEqual(r.code, 1, r.text);
  assert.match(r.text, /config\.json can't be read/);
  assert.deepStrictEqual(mutations, [], 'nothing is written after the answer');
  assert.deepStrictEqual([tree(p.dir), tree(state.HOME)], snapshot);
  fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test' }));
});

test('personal details stay in personal.md, never in the repository or the shared files, and no backup is made', async () => {
  const id = crypto.randomBytes(4).toString('hex');
  const markers = [`PC-${id}`, `${id}@example.com`, `C:\\Users\\u${id}`, `MT5 standing confirmation ${id}`];
  const personal = `Run the MT5 tester on ${markers[0]} only (${markers[3]}); mail ${markers[1]}; files in ${markers[2]}.`;
  const p = profile('t6', { settings: oldSettings(), claudeMd: `old rules with ${personal}\n`, agent: 'old agent\n' });
  fs.writeFileSync(path.join(state.HOME, 'personal.md'), personal);
  const repoBefore = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout;
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.strictEqual(read(p.claudeMd), `@${path.join(p.code, 'RULES.md').replace(/\\/g, '/')}\n\n${personal}\n`);
  assert.strictEqual(read(path.join(state.HOME, 'personal.md')), personal);
  assert.ok(!fs.existsSync(path.join(state.HOME, 'backup')), 'no backup folder or marker is made');
  for (const shared of [path.join(p.code, 'RULES.md'), p.agent, state.files.config(), ...fs.readdirSync(p.code).map(f => path.join(p.code, f))]) {
    assert.ok(!markers.some(m => read(shared).includes(m)), `${shared} holds no personal detail`);
  }
  assert.strictEqual(spawnSync('git', ['grep', '-l', id], { cwd: REPO, encoding: 'utf8' }).stdout, '', 'the repository holds none');
  assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout, repoBefore);
});

test('install preserves an imported CLAUDE.md including personal edits made while it asks', async () => {
  const p = profile('t7', { settings: oldSettings() });
  const importLine = `@${path.join(p.code, 'RULES.md').replace(/\\/g, '/')}`;
  const older = '## MT5 standing confirmation\nask, then pass the old flag\n';
  fs.writeFileSync(path.join(state.HOME, 'personal.md'), older);
  fs.writeFileSync(p.claudeMd, `${importLine}\r\n\r\n## MT5 test PC\r\ncompile and test without asking\r\n`); // (newer, changed in CLAUDE.md itself)
  let saved = null;
  const ask = async () => { // (and changed again while install asks)
    saved = `${importLine}\n\n## MT5 test PC\ncompile and test without asking; never trade outside the tester\n`;
    fs.writeFileSync(p.claudeMd, saved);
    return true;
  };
  assert.strictEqual((await installer.install({ ...quiet, yes: false, ask })).code, 0);
  assert.strictEqual(read(p.claudeMd), saved, 'CLAUDE.md is kept as it was when install wrote');
  assert.strictEqual(read(path.join(state.HOME, 'personal.md')), older, 'personal.md is not touched');
});

test('an imported CLAUDE.md saved while install writes its other files keeps that save', async () => {
  const p = profile('t8', { settings: oldSettings() });
  const importLine = `@${path.join(p.code, 'RULES.md').replace(/\\/g, '/')}`;
  fs.writeFileSync(p.claudeMd, `${importLine}\n\n## MT5 test PC\nbefore\n`);
  const late = `${importLine}\n\n## MT5 test PC\nsaved by another session while install wrote\n`;
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => { // (the save lands as install puts its first file of the code in place)
    if (to.startsWith(p.code) && read(p.claudeMd) !== late) fs.writeFileSync(p.claudeMd, late);
    return realRename(from, to);
  };
  try {
    assert.strictEqual((await installer.install(quiet)).code, 0);
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(read(p.claudeMd), late);
});

test('fast is a validated global choice that survives reinstalls', async () => {
  const p = profile('t9', { settings: oldSettings() });
  const run = (...args) => spawnSync(process.execPath, [path.join(REPO, 'src', 'crosscheck.js'), ...args], { cwd: HOME, encoding: 'utf8', env: process.env });
  const fastNow = () => json(state.files.global()).fast;
  assert.strictEqual(fastNow(), undefined, 'off until switched on');
  for (const [choice, value] of [['on', true], ['off', false]]) {
    const r = run('fast', choice);
    assert.strictEqual(r.status, 0, r.stdout);
    assert.strictEqual(fastNow(), value);
    for (const wrong of [['fast'], ['fast', 'fastest'], ['fast', choice, 'extra'], ['fast', choice, '--live']]) {
      const before = read(state.files.global());
      const refused = run(...wrong);
      assert.strictEqual(refused.status, 2, `${wrong.join(' ')}: ${refused.stdout}`);
      assert.match(refused.stdout, /fast on \| fast off +\(Codex's Fast tier for every GPT run: faster, higher usage\)/, 'the usage text explains it');
      assert.strictEqual(read(state.files.global()), before, `${wrong.join(' ')} changes nothing`);
    }
    assert.strictEqual((await installer.install(quiet)).code, 0);
    assert.strictEqual(fastNow(), value, 'an install keeps the choice');
    const installed = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(p.code, 'codex.js'))})
      .buildArgs({ mode: 'review', effort: 'high', cwd: '.', outFile: 'o' })))`], { cwd: HOME, encoding: 'utf8', env: process.env });
    assert.ok(JSON.parse(installed.stdout).includes(`service_tier="${value ? 'priority' : 'default'}"`), `a new process of the installed copy runs ${choice}: ${installed.stderr}`);
  }
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
