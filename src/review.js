// review.js: a task's reviews (DESIGN.md section 7). An attempt reserves its files, freezes everything GPT will
// read into a bundle, runs GPT with one repair, and applies the answer in one locked write of the project state.
// Only the frozen versions count as reviewed, so GPT, its repair and the fallback reviewer judge the same code.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const state = require('./state');
const codex = require('./codex');
const answer = require('./answer');
const gaps = require('./gaps');

const DELETED = 'deleted'; // the frozen version of a file that doesn't exist
const RISKY_FILE = /\.(mq5|mqh|set)$/i; // trading files: always reviewed in pairs (step 3)
const MAPS = ['changes', 'acks', 'running', 'applied', 'chains', 'escalations'];

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const snapFile = (root, hash) => path.join(state.projectDir(root), 'snap', hash);
const bundleDir = (root, attempt) => path.join(state.projectDir(root), 'bundles', attempt);
const withMaps = s => { for (const k of MAPS) s[k] = s[k] || {}; return s; };
const git = (cwd, args, encoding) => spawnSync('git', args, { cwd, encoding, windowsHide: true, maxBuffer: 64 << 20 });

// A file's bytes, or null when it doesn't exist. Any other read error stops the review.
function bytesOf(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Text of a file's bytes, decoded from UTF-16 when it starts with a byte-order mark.
function textOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8');
}

// Saves bytes as an immutable snapshot named by their hash; a missing file (null) is DELETED.
function snapshot(root, bytes) {
  if (bytes === null) return DELETED;
  const hash = sha(bytes);
  const file = snapFile(root, hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, bytes);
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  }
  return hash;
}

const snapText = (root, hash) => textOf(fs.readFileSync(snapFile(root, hash)));
const versionOf = (root, rel) => { const bytes = bytesOf(path.join(root, rel)); return bytes === null ? DELETED : sha(bytes); };
// (a fence longer than any run of backticks in the text, so the text can't end it)
const fence = text => { const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${ticks}\n${text}\n${ticks}`; };

// The named paths, resolved from the project root to their real spelling: each must be a file, or a deletion git
// knows about (found in HEAD by its key, since Windows may spell it differently).
function resolveNamed(root, names) {
  const named = [];
  let tracked = null;
  for (const name of names) {
    const abs = path.resolve(root, name);
    let rel = path.relative(root, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { why: `${name} is outside the project` };
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(abs)).replace(/\\/g, '/');
    } else {
      // (-z: names come unquoted, as they are, non-ASCII letters included)
      tracked = tracked || String(git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], 'utf8').stdout || '').split('\0').filter(Boolean);
      const matches = tracked.filter(t => state.pathKey(t) === state.pathKey(rel));
      if (matches.length !== 1) return { why: `${name} is neither a file nor a deletion git knows about` };
      rel = matches[0];
    }
    named.push({ key: state.pathKey(rel), path: rel });
  }
  return { named };
}

// The task file's title, its "## Requirements" section and the requirement ids in it ("R1.", "R2." ...).
function taskOf(text) {
  const section = text.match(/^## Requirements[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!section) return null;
  const ids = [...new Set([...section[1].matchAll(/^\s*\**(R\d+)[.):]/gm)].map(m => m[1]))];
  return { title: (text.match(/^#\s+(.+)$/m) || [, '-'])[1].trim(), requirements: section[1].trim(), ids };
}

// Reserves an attempt's files in one state transaction: this session's pending changes plus the named paths, read
// from the same state the reservation is written to. Returns { files, admittedAt } or { refused }.
function admit(root, { attempt, session, named }) {
  const result = state.update(state.files.project(root), data => {
    const s = withMaps(data);
    for (const [key, mark] of Object.entries(s.running)) if (!state.alive(mark.pid)) delete s.running[key];
    const files = {};
    for (const [key, change] of Object.entries(s.changes)) if (session && change.session === session) files[key] = { path: change.path };
    for (const n of named) files[n.key] = files[n.key] || { path: n.path };
    const keys = Object.keys(files);
    const list = ks => ks.map(k => files[k].path).join(', ');
    if (!keys.length) return { refused: 'nothing to review: this session has no pending changes and no file was named' };
    const busy = keys.filter(k => s.running[k]);
    if (busy.length) return { refused: `already in a running review: ${list(busy)}` };
    const risky = keys.filter(k => RISKY_FILE.test(k) || s.escalations[k]);
    if (risky.length) return { refused: `these files need a paired review, which isn't built yet (step 3): ${list(risky)}` };
    for (const key of keys) {
      const change = s.changes[key];
      // (without a change record, the baseline is the last reviewed version, if any; freeze falls back to HEAD)
      const acked = s.acks[key] === DELETED ? null : s.acks[key];
      Object.assign(files[key], change ? { at: change.at, session: change.session, baseline: change.baseline } : { at: null, baseline: acked });
      s.running[key] = { attempt, pid: process.pid };
    }
    return { files, admittedAt: Date.now() };
  });
  return result.ok ? result.value : { refused: result.why };
}

