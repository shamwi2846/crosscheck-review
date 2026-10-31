// Tests for doctor.js (test plan P1 of step 6b, then of the old setup's retirement): doctor --live fails, and verifies
// no Codex version, when a read-only run (fresh or resumed) could write; the hooks check fails for a screen hook that
// doesn't fail closed or hooks switched off, and takes the retired setup's hook for any other hook; an unreadable state
// is reported, never changed; and a clean install passes and is verified. They run the real CLI with the Codex stub.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck doctor test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
const PROFILE = path.join(HOME, 'profile');
const CLAUDE = path.join(HOME, 'fake-claude.js'); // (a supported Claude Code, as install records how it found it)
const MUSE_SPEC = path.join(HOME, 'muse-spec.json');
const MUSE_LOG = path.join(HOME, 'muse-calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), CLAUDE_CONFIG_DIR: PROFILE, CODEX_HOME: path.join(HOME, 'codex'),
  FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG, FAKE_MUSE_SPEC: MUSE_SPEC, FAKE_MUSE_LOG: MUSE_LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(CLAUDE, 'process.stdout.write("2.1.299 (Claude Code)\\n");');
const state = require('../src/state');
const installer = require('../install');
const { CU_PLUGINS } = require('../src/codex');

const config = over => fs.writeFileSync(state.files.config(), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated',
  codexJs: path.join(__dirname, 'fake-codex.js'), claude: [process.execPath, CLAUDE], ...over }));
const configNow = () => JSON.parse(fs.readFileSync(state.files.config(), 'utf8'));
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
// a probe's answer, with the shell command Codex reports for it (refused, as the live sandbox refuses it)
const probe = (file, over = {}) => ({ text: JSON.stringify({ attempted: true, error: 'Access is denied.' }),
  commands: [{ command: `pwsh.exe -Command 'echo probe > ${file}'`, output: `Access to the path '${file}' is denied.`, exit_code: 1 }], ...over });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 500 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const setSpec = exec => {
  fs.writeFileSync(SPEC, JSON.stringify({ exec, '--version undefined': [{ out: 'codex-cli 0.162.1\n' }],
    'plugin list': [{ out: JSON.stringify({ installed: CU_PLUGINS.map(pluginId => ({ pluginId, enabled: true })), available: [] }) }],
    'mcp list': [{ out: '[]' }],
    'features list': [{ out: ['apps', 'remote_plugin', 'multi_agent', 'image_generation', 'tool_suggest', 'memories'].map(f => `${f.padEnd(30)} stable  false`).join('\n') + '\n' }] }));
  fs.rmSync(LOG, { force: true });
};
const doctor = (live, cli = path.join(__dirname, '..', 'src', 'crosscheck.js')) => spawnSync(process.execPath, [cli, 'doctor', ...(live ? ['--live'] : [])], { cwd: HOME, encoding: 'utf8' });
const line = (out, name) => out.split('\n').find(l => l.slice(8).startsWith(`${name}:`)) || '';
const settingsFile = path.join(PROFILE, 'settings.json');
const tree = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort().map(f => path.join(dir, f)).filter(f => fs.statSync(f).isFile()).map(f => [f, fs.readFileSync(f, 'base64')]) : []);
// the settings, the retired folder and the live state (config.json aside, where doctor --live records its verdict)
const untouched = () => JSON.stringify([fs.readFileSync(settingsFile, 'base64'), tree(path.join(PROFILE, 'gpt')), tree(state.HOME).filter(([f]) => f !== state.files.config())]);

// The retired setup's hook beside crosscheck's edit hook, with an unrelated one, and the retired folder left in place.
function keepRetired() {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  s.hooks.PreToolUse.find(g => g.matcher === 'Edit|Write|MultiEdit|NotebookEdit').hooks.push(
    { type: 'command', command: `node "${path.join(PROFILE, 'gpt', 'gate.js').replace(/\\/g, '/')}" pre-edit` }, { type: 'command', command: 'prettier --check' });
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  fs.mkdirSync(path.join(PROFILE, 'gpt', 'state'), { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'gpt', 'gate.js'), '// the retired gate\n');
  return s;
}

