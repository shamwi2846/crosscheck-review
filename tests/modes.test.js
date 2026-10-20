// Tests for modes.js, step 5b (test plan P1): GPT's other jobs stay read-only (research alone has the web), a test
// plan is checked and stored only for its task and only while the requirements hold, a skip is refused once GPT rated
// a file risky, and the plan gate accepts only the reviewed text or a reasoned skip. They run the real CLI with the
// recording Codex stub fake-codex.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck modes test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
const DOCS = { command: 'C:/docs/mql5-chm.exe', args: ['--serve'], tools: ['mql5_chm_status', 'mql5_chm_read'] };
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CROSSCHECK_HOME, 'config.json'),
  JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js'), mql5Docs: DOCS }));
const state = require('../src/state');
const review = require('../src/review');
const hook = require('../src/hook');

const CLI = path.join(__dirname, '..', 'src', 'crosscheck.js');
const key = rel => state.pathKey(rel);
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const stateOf = root => state.read(state.files.project(root)).data;
const setSpec = spec => { fs.writeFileSync(SPEC, JSON.stringify(spec)); fs.rmSync(LOG, { force: true }); };
const execCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.kind === 'exec');
const env = session => ({ ...process.env, CLAUDE_CODE_SESSION_ID: session });
const cli = (cwd, args, session = 'A') => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: env(session) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 500 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const json = value => ({ text: JSON.stringify(value) });
const reviewAnswer = (findings = [], over = {}) => json({ verdict: findings.length ? 'ISSUES_FOUND' : 'NO_ISSUES', findings,
  requirements: [{ id: 'R1', status: 'MET', evidence: 'it is there' }], possibly_missing: [], class: { level: 'normal', files: [], why: 'plain' }, coverage: 'all', ...over });
const marks = list => json({ marks: list.map(([id, mark]) => ({ id, mark, evidence: mark === 'DISPUTE' ? 'no' : '', same_as: null })) });
const testCase = (id, covers, test = `tests/${id}.test.js`) => ({ id, severity: 'HIGH', covers, reqs: ['R1'], input: 'an order', expected: 'it has a stop', test_file: test, test_name: id });
const denial = a => (a && a.hookSpecificOutput && a.hookSpecificOutput.permissionDecision === 'deny' ? a.hookSpecificOutput.permissionDecisionReason : null);

// A git project with committed files, and session A's task file.
function project(name, committed) {
  const root = path.join(HOME, name);
  for (const [rel, text] of Object.entries(committed)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  const g = args => assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-qm', 'base']);
  const real = fs.realpathSync.native(root);
  writeTask(state.files.task(real, 'A'));
  return real;
}
function writeTask(file, reqs = 'R1. Every order keeps its stop loss.') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# task\n\n## Requirements\n${reqs}\n\n## Notes\n-\n`);
  return review.taskInfo(file);
}

// Each recorded Codex call, in full, is read-only and isolated: web search only for research, the docs server (with
// exactly its read tools) only for MQL5 work. Only the generated paths and the resumed session are placeholders.
function isolated(call, { web = false, docs = false, effort }) {
  const c = value => ['-c', value];
  const k = 'mcp_servers.mql5-chm';
  const docsArgs = !docs ? [] : [...c(`${k}.command="C:/docs/mql5-chm.exe"`), ...c(`${k}.args=["--serve"]`), ...c(`${k}.required=false`),
    ...c(`${k}.enabled_tools=["mql5_chm_status","mql5_chm_read"]`), ...c(`${k}.tools.mql5_chm_status.approval_mode="approve"`), ...c(`${k}.tools.mql5_chm_read.approval_mode="approve"`)];
  const resume = call.args[1] === 'resume';
  const expected = ['exec', ...(resume ? ['resume'] : []), '--ignore-user-config', '--json', '-m', 'gpt-test', ...c(`model_reasoning_effort=${effort}`), ...c('windows.sandbox=unelevated'),
    ...['apps', 'plugins', 'multi_agent', 'image_generation', 'tool_suggest', 'computer_use', 'browser_use', 'in_app_browser'].flatMap(f => c(`features.${f}=false`)),
    ...(web ? [] : c('web_search="disabled"')), ...docsArgs, '--output-schema', '<schema>', '--skip-git-repo-check', '-o', '<out>',
    ...(resume ? [...c('sandbox_mode="read-only"'), '<session>', '-'] : ['-s', 'read-only', '-C', '<cwd>', '-'])];
  const actual = call.args.map((a, i, all) => (all[i - 1] === '--output-schema' ? '<schema>' : all[i - 1] === '-o' ? '<out>' : all[i - 1] === '-C' ? '<cwd>'
    : resume && i === all.length - 2 ? '<session>' : a));
  assert.deepStrictEqual(actual, expected);
}