function release(root, attempt, keys) {
  state.update(state.files.project(root), s => {
    for (const key of keys) if (s.running && s.running[key] && s.running[key].attempt === attempt) delete s.running[key];
  });
}

// The diff between two snapshots, from git diff --no-index on their decoded text, without its header ('' if same).
function diffOf(root, before, after) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-diff-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), snapText(root, before));
    fs.writeFileSync(path.join(dir, 'b'), snapText(root, after));
    const r = git(dir, ['diff', '--no-index', '--no-color', '-U8', 'a', 'b'], 'utf8');
    if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr || r.error}`);
    const start = r.stdout.indexOf('\n@@');
    return start < 0 ? '' : r.stdout.slice(start + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// What GPT reads about one file: its diff from its baseline, or the whole file when there is no diff to show.
function material(root, f, full) {
  if (f.frozen === DELETED) {
    return `### ${f.path} (deleted)\n${f.baseline ? `Its last version:\n${fence(snapText(root, f.baseline))}` : 'No earlier version is known.'}`;
  }
  const text = snapText(root, f.frozen);
  if (!f.baseline) return `### ${f.path} (new file, whole)\n${fence(text)}`;
  const diff = full ? '' : diffOf(root, f.baseline, f.frozen);
  if (!diff) return `### ${f.path} (whole file)\n${fence(text)}`;
  return `### ${f.path} (diff from its last reviewed version)\n${fence(diff)}`;
}

const RULES = `You review a code change for the project in the current folder, which you may read (read-only) for context.
The reviewed files may change while you work: read a reviewed file only from its frozen copy, listed under "Frozen copies".
Report every real problem as a finding:
- BUG: it can really happen in normal use (a real caller, input or user action) and cause real harm: a wrong result, lost data, lost money or a security hole. In money or trading code, an unlikely trigger with a big possible loss is a BUG too.
- GAP: anything else worth recording. No style remarks.
Each finding: severity; title; location: one of the reviewed paths below exactly, optionally with :line or :line-line, or "-" for the task as a whole; trigger; harm; failure; fix; test (required for CRITICAL and HIGH, else null); label; reqs: the requirement ids it shows unmet.
Rate every requirement once: MET (with evidence as path:line), PARTIAL, NOT_MET, or NOT_IN_THIS_CHANGE.
possibly_missing: requirements the work clearly needs that the list lacks (suggestions only).
class: none (no behavior change), normal, or risky (money and payments, deleting or migrating data, security, anything that can't be undone; in trading code orders, lots, SL/TP, risk, EA inputs and .set presets; or code risky code uses), with the files it applies to and why.
coverage: one line on what you checked, what doesn't apply (n/a) and what you didn't examine.
verdict: ISSUES_FOUND when there is a finding or an unmet requirement, else NO_ISSUES.`;