async function freshInstall(over = {}) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  config(over);
  assert.strictEqual((await installer.install({ yes: true, checks: false, say: () => {} })).code, 0);
}

test('doctor --live fails on a read-only run that could write, and takes away the verified version at once', async () => {
  await freshInstall({ codexVerified: '0.162.1' });
  setSpec([{ touch: 'probe.txt', ...probe('probe.txt') }, probe('probe-resumed.txt')]);
  const r = doctor(true);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(line(r.stdout, 'Read-only'), /^PROBLEM .*could write probe\.txt/);
  assert.strictEqual(configNow().codexVerified, undefined, 'a proven write leaves no version verified');
  // while the resumed probe runs, the record is gone already; that probe's refused write doesn't bring it back
  await freshInstall({ codexVerified: '0.162.1' });
  const { codexVerified, ...rest } = configNow();
  const hold = fs.mkdtempSync(path.join(HOME, 'hold-'));
  setSpec([{ touch: 'probe.txt', ...probe('probe.txt') }, { hold, ...probe('probe-resumed.txt') }]);
  const running = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'crosscheck.js'), 'doctor', '--live'], { cwd: HOME, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  running.stdout.on('data', d => { out += d; });
  const closed = new Promise(resolve => running.on('close', resolve));
  await waitFor(path.join(hold, 'started'));
  assert.strictEqual(configNow().codexVerified, undefined, 'taken away before the next probe');
  fs.writeFileSync(path.join(hold, 'go'), '');
  assert.strictEqual(await closed, 1, 'the run still fails');
  assert.match(line(out, 'Read-only'), /^PROBLEM .*could write probe\.txt/);
  assert.deepStrictEqual([codexVerified, configNow()], ['0.162.1', rest], 'only the verified version went');
  const execs = calls().filter(c => c.kind === 'exec');
  assert.ok(!fs.existsSync(execs[0].args[execs[0].args.indexOf('-C') + 1]), 'the probe folder is removed');
  assert.match(line(doctor(false).stdout, 'Codex verified'), /^PROBLEM /);
});

test('doctor --live fails when only the resumed session could write', async () => {
  await freshInstall();
  setSpec([probe('probe.txt'), { touch: 'probe-resumed.txt', ...probe('probe-resumed.txt') }]);
  const r = doctor(true);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(line(r.stdout, 'Read-only'), /^ok /);
  assert.match(line(r.stdout, 'Read-only, resumed'), /^PROBLEM .*could write probe-resumed\.txt/);
  const execs = calls().filter(c => c.kind === 'exec');
  assert.deepStrictEqual([execs.length, execs[1].args[1], execs[1].args[execs[1].args.length - 2]], [2, 'resume', execs[0].session]);
  assert.strictEqual(configNow().codexVerified, undefined);
});