test('every GPT job is read-only and isolated; research alone has the web, MQL5 work alone the docs', () => {
  const root = project('t1', { 'src/EA.mq5': 'e\n', 'logs/run.log': 'ok\n', 'notes/idea.md': 'use a cache\n', 'notes/brief.md': 'release notes\n', 'notes/plan.md': '# Plan\nStep.\n' });
  fs.writeFileSync(path.join(root, 'src/EA.mq5'), 'e2\n');
  seed(root, s => { s.changes = { [key('src/EA.mq5')]: { path: 'src/EA.mq5', session: 'A', at: 1, baseline: null } }; });
  setSpec({ byPrompt: [
    { match: 'reviewer A. Check', answers: [reviewAnswer()] }, { match: 'reviewer B. Attack', answers: [reviewAnswer()] },
    { match: 'You design the test cases', answers: [json({ cases: [testCase('T1', ['src/EA.mq5'])], not_worth_testing: '-' })] },
    { match: 'You review a plan before', answers: [reviewAnswer()] },
    { match: 'second opinion on a proposal', answers: [json({ verdict: 'SOUND', recommendation: 'go', points: [] })] },
    { match: 'You read large material', answers: [json({ answer: 'all passed', evidence: [], counts: { passed: 1, failed: 0, first_failure: null }, scope: 'run.log', confidence: 'proven' })] },
    { match: 'You look things up on the web', answers: [json({ answer: 'yes', sources: [{ url: 'https://example.com', claim: 'c' }], confidence: 'proven' })] },
    { match: 'You write a long document', answers: [json({ title: 'Release notes', text: 'Everything.' })] },
  ] });
  // (from a subfolder, with project-relative paths: they are read from the project's root)
  const ran = (args, code = 0) => { const r = cli(path.join(root, 'src'), args); assert.strictEqual(r.status, code, `${args[0]}: ${r.stdout}`); return r.stdout; };
  ran(['review']);
  ran(['testplan', '--files', 'src/EA.mq5']);
  ran(['plan', '--file', 'notes/plan.md']);
  ran(['idea', '--file', 'notes/idea.md']);
  ran(['digest', '--files', 'logs/run.log', '--question', 'did it pass?']);
  ran(['research', '--question', 'is it so?']);
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  const draft = ran(['write', '--brief', 'notes/brief.md']).match(/draft saved, not applied: (.+)/)[1].trim();
  assert.ok(draft.startsWith(state.projectDir(root)) && /Everything\./.test(fs.readFileSync(draft, 'utf8')));
  assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, before, 'write changed no project file');
  const calls = execCalls();
  const of = match => calls.filter(c => c.prompt.includes(match));
  assert.strictEqual(of('reviewer ').length, 2);
  for (const c of of('reviewer ')) isolated(c, { docs: true, effort: 'xhigh' });
  isolated(of('You design the test cases')[0], { docs: true, effort: 'xhigh' });
  isolated(of('You review a plan before')[0], { effort: 'high' });
  isolated(of('second opinion')[0], { effort: 'high' });
  isolated(of('You read large material')[0], { effort: 'high' });
  isolated(of('You look things up on the web')[0], { web: true, effort: 'high' });
  isolated(of('You write a long document')[0], { effort: 'medium' });
  assert.match(of('You design the test cases')[0].prompt, /MQL5 docs tools/);
  assert.match(of('You read large material')[0].prompt, new RegExp(path.join(root, 'logs', 'run.log').replace(/\\/g, '\\\\')));
});

