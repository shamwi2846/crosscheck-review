// The setup and helpers the paired-review tests share (pair.test.js and pair-fallback.test.js). A test file loads it
// before anything else, since state.js reads CROSSCHECK_HOME when it is loaded; each test file runs in its own process,
// so each gets its own temporary home, Codex stub spec and call log.
'use strict';
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
const logged = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const execCalls = () => logged().filter(c => c.kind === 'exec');
const lookups = () => logged().filter(c => c.kind === 'mcp get'); // (docs server lookups)
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
// (a CONFIRM judges the harm a BUG unless `label` says otherwise; an UNCLEAR names what it couldn't check)
const marks = list => JSON.stringify({ marks: list.map(([id, mark, sameAs = null, evidence = mark === 'DISPUTE' ? 'src/x.js:1 guards it' : mark === 'UNCLEAR' ? 'the caller isn\'t in my material' : '',
  label = mark === 'CONFIRM' ? 'BUG' : null]) => ({ id, mark, label, evidence, same_as: sameAs })) });
const followAnswer = (followups = [], cls = normal) => JSON.stringify({ verdict: followups.some(f => f.status === 'MAINTAIN') ? 'ISSUES_REMAIN' : 'RESOLVED',
  followups, findings: [], requirements: [], possibly_missing: [], class: cls, coverage: 'c' });
// The stub's answers by prompt: each reviewer's review and cross-check, and follow-ups (which resume reviewer A);
// `docs`: its answers to the docs server lookups (`codex mcp get`), in order.
function setPair({ A = [], B = [], xA = [], xB = [], follow = [], single = [], docs = [] }) {
  const withSession = (list, session) => list.map(a => (typeof a === 'string' ? { text: a, session } : { session, ...a }));
  fs.writeFileSync(SPEC, JSON.stringify({ byPrompt: [
    { match: 'Cross-check (you are reviewer A)', answers: withSession(xA, 'sess-A') },
    { match: 'Cross-check (you are reviewer B)', answers: withSession(xB, 'sess-B') },
    { match: 'reviewer A. Check', answers: withSession(A, 'sess-A') },
    { match: 'reviewer B. Attack', answers: withSession(B, 'sess-B') },
    { match: 'This is a follow-up round', answers: withSession(follow, 'sess-A') },
    { match: 'You review a code change', answers: withSession(single, 'sess-S') }, // (a single review: last, as pairs' prompts hold it too)
  ], 'mcp get': docs }));
  fs.rmSync(LOG, { force: true });
}
const plan = (p, files) => ({ task: p.task, reqHash: p.reqHash, cases: [{ id: 'T1', text: 'an order without a stop is refused', test: 'tests/t.test.js' }], tests: files || [], at: 1 });
const pending = (rel, session = 'A') => ({ path: rel, session, at: 1, baseline: null });

module.exports = { HOME, state, review, pair, answer, gaps, sha, execCalls, lookups, waitFor, stateOf, seed, key, write, response, project, finding, rows,
  reviewAnswer, marks, followAnswer, setPair, plan, pending };