test('the hooks check fails for a screen hook that doesn\'t fail closed', async () => {
  await freshInstall({ codexVerified: '0.162.1' });
  setSpec([]);
  assert.strictEqual(doctor(false).status, 0, 'right after install everything passes');
  // a saved Claude Code command that stopped working (Node moved, say): Claude Code is looked for again
  const saved = configNow();
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...saved, claude: [path.join(HOME, 'gone', 'node.exe'), CLAUDE] }));
  const pathDir = path.join(HOME, 'bin');
  fs.mkdirSync(pathDir, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(pathDir, process.platform === 'win32' ? 'claude.exe' : 'claude')); // (a `claude` on PATH: node itself)
  const found = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'crosscheck.js'), 'doctor'], { cwd: HOME, encoding: 'utf8',
    env: { ...process.env, PATH: `${pathDir}${path.delimiter}${process.env.PATH}` } });
  assert.match(line(found.stdout, 'Claude Code'), new RegExp(`^ok .*${process.versions.node.replace(/\./g, '\\.')}`));
  // a saved npm install whose Node moved, with no `claude` on PATH: npm's same cli.js runs through this Node (where
  // npm sits beside Node, as Node's own installer puts it, so an empty PATH hides only claude)
  if (fs.existsSync(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
    const prefix = path.join(HOME, 'npm prefix');
    const cli = path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.copyFileSync(CLAUDE, cli);
    fs.writeFileSync(state.files.config(), JSON.stringify({ ...saved, claude: [path.join(HOME, 'gone', 'node.exe'), cli] }));
    const viaNpm = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'crosscheck.js'), 'doctor'], { cwd: HOME, encoding: 'utf8',
      env: { ...process.env, PATH: fs.mkdtempSync(path.join(HOME, 'empty-path-')), npm_config_prefix: prefix } });
    assert.match(line(viaNpm.stdout, 'Claude Code'), /^ok .*2\.1\.299/);
  }
  fs.writeFileSync(state.files.config(), JSON.stringify(saved));
  const s = keepRetired(); // (the retired gate's hook hides nothing)
  delete s.hooks.PreToolUse.find(g => g.matcher.startsWith('mcp__computer-use__')).hooks[0].onFailure;
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  const before = untouched();
  fs.rmSync(LOG, { force: true });
  const r = doctor(false);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(line(r.stdout, 'Hooks'), /^PROBLEM .*screen is registered 0 times, not once as installed \(failing closed\)/);
  for (const name of ['Codex', 'Codex verified', 'Claude Code', 'State']) assert.match(line(r.stdout, name), /^ok /, name);
  assert.ok(!calls().some(c => c.kind === 'exec'), 'no GPT run');
  assert.strictEqual(untouched(), before);
});

test('doctor reports another project\'s unreadable state without changing it, and still runs every other check', async () => {
  await freshInstall({ codexVerified: '0.162.1' });
  setSpec([]);
  keepRetired();
  const broken = path.join(state.HOME, 'other project-1a2b3c4d', 'state.json');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, '{"chains": {"C1": ');
  const before = untouched();
  const r = doctor(false);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(line(r.stdout, 'State'), /^PROBLEM .*can't be read: .*other project-1a2b3c4d/);
  for (const name of ['Codex', 'Codex verified', 'Hooks', 'Claude Code', 'MQL5 docs', 'Hook problems']) assert.match(line(r.stdout, name), /^ok /, name);
  assert.strictEqual(untouched(), before, 'nothing is overwritten or deleted');
  fs.rmSync(path.dirname(broken), { recursive: true, force: true });
});

test('the hooks check fails while hooks are switched off altogether, and live checks without a temporary folder say so', async () => {
  await freshInstall({ codexVerified: '0.162.1' });
  setSpec([]);
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...s, disableAllHooks: true }));
  const before = untouched();
  const off = doctor(false);
  assert.strictEqual(off.status, 1, off.stdout);
  assert.match(line(off.stdout, 'Hooks'), /^PROBLEM .*disableAllHooks/);
  for (const name of ['Codex', 'Codex verified', 'Claude Code', 'State']) assert.match(line(off.stdout, name), /^ok /, name);
  assert.strictEqual(untouched(), before);
  // no temporary folder for the live checks: they say so, and every other check is still shown
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  const blocked = path.join(HOME, 'not-a-folder.txt');
  fs.writeFileSync(blocked, 'x');
  const noTemp = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'crosscheck.js'), 'doctor', '--live'], { cwd: HOME, encoding: 'utf8',
    env: { ...process.env, TEMP: path.join(blocked, 'tmp'), TMP: path.join(blocked, 'tmp'), TMPDIR: path.join(blocked, 'tmp') } });
  assert.strictEqual(noTemp.status, 1, noTemp.stdout);
  assert.match(line(noTemp.stdout, 'Live checks'), /^PROBLEM .*couldn't run/);
  assert.match(line(noTemp.stdout, 'Hooks'), /^ok /);
  assert.match(line(noTemp.stdout, 'Computer lockdown'), /^ok /, 'the listing check runs on its own');
});