// Freezes an attempt into its bundle: snapshots of the files and the task, the prompt built only from them, and
// the manifest the answer is applied from. The fallback reviewer gets the same bundle.
function freeze(root, { attempt, session, names, files, admittedAt, taskFile, evidenceFile, full }) {
  const taskBytes = bytesOf(taskFile);
  if (taskBytes === null) return { why: `the task file ${taskFile} doesn't exist` };
  const task = taskOf(textOf(taskBytes));
  if (!task) return { why: `the task file ${taskFile} has no "## Requirements" section` };
  snapshot(root, taskBytes);
  const code = [];
  for (const f of Object.values(files)) {
    f.frozen = snapshot(root, bytesOf(path.join(root, f.path)));
    if (f.baseline === undefined) { // (no change record: the version git has, if any)
      const head = git(root, ['show', `HEAD:${f.path}`]);
      f.baseline = head.status === 0 ? snapshot(root, head.stdout) : null;
    }
    code.push(material(root, f, full));
  }
  let evidence = 'None was supplied.';
  if (evidenceFile) {
    const bytes = bytesOf(evidenceFile);
    if (bytes === null) return { why: `the evidence file ${evidenceFile} doesn't exist` };
    const mtime = file => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);
    const stale = mtime(evidenceFile) < Math.max(...Object.values(files).map(f => mtime(path.join(root, f.path))));
    evidence = `Supplied by Claude and unverified${stale ? '; STALE: it is older than the last change to a reviewed file' : ''}.\n${fence(textOf(bytes))}`;
  }
  const lessons = gaps.lessons(root).trim() || 'None.';
  const copies = Object.values(files).map(f => `- ${f.path}: ${f.frozen === DELETED ? '(deleted)' : snapFile(root, f.frozen)}`).join('\n');
  const prompt = `${RULES}\n\n## Task requirements (the authority on what the work must do)\n${task.requirements}\n\n`
    + `## Project lessons (confirmed past mistakes)\n${lessons}\n\n## Reviewed files\n${code.join('\n\n')}\n\n`
    + `## Frozen copies (the reviewed versions, whole)\n${copies}\n\n## Evidence\n${evidence}\n`;
  const manifest = { attempt, kind: 'review', root, session, names, admittedAt, files,
    task: { path: taskFile, title: task.title, sha: sha(taskBytes), rowIds: task.ids, linkIds: task.ids } };
  fs.mkdirSync(bundleDir(root, attempt), { recursive: true });
  fs.writeFileSync(path.join(bundleDir(root, attempt), 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(bundleDir(root, attempt), 'prompt.md'), prompt);
  return { manifest, prompt };
}

// Runs GPT on the bundle's prompt, with one repair in the same session. Each turn is saved in the bundle.
async function run(root, manifest, prompt) {
  const asked = { rowIds: manifest.task.rowIds, linkIds: manifest.task.linkIds, files: Object.values(manifest.files).map(f => f.path), openIds: manifest.openIds || [] };
  const schema = answer.SCHEMAS[manifest.kind];
  const save = (n, text, result) => fs.writeFileSync(path.join(bundleDir(root, manifest.attempt), `turn-${n}.md`),
    `# Prompt\n\n${text}\n\n# Answer\n\n${result.ok ? result.text : `(no answer: ${result.reason})`}\n`);
  const first = await codex.ask({ mode: 'review', effort: 'high', persist: true, schema, prompt, cwd: root });
  save(1, prompt, first);
  if (!first.ok) return { status: first.unavailable ? 'GPT_UNAVAILABLE' : 'NOT_DONE', why: first.reason };
  let checked = answer.read(manifest.kind, first.text, asked);
  if (checked.problems.length) {
    if (!first.sessionId) return { status: 'NOT_DONE', why: `the answer has problems and its session can't be resumed: ${checked.problems.join('; ')}` };
    const repair = `Your answer has these problems. Answer again, in full, without them:\n- ${checked.problems.join('\n- ')}`;
    const second = await codex.ask({ mode: 'review', effort: 'high', resume: first.sessionId, schema, prompt: repair, cwd: root });
    save(2, repair, second);
    if (!second.ok) return { status: second.unavailable ? 'GPT_UNAVAILABLE' : 'NOT_DONE', why: second.reason };
    checked = answer.read(manifest.kind, second.text, asked);
    if (checked.problems.length) return { status: 'NOT_DONE', why: `the answer still has problems after its repair: ${checked.problems.join('; ')}` };
  }
  return { status: 'OK', answer: checked.answer, session: first.sessionId };
}

