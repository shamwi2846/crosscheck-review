// Tests for doctor.js, step 6b (test plan P1): doctor --live fails, and verifies no Codex version, when a read-only
// run (fresh or resumed) could write; the hooks check fails for a screen hook that doesn't fail closed or an old-setup
// hook left; and a clean install passes and is verified. They run the real CLI with the recording Codex stub.
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
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), CLAUDE_CONFIG_DIR: PROFILE, CODEX_HOME: path.join(HOME, 'codex'),
  FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
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

async function freshInstall(over = {}) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(path.join(state.HOME, 'backup'), { recursive: true, force: true });
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
  // cancelled while the resumed probe runs: the record is gone already
  await freshInstall({ codexVerified: '0.162.1' });
  const hold = fs.mkdtempSync(path.join(HOME, 'hold-'));
  setSpec([{ touch: 'probe.txt', ...probe('probe.txt') }, { hold, ...probe('probe-resumed.txt') }]);
  const running = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'crosscheck.js'), 'doctor', '--live'], { cwd: HOME, stdio: 'ignore' });
  const closed = new Promise(resolve => running.on('close', resolve));
  await waitFor(path.join(hold, 'started'));
  assert.strictEqual(configNow().codexVerified, undefined, 'taken away before the next probe');
  running.kill();
  await closed;
  assert.strictEqual(configNow().codexVerified, undefined);
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
  // a saved npm install whose Node moved, with no `claude` on PATH: npm's same cli.js runs through this Node
  const prefix = path.join(HOME, 'npm prefix');
  const cli = path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.copyFileSync(CLAUDE, cli);
  fs.writeFileSync(state.files.config(), JSON.stringify({ ...saved, claude: [path.join(HOME, 'gone', 'node.exe'), cli] }));
  const viaNpm = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'crosscheck.js'), 'doctor'], { cwd: HOME, encoding: 'utf8',
    env: { ...process.env, PATH: path.dirname(process.execPath), npm_config_prefix: prefix } });
  assert.match(line(viaNpm.stdout, 'Claude Code'), /^ok .*2\.1\.299/);
  fs.writeFileSync(state.files.config(), JSON.stringify(saved));
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  delete s.hooks.PreToolUse.find(g => g.matcher.startsWith('mcp__computer-use__')).hooks[0].onFailure;
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  const r = doctor(false);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(line(r.stdout, 'Hooks'), /^PROBLEM .*screen is registered 0 times, not once as installed \(failing closed\)/);
});

test('the hooks check fails while a hook of the old setup is still registered', async () => {
  await freshInstall({ codexVerified: '0.162.1' });
  setSpec([]);
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  s.hooks.UserPromptSubmit = [{ hooks: [{ type: 'command', command: `node "${path.join(PROFILE, 'gpt', 'gate.js').replace(/\\/g, '/')}" prompt` }] }];
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  const r = doctor(false);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(line(r.stdout, 'Hooks'), /^PROBLEM .*1 hook\(s\) of the old setup are still registered/);
  // a hook that only syntax-checks gate.js is the user's own, as install.js keeps it
  s.hooks.UserPromptSubmit[0].hooks[0].command = `node --check "${path.join(PROFILE, 'gpt', 'gate.js').replace(/\\/g, '/')}"`;
  fs.writeFileSync(settingsFile, JSON.stringify(s));
  assert.match(line(doctor(false).stdout, 'Hooks'), /^ok /);
  // hooks switched off altogether
  fs.writeFileSync(settingsFile, JSON.stringify({ ...s, disableAllHooks: true }));
  assert.match(line(doctor(false).stdout, 'Hooks'), /^PROBLEM .*disableAllHooks/);
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
  const r = doctor(true, path.join(PROFILE, 'crosscheck', 'crosscheck.js'));
  assert.strictEqual(r.status, 0, r.stdout);
  assert.strictEqual(configNow().codexVerified, '0.162.1');
  const all = calls();
  const execs = all.filter(c => c.kind === 'exec');
  const folder = execs[0].args[execs[0].args.indexOf('-C') + 1];
  assert.ok(folder.startsWith(os.tmpdir()) && !fs.existsSync(folder), 'a fresh temporary folder, removed after');
  for (const c of execs) assert.ok(c.args.includes('--output-schema') && (c.args.includes('-s') ? c.args[c.args.indexOf('-s') + 1] === 'read-only' : c.args.includes('sandbox_mode="read-only"')));
  assert.deepStrictEqual([execs[1].args[1], execs[1].args[execs[1].args.length - 2]], ['resume', execs[0].session]);
  assert.ok(['plugin list', 'mcp list', 'features list'].every(k => all.some(c => c.kind === k)) && execs.length === 2, 'the lockdown is only listed, never run');
});
