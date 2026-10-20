// Tests for install.js, step 6a (test plan P1), in isolated profiles: the old setup's hooks are replaced and every
// other hook kept, the first backup stays, restore puts the old files back with hooks added since, nothing runs
// while a review does, live state is never touched, and no personal detail reaches the repository.
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
const liveState = () => tree(state.HOME, rel => rel === 'config.json' || rel.startsWith('backup'));

// A fresh Claude Code profile with the old setup's settings, CLAUDE.md and agent (each optional), and live state.
function profile(name, { settings, claudeMd, agent } = {}) {
  const dir = path.join(HOME, name);
  process.env.CLAUDE_CONFIG_DIR = dir;
  fs.rmSync(path.join(state.HOME, 'backup'), { recursive: true, force: true });
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
const legacy = cmd => ({ type: 'command', command: `node "C:/Users/someone/.claude/gpt/gate.js" ${cmd}`, timeout: 15 });
const oldSettings = () => ({ theme: 'dark', env: { KEEP: '1' }, hooks: {
  PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [legacy('pre-edit'), { type: 'command', command: 'prettier --check', timeout: 5 }] },
    { matcher: 'ExitPlanMode', hooks: [legacy('pre-plan')] }],
  PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo the old crosscheck/hook.js is gone' }, { type: 'command', command: 'node --check /tmp/crosscheck/hook.js' }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'node "C:/old/place/crosscheck/hook.js" stop', timeout: 30 }] }],
  UserPromptSubmit: [{ hooks: [legacy('prompt')] }],
} });