// The chain's findings from a checked answer: each with its file's key (null for the task as a whole), plus a
// task-wide BUG for every unmet requirement that no finding names.
function findingsOf(a) {
  const found = a.findings.map(f => ({ ...f, key: answer.locationKey(f.location) === '-' ? null : answer.locationKey(f.location), status: 'open' }));
  for (const r of a.requirements) {
    if ((r.status === 'NOT_MET' || r.status === 'PARTIAL') && !a.findings.some(f => f.reqs.includes(r.id))) {
      found.push({ severity: 'MEDIUM', title: `${r.id} is ${r.status.replace(/_/g, ' ')}`, location: '-', key: null, trigger: 'the task as asked',
        harm: 'the work does not do what was asked', failure: r.evidence, fix: '-', test: null, label: 'BUG', reqs: [r.id], status: 'open' });
    }
  }
  return found;
}

// Applies a checked answer in one locked write of the project state; its GAP findings go into KNOWN_GAPS.md
// first, under the same lock. Returns { chain, findings, acked, pending, escalated, taskChanged } or { refused }.
function apply(root, manifest, result) {
  const stateFile = state.files.project(root);
  const done = state.withLock(stateFile, write => {
    const current = state.read(stateFile);
    if (current.unreadable) return { refused: `the state can't be read (${current.unreadable}), so nothing was applied` };
    const s = withMaps(current.data);
    const keys = Object.keys(manifest.files);
    if (s.applied[manifest.attempt]) return { refused: 'this answer was already applied' };
    const lost = keys.filter(k => !s.running[k] || s.running[k].attempt !== manifest.attempt);
    if (lost.length) return { refused: `the reservation of ${lost.join(', ')} was lost, so nothing was applied` };
    const id = `C${manifest.attempt}`;
    const chain = { rev: 1, began: manifest.admittedAt, session: manifest.session, rounds: [manifest.attempt], codexSession: result.session,
      closed: false, task: manifest.task, files: {}, frozen: {}, findings: {} };
    findingsOf(result.answer).forEach((f, i) => { chain.findings[`F${i + 1}`] = f; });
    const gapFindings = Object.entries(chain.findings).filter(([, f]) => f.label === 'GAP');
    if (gapFindings.length) {
      const known = gaps.readFile(root);
      if (known.unreadable) return { refused: `KNOWN_GAPS.md can't be read (${known.unreadable}), so nothing was applied` };
      const items = gapFindings.map(([fid, f]) => ({ task: manifest.task.title, where: [f.location], problem: `${fid}: ${f.title}`, trigger: f.trigger,
        severity: f.severity, fix: f.fix, test: f.test, log: manifest.attempt, why: `labelled GAP by the reviewer; harm: ${f.harm}` }));
      const composed = gaps.compose(root, known.text, items);
      if (composed.added.length && !write(path.join(root, gaps.NAME), composed.text)) return { refused: 'the lock was taken over, so nothing was applied' };
      gapFindings.forEach(([, f], i) => { f.gap = composed.ids[i]; });
    }
    const taskBytes = bytesOf(manifest.task.path);
    const taskChanged = taskBytes === null || sha(taskBytes) !== manifest.task.sha;
    const ratedRisky = result.answer.class.level === 'risky' ? result.answer.class.files.map(state.pathKey) : [];
    const acked = [], pending = [], escalated = [];
    for (const [key, f] of Object.entries(manifest.files)) {
      if (ratedRisky.includes(key)) { s.escalations[key] = { chain: id, at: Date.now() }; escalated.push(f.path); }
      const record = s.changes[key];
      const sameRecord = record ? record.at === f.at && record.session === f.session : f.at === null;
      const reviewed = !taskChanged && !s.escalations[key];
      if (reviewed && sameRecord && versionOf(root, f.path) === f.frozen) {
        s.acks[key] = f.frozen;
        delete s.changes[key];
        acked.push(f.path);
      } else {
        // (it stays pending, with the reviewed copy as its new baseline; a named file without a record gets one)
        const baseline = reviewed ? (f.frozen === DELETED ? null : f.frozen) : f.baseline || null;
        if (record) record.baseline = reviewed ? baseline : record.baseline;
        else s.changes[key] = { path: f.path, session: null, at: Date.now(), baseline };
        pending.push(f.path);
      }
      chain.files[key] = f.path;
      chain.frozen[key] = f.frozen;
    }
    s.applied[manifest.attempt] = true;
    s.chains[id] = chain;
    if (!write(stateFile, JSON.stringify(s, null, 2))) return { refused: 'the lock was taken over, so the state was not changed' };
    return { chain: id, findings: chain.findings, acked, pending, escalated, taskChanged };
  });
  return done.ok === false ? { refused: done.why } : done;
}