test('a clean install passes doctor --live, run from the installed copy, and its Codex version is verified', async () => {
  await freshInstall();
  // a probe whose shell couldn't start proves nothing, even with a schema-fit answer and no file written
  // (a launch refused by the system reads like a denial, but names no file and has no exit code of the command)
  const startup = file => probe(file, { commands: [{ command: `pwsh.exe -Command 'echo probe > ${file}'`, output: 'Failed to create process: Access is denied.', exit_code: -1 }] });
  setSpec([startup('probe.txt'), startup('probe-resumed.txt')]);
  const unproved = doctor(true);
  assert.strictEqual(unproved.status, 1, unproved.stdout);
  assert.match(line(unproved.stdout, 'Read-only'), /^PROBLEM .*inconclusive/);
  assert.strictEqual(configNow().codexVerified, undefined);
  setSpec([probe('probe.txt'), probe('probe-resumed.txt')]);
  keepRetired(); // (the retired gate's hook is any other hook now)
  const backup = path.join(state.HOME, 'backup'); // (a former first-install backup, left as it is)
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'done.json'), '{"at": "2026-10-20"}');
  const rest = configNow();
  delete rest.codexVerified;
  const before = untouched();
  const r = doctor(true, path.join(PROFILE, 'crosscheck', 'crosscheck.js'));
  assert.strictEqual(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /old setup/);
  assert.deepStrictEqual(configNow(), { ...rest, codexVerified: '0.162.1' }, 'only the verified version is recorded');
  assert.strictEqual(untouched(), before, 'the settings, the retired folder, the former backup and the live state are unchanged');
  fs.rmSync(backup, { recursive: true, force: true });
  const all = calls();
  const execs = all.filter(c => c.kind === 'exec');
  const folder = execs[0].args[execs[0].args.indexOf('-C') + 1];
  assert.ok(folder.startsWith(os.tmpdir()) && !fs.existsSync(folder), 'a fresh temporary folder, removed after');
  for (const c of execs) assert.ok(c.args.includes('--output-schema') && (c.args.includes('-s') ? c.args[c.args.indexOf('-s') + 1] === 'read-only' : c.args.includes('sandbox_mode="read-only"')));
  assert.deepStrictEqual([execs[1].args[1], execs[1].args[execs[1].args.length - 2]], ['resume', execs[0].session]);
  assert.ok(['plugin list', 'mcp list', 'features list'].every(k => all.some(c => c.kind === k)) && execs.length === 2, 'the lockdown is only listed, never run');
});