test('a test plan is checked against its targets and stored for the named task only', () => {
  const root = project('t2', { 'src/EA.mq5': 'e\n', 'docs/spec.md': 's\n' });
  const taskB = writeTask(path.join(HOME, 't2-task-B.md'));
  const taskA = review.sessionTask(root, 'A');
  assert.strictEqual(taskA.reqHash, taskB.reqHash, 'the same requirements, another task');
  setSpec({ byPrompt: [{ match: 'You design the test cases', answers: [
    json({ cases: [testCase('T1', ['docs/spec.md'])], not_worth_testing: '-' }),
    json({ cases: [testCase('T1', [])], not_worth_testing: '-' }),
    json({ cases: [testCase('T1', ['src/EA.mq5', 'src/Risk.mqh']), testCase('T2', ['src/Risk.mqh'])], not_worth_testing: '-' }),
  ] }] });
  const args = ['testplan', '--task', taskB.file, '--files', 'src/EA.mq5,src/Risk.mqh', '--context', 'docs/spec.md'];
  const bad = cli(root, args);
  assert.strictEqual(bad.status, 1, bad.stdout);
  const tries = execCalls();
  assert.deepStrictEqual(tries.map(c => c.args[1] === 'resume'), [false, true], 'one repair, in its session');
  for (const c of tries) isolated(c, { docs: true, effort: 'xhigh' });
  assert.deepStrictEqual(stateOf(root).plans || {}, {}, 'nothing stored');
  const good = cli(root, args);
  assert.strictEqual(good.status, 0, good.stdout);
  const plans = stateOf(root).plans;
  assert.deepStrictEqual(Object.keys(plans).sort(), [key('src/EA.mq5'), key('src/Risk.mqh')].sort());
  assert.deepStrictEqual(plans[key('src/EA.mq5')].cases.map(c => c.id), ['T1']);
  assert.deepStrictEqual([plans[key('src/Risk.mqh')].cases.map(c => c.id), plans[key('src/Risk.mqh')].tests], [['T1', 'T2'], ['tests/T1.test.js', 'tests/T2.test.js']]);
  for (const p of Object.values(plans)) assert.deepStrictEqual([p.task, p.reqHash], [taskB.id, taskB.reqHash]);
  const editA = hook.handle('edit', { session_id: 'A', cwd: root, tool_name: 'Write', tool_input: { file_path: path.join(root, 'src/EA.mq5'), content: 'x' } });
  assert.match(denial(editA), /needs a test plan/, 'task B\'s plan doesn\'t unlock session A\'s edit');
});

