// The setup and helpers the follow-up tests share (followup.test.js and followup-material.test.js). A test file loads
// it before anything else, since state.js reads CROSSCHECK_HOME when it is loaded; each test file runs in its own
// process, so each gets its own temporary home, Codex stub spec and call log.
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck followup test ü '));
const SPEC = path.join(HOME, 'spec.json');
const LOG = path.join(HOME, 'calls.jsonl');
Object.assign(process.env, { CROSSCHECK_HOME: path.join(HOME, 'state'), FAKE_CODEX_SPEC: SPEC, FAKE_CODEX_LOG: LOG });
fs.mkdirSync(process.env.CROSSCHECK_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.CROSSCHECK_HOME, 'config.json'), JSON.stringify({ model: 'gpt-test', windowsSandbox: 'unelevated', codexJs: path.join(__dirname, 'fake-codex.js') }));
const state = require('../src/state');
const review = require('../src/review');
const gaps = require('../src/gaps');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const setSpec = exec => { fs.writeFileSync(SPEC, JSON.stringify({ exec })); fs.rmSync(LOG, { force: true }); };
const execCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []).filter(c => c.kind === 'exec');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async file => { for (let i = 0; i < 300 && !fs.existsSync(file); i++) await sleep(20); assert.ok(fs.existsSync(file), `${file} never appeared`); };
const stateOf = root => state.read(state.files.project(root)).data;
const seed = (root, fn) => assert.ok(state.update(state.files.project(root), fn).ok);
const key = rel => state.pathKey(rel);
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
const gapsText = root => fs.readFileSync(path.join(root, gaps.NAME), 'utf8');

function project(name, files) {
  const root = path.join(HOME, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'base']]) {
    assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  }
  const taskFile = path.join(HOME, `${name}-task.md`);
  fs.writeFileSync(taskFile, `# ${name}\n\n## Requirements\nR1. Adds numbers.\nR2. Keeps the sum.\n`);
  // (its real spelling, as git reports it: a short 8.3 temp path would give the commit hook another state folder)
  return { root: fs.realpathSync.native(root), taskFile };
}
const finding = (title, location, over = {}) => ({ severity: 'MEDIUM', title, location, trigger: 't', harm: 'h', failure: 'f', fix: 'x', test: null, label: 'BUG', reqs: [], ...over });
const met = ids => ids.map(id => ({ id, status: 'MET', evidence: 'src/a.js:1' }));
const normal = { level: 'normal', files: [], why: '-' };
const reviewAnswer = (findings, cls = normal) => JSON.stringify({ verdict: findings.length ? 'ISSUES_FOUND' : 'NO_ISSUES', findings,
  requirements: met(['R1', 'R2']), possibly_missing: [], class: cls, coverage: 'c' });
const followAnswer = (followups, { findings = [], rows = [], cls = normal } = {}) => JSON.stringify({
  verdict: followups.some(f => f.status === 'MAINTAIN') || findings.length ? 'ISSUES_REMAIN' : 'RESOLVED',
  followups, findings, requirements: met(rows), possibly_missing: [], class: cls, coverage: 'c' });
const row = (id, status) => ({ id, status, reason: `${id} ${status.toLowerCase()}` });
const response = text => { const f = path.join(HOME, `response-${crypto.randomBytes(3).toString('hex')}.md`); fs.writeFileSync(f, text); return f; };
// A chain from a fresh review of this session's change to src/a.js (and any other pending files).
async function freshChain(root, taskFile, findings, more = {}) {
  seed(root, s => { s.changes = { ...(s.changes || {}), [key('src/a.js')]: { path: 'src/a.js', session: 'A', at: 1, baseline: null }, ...more }; });
  const r = await review.review(root, { session: 'A', taskFile });
  assert.strictEqual(r.status, 'DONE', r.text);
  return r.chain;
}

module.exports = { HOME, SPEC, LOG, state, review, gaps, sha, setSpec, execCalls, waitFor, stateOf, seed, key, write, gapsText, project, finding,
  reviewAnswer, followAnswer, row, response, freshChain };