test('doctor probes and usage indicator follow the fast switch', async () => {
  await freshInstall();
  const cli = path.join(PROFILE, 'crosscheck', 'crosscheck.js');
  const repo = path.join(HOME, 'fast-repo'); // (status runs inside a project)
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const shown = text => (text.match(/GPT speed: Fast \(higher usage\)/g) || []).length;
  const execs = () => calls().filter(c => c.kind === 'exec');
  for (const [fast, tier] of [[undefined, 'default'], [true, 'priority'], [false, 'default']]) { // (never set, then on, then off)
    assert.ok(state.update(state.files.global(), g => { if (fast === undefined) delete g.fast; else g.fast = fast; }).ok);
    const status = spawnSync(process.execPath, [cli, 'status'], { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(shown(status.stdout), fast ? 1 : 0, status.stdout);
    setSpec([]);
    const plain = doctor(false, cli);
    assert.strictEqual(shown(plain.stdout), fast ? 1 : 0, plain.stdout);
    assert.strictEqual(execs().length, 0, 'plain doctor starts no GPT run');
    setSpec([probe('probe.txt'), probe('probe-resumed.txt')]);
    const live = doctor(true, cli);
    assert.strictEqual(live.status, 0, live.stdout);
    assert.strictEqual(shown(live.stdout), fast ? 1 : 0);
    assert.strictEqual(execs().length, 2);
    for (const c of execs()) {
      assert.ok(c.args.includes(`service_tier="${tier}"`), `the probe runs at ${tier}`);
      assert.ok(c.args.includes('-s') ? c.args[c.args.indexOf('-s') + 1] === 'read-only' : c.args.includes('sandbox_mode="read-only"'), 'and stays read-only');
    }
    assert.match(line(live.stdout, 'Read-only'), /^ok /);
  }
});

test('a Muse whose shell writes the probe file, or never tries, fails doctor --live, whatever it reports, and loses its verification', async () => {
  const fake = { museCommand: [process.execPath, path.join(__dirname, 'fake-muse.js')] };
  const setMuse = spec => { fs.writeFileSync(MUSE_SPEC, JSON.stringify(spec)); fs.rmSync(MUSE_LOG, { force: true }); };
  for (const c of [{ answer: { attempt: 'written', text: 'The write was refused.' }, problem: /Muse WROTE the probe file/ },
    { answer: { text: 'I won\'t try that.' }, problem: /its shell never had the write denied, so its sandbox is unproven/ },
    { answer: { attempt: 'parse', text: 'The write failed.' }, problem: /its shell never had the write denied/ }, // (a failure, but not a denial)
    { answer: { attempt: 'unstarted', text: 'The write failed.' }, problem: /its shell never had the write denied/ }, // (no exit code: it never ran)
    // (plan review F2: a sandboxed Muse that didn't get its web tools isn't verified either)
    { answer: { attempt: 'denied', text: 'Access was denied.', record: { tools: ['powershell', 'powershell_input', 'read_file', 'search'] } }, problem: /no web_search; no web_fetch/ },
    // (review F1: a probe that wrote outside its folder and left no readable record still takes the verification away)
    { answer: { attempt: 'written', text: 'Done.', noRecord: true }, problem: /no readable session record/ }]) {
    await freshInstall({ ...fake, museVerified: '9.9.9-test', museSkills: ['bundled:git'] });
    assert.ok(state.update(state.files.global(), g => { g.muse = true; }).ok);
    setSpec([probe('probe.txt'), probe('probe-resumed.txt')]);
    setMuse({ exec: [c.answer] }); // (and a clean session record)
    const r = doctor(true);
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(line(r.stdout, 'Muse verified'), new RegExp(`^PROBLEM .*${c.problem.source}`));
    const now = configNow();
    assert.deepStrictEqual([now.museVerified, now.museSkills, now.codexVerified], [undefined, undefined, '0.162.1'], 'only Muse loses its verification');
    // (the probe's folder is removed in every case; its target is a PowerShell literal, a quote in it doubled)
    const run = fs.readFileSync(MUSE_LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(e => e.args && e.args[0] === 'exec' && e.prompt);
    const target = run.prompt.match(/-LiteralPath '((?:[^']|'')+)'/)[1].replace(/''/g, "'");
    assert.ok(!fs.existsSync(path.dirname(path.dirname(target))), `the probe folder is removed (${c.problem.source})`);
  }
  // (a Muse whose shell tried and was refused, with a clean record, passes and is verified with its skills)
  setSpec([probe('probe.txt'), probe('probe-resumed.txt')]);
  setMuse({ exec: [{ attempt: 'denied', text: 'Access to the path was denied.' }] });
  const clean = doctor(true);
  assert.strictEqual(clean.status, 0, clean.stdout);
  assert.match(line(clean.stdout, 'Muse verified'), /its shell sandboxed/);
  assert.deepStrictEqual([configNow().museVerified, configNow().museSkills], ['9.9.9-test', ['bundled:git']]);
  assert.ok(state.update(state.files.global(), g => { delete g.muse; }).ok);
});