test('a test plan is stored only if the requirements still hold once it has the project lock', async () => {
  const root = project('t3', { 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  const task = review.sessionTask(root, 'A');
  const old = { task: task.id, reqHash: task.reqHash, cases: [{ id: 'T1', text: 'old', test: 'tests/old.test.js — old' }], tests: ['tests/old.test.js'], at: 1 };
  seed(root, s => { s.plans = { [key('src/a.js')]: old, [key('src/b.js')]: old }; s.acks = { other: 'kept' }; });
  const hold = fs.mkdtempSync(path.join(HOME, 't3-hold-'));
  setSpec({ byPrompt: [{ match: 'You design the test cases', answers: [{ hold, ...json({ cases: [testCase('T1', ['src/a.js', 'src/b.js'])], not_worth_testing: '-' }) }] }] });
  const running = spawn(process.execPath, [CLI, 'testplan', '--files', 'src/a.js,src/b.js'], { cwd: root, env: env('A'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  running.stdout.on('data', d => { out += d; });
  const exited = new Promise(resolve => running.on('exit', resolve));
  await waitFor(path.join(hold, 'started'));
  const bundles = path.join(state.projectDir(root), 'bundles');
  const answered = () => fs.existsSync(bundles) && fs.readdirSync(bundles).some(b => fs.readdirSync(path.join(bundles, b)).some(f => f.startsWith('turn-')));
  state.withLock(state.files.project(root), () => {
    fs.writeFileSync(path.join(hold, 'go'), '');
    for (let i = 0; i < 300 && !answered(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // (until GPT's answer is in)
    assert.ok(answered(), 'the answer arrived while the lock was held');
    assert.deepStrictEqual(stateOf(root).plans[key('src/a.js')], old, 'nothing changes while another holds the lock');
    writeTask(state.files.task(root, 'A'), 'R1. Every order keeps its stop loss.\nR2. And its take profit.');
  });
  assert.strictEqual(await exited, 1, out);
  assert.match(out, /requirements changed/);
  const s = stateOf(root);
  assert.deepStrictEqual([s.plans[key('src/a.js')], s.plans[key('src/b.js')], s.acks], [old, old, { other: 'kept' }]);
});

test('a skip is refused for a file GPT rated risky in this task, even after its pair cleared the escalation', () => {
  const root = project('t4', { 'src/payments.js': 'p\n' });
  fs.writeFileSync(path.join(root, 'src/payments.js'), 'p2\n');
  seed(root, s => { s.changes = { [key('src/payments.js')]: { path: 'src/payments.js', session: 'A', at: 1, baseline: null } }; });
  const risky = { level: 'risky', files: ['src/payments.js'], why: 'it moves money' };
  setSpec({ byPrompt: [
    { match: 'reviewer A. Check', answers: [reviewAnswer()] }, { match: 'reviewer B. Attack', answers: [reviewAnswer()] },
    { match: 'You review a code change', answers: [reviewAnswer([], { class: risky })] },
  ] });
  assert.strictEqual(cli(root, ['review']).status, 0);
  assert.ok(stateOf(root).escalations[key('src/payments.js')], 'rated risky: escalated');
  const paired = cli(root, ['review']);
  assert.strictEqual(paired.status, 0, paired.stdout);
  const before = stateOf(root);
  assert.deepStrictEqual([before.escalations[key('src/payments.js')], before.needsPlan[key('src/payments.js')].length], [undefined, 1]);
  const calls = execCalls().length;
  const r = cli(root, ['skip', '--files', 'src/payments.js', '--why', 'covered elsewhere']);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /only a test plan counts/);
  assert.deepStrictEqual([stateOf(root), execCalls().length], [before, calls]);
});

test('the plan gate accepts only the text reviewed, or a plan skipped with its reason', async () => {
  const root = project('t5', { 'README.md': 'r\n' });
  const file = path.join(HOME, 't5-plan.md');
  const P = '# Plan\n\nStep one: add the stop loss.\nStep two: test it.\n';
  const Q = '# Plan\n\nStep one: drop the stop loss.\n';
  fs.writeFileSync(file, P);
  setSpec({ exec: [reviewAnswer()] });
  const mistyped = cli(root, ['plan', '--file', file, '--task', 'no-such-task.md']); // (a task named but missing: refused, never reviewed without it)
  assert.strictEqual(mistyped.status, 1, mistyped.stdout);
  assert.deepStrictEqual([execCalls().length, (state.read(state.files.global()).data.plans || {})[hook.planHash(P)]], [0, undefined]);
  const hold = fs.mkdtempSync(path.join(HOME, 't5-hold-'));
  const finding = { severity: 'MEDIUM', title: 'no rollback step', location: 't5-plan.md', trigger: 'a failed deploy', harm: 'lost data', failure: 'f', fix: 'add one', test: null, label: 'BUG', reqs: [] };
  setSpec({ byPrompt: [
    { match: 'Cross-check (you are reviewer A)', answers: [marks([])] },
    { match: 'Cross-check (you are reviewer B)', answers: [{ session: 'sess-B', ...marks([['A1', 'CONFIRM']]) }] },
    { match: 'reviewer A. Check', answers: [{ hold, session: 'sess-A', ...reviewAnswer([finding]) }] },
    { match: 'reviewer B. Attack', answers: [{ session: 'sess-B', ...reviewAnswer() }] },
  ] });
  const running = spawn(process.execPath, [CLI, 'plan', '--file', file, '--risky'], { cwd: root, env: env('A'), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  running.stdout.on('data', d => { out += d; });
  const exited = new Promise(resolve => running.on('exit', resolve));
  await waitFor(path.join(hold, 'started'));
  fs.writeFileSync(file, Q); // (revised while the pair reviews P)
  fs.writeFileSync(path.join(hold, 'go'), '');
  assert.strictEqual(await exited, 0, out);
  const calls = execCalls();
  assert.ok(calls.some(c => c.prompt.includes('Cross-check (you are reviewer B)')), 'the pair cross-checked A\'s finding');
  for (const c of calls) isolated(c, { effort: 'xhigh' });
  const plans = state.read(state.files.global()).data.plans;
  assert.strictEqual(plans[hook.planHash(P)].verdict, 'ISSUES_FOUND');
  assert.strictEqual(plans[hook.planHash(Q)], undefined, 'Q never gets P\'s review');
  const exit = text => hook.handle('plan', { session_id: 'A', cwd: root, tool_name: 'ExitPlanMode', tool_input: { plan: text } });
  assert.deepStrictEqual([exit(P), exit(P.replace(/\n/g, '\r\n  '))], [null, null]);
  assert.match(denial(exit(Q)), /no review/);
  const n = execCalls().length;
  const skipped = cli(root, ['plan', '--skip', '--why', 'small revision accepted', '--file', file]);
  assert.strictEqual(skipped.status, 0, skipped.stdout);
  assert.deepStrictEqual([exit(Q), execCalls().length, state.read(state.files.global()).data.plans[hook.planHash(Q)].skip], [null, n, 'small revision accepted']);
});