test('install replaces the old setup\'s hooks, keeps every other hook and setting, twice alike, and leaves live state alone', async () => {
  const p = profile('t1', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  const before = liveState();
  const renameSync = fs.renameSync;
  let atSwitch = null;
  fs.renameSync = (from, to) => { // (what exists when settings.json, the switch, is written)
    // (settings.json itself is there too, up to the rename: an install killed meanwhile never loses it)
    if (to === p.settings) atSwitch = [path.join(p.code, 'hook.js'), path.join(p.code, 'RULES.md'), p.agent, state.files.config(), p.claudeMd, p.settings].map(f => fs.existsSync(f));
    return renameSync(from, to);
  };
  try {
    assert.strictEqual((await installer.install(quiet)).code, 0);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepStrictEqual(atSwitch, [true, true, true, true, true, true], 'everything else is in place before the switch');
  const s = json(p.settings);
  assert.deepStrictEqual([s.theme, s.env], ['dark', { KEEP: '1' }]);
  const all = commands(s);
  assert.ok(!all.some(c => /gpt\/gate\.js|old\/place/.test(c)), 'no old hook is left');
  assert.ok(['prettier --check', 'echo the old crosscheck/hook.js is gone', 'node --check /tmp/crosscheck/hook.js'].every(c => all.includes(c)), 'unrelated hooks stay');
  const editGroup = s.hooks.PreToolUse.find(g => g.hooks.some(h => h.command === 'prettier --check'));
  assert.strictEqual(editGroup.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
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
  assert.deepStrictEqual(liveState(), before, 'live state is untouched');
  // the installed copy keeps its state in its own profile, even where neither variable is set (its CLI run by hand)
  const env = { ...process.env };
  delete env.CROSSCHECK_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const home = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(p.code, 'state.js'))}).HOME)`], { env, encoding: 'utf8' }).stdout;
  assert.strictEqual(home, path.join(p.dir, 'crosscheck-state'));
});

test('the first backup keeps the original files, and a failed switch puts back what was written', async () => {
  const p = profile('t2', { settings: oldSettings(), claudeMd: 'original rules ✓\n', agent: 'original agent\n' });
  const original = [read(p.settings), read(p.claudeMd), read(p.agent)];
  assert.strictEqual((await installer.install(quiet)).code, 0);
  const backup = path.join(state.HOME, 'backup');
  const saved = tree(backup, rel => rel === 'done.json');
  assert.deepStrictEqual(['settings.json', 'CLAUDE.md', 'fallback-reviewer.md'].map(f => read(path.join(backup, f))), original);
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.deepStrictEqual(tree(backup, rel => rel === 'done.json'), saved, 'a later install never overwrites it');
  // an update whose switch fails on a full disk: the installed code and rules, CLAUDE.md, the agent and config.json
  // are put back without writing anything new, and settings.json is unchanged
  const q = profile('t2 failing', { settings: oldSettings(), claudeMd: 'kept rules\n', agent: 'kept agent\n' });
  fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test' }));
  assert.strictEqual((await installer.install(quiet)).code, 0);
  for (const f of fs.readdirSync(q.code)) fs.writeFileSync(path.join(q.code, f), `the installed old version of ${f}\n`);
  const kept = [tree(q.code), read(q.settings), read(q.claudeMd), read(q.agent), read(state.files.config())];
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
  assert.ok(!fs.readdirSync(q.dir).some(f => /crosscheck-before|\.tmp$/.test(f)), 'no file left aside');
  // an interrupted first backup is made again; once crosscheck is installed, a broken one stops the install
  const firstSwitch = oldSettings();
  delete firstSwitch.hooks.Stop; // (only the old setup's hooks: crosscheck was never installed here)
  profile('t2 marker', { settings: firstSwitch, claudeMd: 'rules before\n', agent: 'agent before\n' });
  fs.mkdirSync(path.join(state.HOME, 'backup'), { recursive: true });
  fs.writeFileSync(path.join(state.HOME, 'backup', 'done.json'), '{"at": "cut off');
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.strictEqual(read(path.join(state.HOME, 'backup', 'CLAUDE.md')), 'rules before\n');
  fs.writeFileSync(path.join(state.HOME, 'backup', 'done.json'), '{"at": "cut off');
  const refused = await installer.install(quiet);
  assert.strictEqual(refused.code, 1, refused.text);
  assert.match(refused.text, /backup .* is incomplete/);
  // a backup belongs to its profile: another profile sharing the state folder can't install or restore over it
  profile('t2 one', { settings: firstSwitch, claudeMd: 'one\n' });
  assert.strictEqual((await installer.install(quiet)).code, 0);
  const other = path.join(HOME, 't2 two');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'CLAUDE.md'), 'two\n');
  process.env.CLAUDE_CONFIG_DIR = other;
  for (const r2 of [await installer.install(quiet), await installer.restore({ yes: true })]) assert.match(r2.text, /belongs to the profile .*t2 one/);
  assert.strictEqual(read(path.join(other, 'CLAUDE.md')), 'two\n');
  const marker = path.join(state.HOME, 'backup', 'done.json'); // (a backup whose profile wasn't recorded counts as another's)
  const { profile: owner, ...unowned } = json(marker);
  fs.writeFileSync(marker, JSON.stringify(unowned));
  const backupBytes = tree(path.join(state.HOME, 'backup'));
  for (const r2 of [await installer.install(quiet), await installer.restore({ yes: true })]) assert.match(r2.text, /\(not recorded\)/);
  assert.deepStrictEqual([read(path.join(other, 'CLAUDE.md')), tree(path.join(state.HOME, 'backup'))], ['two\n', backupBytes]);
  // nor is a backup of another profile with a saved file missing written over
  fs.writeFileSync(marker, JSON.stringify({ ...unowned, profile: owner }));
  fs.rmSync(path.join(state.HOME, 'backup', 'CLAUDE.md'));
  const partial = tree(path.join(state.HOME, 'backup'));
  assert.match((await installer.install(quiet)).text, /belongs to the profile .*t2 one/);
  assert.deepStrictEqual([read(path.join(other, 'CLAUDE.md')), tree(path.join(state.HOME, 'backup'))], ['two\n', partial]);
  // input that ends without an answer is a no
  const { Readable } = require('stream');
  assert.strictEqual(await installer.confirm('Install? ', Readable.from([])), false);
});

test('restore puts the old files back, keeps a hook added since, and leaves live state alone', async () => {
  const p = profile('t3', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  const original = [read(p.claudeMd), read(p.agent)];
  assert.strictEqual((await installer.install(quiet)).code, 0);
  const s = json(p.settings);
  s.hooks.PreToolUse.find(g => g.matcher === 'Bash|PowerShell').hooks.push({ type: 'command', command: 'my-linter --strict' });
  fs.writeFileSync(p.settings, JSON.stringify(s));
  fs.writeFileSync(path.join(state.HOME, 'proj-a', 'snap', 'newer'), 'a newer snapshot');
  const live = liveState();
  assert.strictEqual((await installer.restore({ yes: true })).code, 0);
  const back = json(p.settings);
  const expected = oldSettings();
  delete expected.hooks.Stop; // (an earlier crosscheck's hook in the backup doesn't come back beside the old setup's)
  expected.hooks.PreToolUse.push({ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'my-linter --strict' }] });
  assert.deepStrictEqual(back, expected, 'the old settings, plus the hook added since, once');
  assert.ok(commands(back).some(c => /gpt\/gate\.js/.test(c)), 'the old setup\'s own hooks are back');
  assert.deepStrictEqual([read(p.claudeMd), read(p.agent)], original);
  assert.deepStrictEqual(liveState(), live);
  // two groups with the same matcher come back as they were, with no hook twice
  const twins = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-a' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-b' }] }] } };
  const t = profile('t3 twins', { settings: twins });
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.strictEqual((await installer.restore({ yes: true })).code, 0);
  assert.deepStrictEqual(json(t.settings), twins);
  // files that didn't exist before the install are removed again, settings.json included
  const q = profile('t3 empty');
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.ok(fs.existsSync(q.claudeMd) && fs.existsSync(q.settings));
  assert.strictEqual((await installer.restore({ yes: true })).code, 0);
  assert.deepStrictEqual([q.claudeMd, q.agent, q.settings].map(f => fs.existsSync(f)), [false, false, false]);
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

test('install waits while a review runs in any project, changing nothing', async () => {
  const p = profile('t4', { settings: oldSettings(), claudeMd: 'old rules\n', agent: 'old agent\n' });
  const running = path.join(state.HOME, 'proj-b', 'state.json');
  fs.writeFileSync(running, JSON.stringify({ running: { 'a.js': { attempt: 'x1', pid: process.pid } } }));
  const before = [tree(p.dir), liveState(), read(state.files.config()), fs.existsSync(path.join(state.HOME, 'backup'))];
  const r = await installer.install(quiet);
  assert.strictEqual(r.code, 1, r.text);
  assert.match(r.text, /review is running/);
  assert.deepStrictEqual([tree(p.dir), liveState(), read(state.files.config()), fs.existsSync(path.join(state.HOME, 'backup'))], before);
  fs.writeFileSync(running, JSON.stringify({}));
  // the old setup's own records, next to the gate.js its hooks run: a live review there waits too; else its open work
  // here is shown
  const legacyState = path.join(HOME, 'old setup elsewhere', 'gpt', 'state');
  fs.mkdirSync(legacyState, { recursive: true });
  const s = oldSettings();
  s.hooks.PreToolUse[1].hooks = [{ type: 'command', command: `node "${path.join(legacyState, '..', 'gate.js').replace(/\\/g, '/')}" pre-plan` }];
  fs.writeFileSync(p.settings, JSON.stringify(s));
  fs.writeFileSync(path.join(legacyState, 'aa.json'), JSON.stringify({ root: path.join(HOME, 'elsewhere'), running: { [process.pid]: { files: [] } } }));
  const before2 = [tree(p.dir, rel => rel.startsWith('gpt')), liveState()];
  const old = await installer.install(quiet);
  assert.strictEqual(old.code, 1, old.text);
  assert.match(old.text, /review of the old setup is running/);
  assert.deepStrictEqual([tree(p.dir, rel => rel.startsWith('gpt')), liveState()], before2);
  fs.writeFileSync(path.join(legacyState, 'aa.json'), JSON.stringify({ root: process.cwd(), reviewedAt: 5, changes: {
    'a.js': { at: 9, reviewedAt: 1, openFindings: ['log1'] }, 'b.js': { at: 3 }, 'c.js': { at: 8 } } }));
  let said = '';
  assert.strictEqual((await installer.install({ ...quiet, say: text => { said += text; } })).code, 0);
  assert.match(said, /the old setup in .*: 1 file\(s\) with open findings, 2 pending change\(s\)/);
});

test('personal details stay in personal.md and the local backup, never in the repository or the shared files', async () => {
  const id = crypto.randomBytes(4).toString('hex');
  const markers = [`PC-${id}`, `${id}@example.com`, `C:\\Users\\u${id}`, `MT5 standing confirmation ${id}`];
  const personal = `Run the MT5 tester on ${markers[0]} only (${markers[3]}); mail ${markers[1]}; files in ${markers[2]}.`;
  const p = profile('t5', { settings: oldSettings(), claudeMd: `old rules with ${personal}\n`, agent: 'old agent\n' });
  fs.writeFileSync(path.join(state.HOME, 'personal.md'), personal);
  const repoBefore = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout;
  assert.strictEqual((await installer.install(quiet)).code, 0);
  assert.strictEqual(read(p.claudeMd), `@${path.join(p.code, 'RULES.md').replace(/\\/g, '/')}\n\n${personal}\n`);
  assert.strictEqual(read(path.join(state.HOME, 'personal.md')), personal);
  assert.match(read(path.join(state.HOME, 'backup', 'CLAUDE.md')), new RegExp(id));
  for (const shared of [path.join(p.code, 'RULES.md'), p.agent, ...fs.readdirSync(p.code).map(f => path.join(p.code, f))]) {
    assert.ok(!markers.some(m => read(shared).includes(m)), `${shared} holds no personal detail`);
  }
  assert.strictEqual(spawnSync('git', ['grep', '-l', id], { cwd: REPO, encoding: 'utf8' }).stdout, '', 'the repository holds none');
  assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout, repoBefore);
});