// What Claude reads after a review: the answer with the chain's finding ids, and what was acknowledged.
function summary(a, applied) {
  const findings = Object.entries(applied.findings).map(([id, f]) => ({ ...f, id }));
  const lines = [`chain ${applied.chain}`, answer.render({ ...a, findings })];
  if (applied.acked.length) lines.push(`acknowledged: ${applied.acked.join(', ')}`);
  if (applied.pending.length) lines.push(`still pending (changed during the review, rated risky, or the task changed): ${applied.pending.join(', ')}`);
  if (applied.escalated.length) lines.push(`rated risky by GPT, so they need a test plan and a paired review: ${applied.escalated.join(', ')}`);
  if (applied.taskChanged) lines.push('the task file changed during the review, so nothing was acknowledged: run the review again');
  return lines.join('\n');
}

// A fresh review of this session's pending changes plus the named files (`files`, from the project root), against
// `taskFile`. Returns { status, text, chain, bundle }: status DONE, REFUSED, GPT_UNAVAILABLE or NOT_DONE (the
// bundle stays for the fallback reviewer).
async function review(root, { session = null, files = [], taskFile = null, evidenceFile = null, full = false, risky = false } = {}) {
  const refused = why => ({ status: 'REFUSED', text: `REFUSED: ${why}` });
  if (risky) return refused('a risky review is paired, which isn\'t built yet (step 3)');
  if (!taskFile) return refused('a review needs its task file');
  if (!session && !files.length) return refused('without a session id, name the files to review');
  const resolved = resolveNamed(root, files);
  if (resolved.why) return refused(resolved.why);
  const attempt = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const admitted = admit(root, { attempt, session, named: resolved.named });
  if (admitted.refused) return refused(admitted.refused);
  const bundle = bundleDir(root, attempt);
  try {
    const frozen = freeze(root, { attempt, session, names: files, ...admitted, taskFile, evidenceFile, full });
    if (frozen.why) return refused(frozen.why);
    const result = await run(root, frozen.manifest, frozen.prompt);
    if (result.status !== 'OK') return { status: result.status, text: `${result.status}: ${result.why}`, bundle };
    const applied = apply(root, frozen.manifest, result);
    if (applied.refused) return { status: 'NOT_DONE', text: `NOT_DONE: ${applied.refused}`, bundle };
    return { status: 'DONE', chain: applied.chain, text: summary(result.answer, applied), bundle };
  } finally {
    release(root, attempt, Object.keys(admitted.files));
  }
}

// ---- Queries for the hooks and the CLI (they throw when the state can't be read) ----

function stateOf(root) {
  const current = state.read(state.files.project(root));
  if (current.unreadable) throw new Error(`the state can't be read (${current.unreadable})`);
  return withMaps(current.data);
}
const pending = (root, session) => Object.values(stateOf(root).changes).filter(c => !session || c.session === session);
const openChains = root => Object.entries(stateOf(root).chains).filter(([, c]) => !c.closed).map(([id]) => id);
const openBugs = root => Object.entries(stateOf(root).chains).filter(([, c]) => !c.closed)
  .flatMap(([chain, c]) => Object.entries(c.findings).filter(([, f]) => f.label === 'BUG' && f.status === 'open').map(([id, f]) => ({ chain, id, ...f })));

module.exports = { review, pending, openChains, openBugs, DELETED };
