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
const pair = require('./pair');

const DELETED = 'deleted'; // the frozen version of a file that doesn't exist
const RISKY_FILE = /\.(mq5|mqh|set)$/i; // trading files: always reviewed in pairs (step 3)
const MAPS = ['changes', 'acks', 'running', 'applied', 'chains', 'escalations', 'plans', 'skips', 'needsPlan', 'riskyReviews'];

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const newAttempt = () => `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
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

// The task file's title, its "## Requirements" section, and each requirement's text by id ("R1.", "R2." ...).
function taskOf(text) {
  const section = text.match(/^## Requirements[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!section) return null;
  const reqs = {};
  let id = null;
  for (const line of section[1].split(/\r?\n/)) {
    const starts = line.match(/^\s*\**(R\d+)[.):]/);
    if (starts) id = starts[1];
    if (id) reqs[id] = reqs[id] === undefined ? line : `${reqs[id]}\n${line}`;
  }
  for (const r of Object.keys(reqs)) reqs[r] = reqs[r].trim();
  const requirements = section[1].trim();
  return { title: (text.match(/^#\s+(.+)$/m) || [, '-'])[1].trim(), requirements, reqHash: sha(requirements), ids: Object.keys(reqs), reqs };
}

// The session's task file and the identity plans and skips are bound to (its id and requirements hash, as a review
// freezes them), or null when the session has none with a Requirements section.
function sessionTask(root, session) {
  if (!session) return null;
  const file = state.files.task(root, session);
  const bytes = bytesOf(file);
  const task = bytes && taskOf(textOf(bytes));
  return task ? { file, id: state.pathKey(path.resolve(file)), reqHash: task.reqHash } : null;
}

const dropDeadMarks = s => { for (const [key, mark] of Object.entries(s.running)) if (!state.alive(mark.pid)) delete s.running[key]; };
const asBaseline = version => (version === DELETED ? null : version); // (a missing file's successor is a new file)

// Reserves an attempt's files in one state transaction, choosing them from the same state the reservation is
// written to. A fresh review takes this session's pending changes plus the named paths, and is paired when any of
// them is risky: a trading file, a file with an escalation, or all of them when the caller asks (`risky`). A
// follow-up (`chain`) takes the chain's files, with their last reviewed versions as baselines; a chain that isn't
// paired leaves out escalated files, which wait for their own paired review. The test plans the files have now are
// copied in, so the answer can only count the plans the reviewers saw. Returns { files, admittedAt, rev, chain,
// paired, riskyKeys, plans } or { refused }.
function admit(root, { attempt, session, named = [], chain = null, risky = false }) {
  const result = state.update(state.files.project(root), data => {
    const s = withMaps(data);
    dropDeadMarks(s);
    const files = {};
    const c = chain && s.chains[chain];
    if (chain) {
      if (!c || c.closed) return { refused: `chain ${chain} is ${c ? 'closed' : 'unknown'}` };
      for (const [key, p] of Object.entries(c.files)) if (c.paired || !s.escalations[key]) files[key] = { path: p };
    } else {
      for (const [key, change] of Object.entries(s.changes)) if (session && change.session === session) files[key] = { path: change.path };
      for (const n of named) files[n.key] = files[n.key] || { path: n.path };
    }
    const keys = Object.keys(files);
    const list = ks => ks.map(k => files[k].path).join(', ');
    if (!keys.length) return { refused: chain ? 'every file of the chain is escalated: each needs its own paired review first' : 'nothing to review: this session has no pending changes and no file was named' };
    const busy = keys.filter(k => s.running[k]);
    if (busy.length) return { refused: `already in a running review: ${list(busy)}` };
    // (a follow-up's risky files: those of the chain's reviews and those GPT rated risky in the chain since)
    const riskyKeys = c ? keys.filter(k => (c.riskyKeys || []).includes(k) || (c.risky || {})[k]) : keys.filter(k => risky || RISKY_FILE.test(k) || s.escalations[k]);
    for (const key of keys) {
      const change = s.changes[key];
      // (without a change record, the baseline is the last reviewed version, if any; freeze falls back to HEAD)
      const baseline = c ? asBaseline(c.frozen[key]) : change ? change.baseline : s.acks[key] === undefined ? undefined : asBaseline(s.acks[key]);
      Object.assign(files[key], change ? { at: change.at, session: change.session } : { at: null }, { baseline });
      s.running[key] = { attempt, pid: process.pid };
    }
    const plans = Object.fromEntries(keys.filter(k => s.plans[k]).map(k => [k, JSON.parse(JSON.stringify(s.plans[k]))]));
    return { files, admittedAt: Date.now(), rev: c ? c.rev : null, chain: c ? { ...JSON.parse(JSON.stringify(c)), id: chain } : null,
      paired: !c && riskyKeys.length > 0, riskyKeys, plans };
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

// What GPT reads about one file: its diff from its baseline, or the whole file when there is no diff to show. In a
// narrow round (past the round limit) an unchanged file shows no code, only that it didn't change. Returns
// { text, whole }: whether the frozen file was shown in full.
function material(root, f, { full = false, narrow = false } = {}) {
  if (f.frozen === DELETED) {
    return { text: `### ${f.path} (deleted)\n${f.baseline ? `Its last version:\n${fence(snapText(root, f.baseline))}` : 'No earlier version is known.'}`, whole: false };
  }
  const text = snapText(root, f.frozen);
  if (!f.baseline) return { text: `### ${f.path} (new file, whole)\n${fence(text)}`, whole: true };
  const diff = full ? '' : diffOf(root, f.baseline, f.frozen);
  if (diff) return { text: `### ${f.path} (diff from its last reviewed version)\n${fence(diff)}`, whole: false };
  return narrow ? { text: `### ${f.path} (unchanged since the last round)`, whole: false } : { text: `### ${f.path} (whole file)\n${fence(text)}`, whole: true };
}

// The project files that mention a risky file's name, sorted: candidate callers from a plain search of their
// decoded text (UTF-16 included), leaving out the reviewed files and anything over 2 MB.
function callersOf(root, riskyPaths, reviewedKeys) {
  const names = [...new Set(riskyPaths.map(p => path.basename(p, path.extname(p))).filter(n => n.length >= 3))];
  if (!names.length) return [];
  const listed = String(git(root, ['ls-files', '-co', '--exclude-standard', '-z'], 'utf8').stdout || '').split('\0').filter(Boolean);
  return [...new Set(listed)].sort().filter(rel => {
    if (reviewedKeys.has(state.pathKey(rel))) return false;
    const abs = path.join(root, rel);
    const stat = fs.existsSync(abs) && fs.statSync(abs);
    if (!stat || !stat.isFile() || stat.size > 2 << 20) return false;
    const text = textOf(fs.readFileSync(abs));
    return names.some(n => text.includes(n));
  });
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

const FOLLOWUP_RULES = `This is a follow-up round of your review of the project in the current folder (read-only). Claude answered the open findings below and changed code; the diff shows what changed since the last round.
The reviewed files may change while you work: read a reviewed file only from its frozen copy, listed under "Frozen copies".
Answer every open finding once, by id: RESOLVED (the code now fixes it), MAINTAIN (it still stands) or CONCEDE (it was never real), with your reason.
Report a new finding only for a real problem in the changed lines or the code that calls them, of MEDIUM severity or above (a LOW one is recorded as a gap). Its fields and labels are those of a review: BUG when it can really happen in normal use and cause real harm (in money or trading code, an unlikely trigger with a big possible loss too), else GAP; location: one of the reviewed paths exactly, optionally with :line or :line-line, or "-" for the task as a whole; test required for CRITICAL and HIGH.
Rate only the requirements under "Changed requirements" (none: no rows). A finding may name any requirement of the task.
class: none, normal or risky for the changed code, with its files and why. coverage: one line.
verdict: ISSUES_REMAIN when a finding is maintained, a new finding is reported or a rated requirement is unmet, else RESOLVED.`;
const NARROW = `
The round limit is reached, so this round checks only the fixed lines. Report no unrelated finding, but do report any bug that a fix itself caused, with its real severity and label.`;

// The open findings, as a follow-up lists them.
const openList = findings => Object.entries(findings).filter(([, f]) => f.status === 'open')
  .map(([id, f]) => `- ${id} [${f.severity} ${f.label}] ${f.title} (${f.location}): ${f.trigger}. Fix: ${f.fix}${f.reason ? `. Last answer: ${f.reason}` : ''}`).join('\n');

// Freezes an attempt into its bundle: snapshots of the files and the task, the prompt built only from them, and
// the manifest the answer is applied from. The fallback reviewer gets the same bundle. A follow-up (`chain`, the
// chain as admitted) gets the open findings, Claude's `response` and only the requirements that changed.
function freeze(root, { attempt, session, names = [], files, admittedAt, rev, taskFile, evidenceFile, full, chain = null, response = '',
  paired = false, riskyKeys = [], plans = {} }) {
  const taskBytes = bytesOf(taskFile);
  if (taskBytes === null) return { why: `the task file ${taskFile} doesn't exist` };
  const task = taskOf(textOf(taskBytes));
  if (!task) return { why: `the task file ${taskFile} has no "## Requirements" section` };
  snapshot(root, taskBytes);
  const taskId = state.pathKey(path.resolve(taskFile));
  const narrow = !!chain && chain.rounds.length >= 3;
  const code = [];
  const wholeKeys = []; // (in a paired attempt, the files the reviewers read in full: these get its receipt)
  for (const [key, f] of Object.entries(files)) {
    f.frozen = snapshot(root, bytesOf(path.join(root, f.path)));
    if (f.baseline === undefined) { // (no change record: the version git has, if any)
      const head = git(root, ['show', `HEAD:${f.path}`]);
      f.baseline = head.status === 0 ? snapshot(root, head.stdout) : null;
    }
    const shown = material(root, f, { full, narrow });
    code.push(shown.text);
    // (a paired review reads a risky file in full, beside its diff)
    const addWhole = paired && riskyKeys.includes(key) && f.frozen !== DELETED && !shown.whole;
    if (addWhole) code.push(`### ${f.path} (whole file, read in full)\n${fence(snapText(root, f.frozen))}`);
    if (paired && (riskyKeys.includes(key) || shown.whole)) wholeKeys.push(key);
  }
  // A plan counts only for this task and its current requirements; the cases and the frozen tests go to GPT.
  const current = Object.fromEntries(Object.entries(plans).filter(([, p]) => p.task === taskId && p.reqHash === task.reqHash));
  const planText = Object.entries(current).map(([key, p]) => `### Test plan of ${files[key].path}\n${(p.cases || []).map(c => `- ${c.id}: ${c.text} (test: ${c.test})`).join('\n')}\n`
    + (p.tests || []).map(t => { const bytes = bytesOf(path.join(root, t)); return `- frozen test ${t}: ${bytes === null ? '(missing)' : snapFile(root, snapshot(root, bytes))}`; }).join('\n')).join('\n\n');
  const callers = paired ? callersOf(root, riskyKeys.map(k => files[k].path), new Set(Object.keys(files))) : [];
  const callerText = callers.slice(0, 20).map(p => `- ${p}: ${snapFile(root, snapshot(root, fs.readFileSync(path.join(root, p))))}`).join('\n')
    + (callers.length > 20 ? `\n(${callers.length - 20} more not shown)` : '');
  if (paired) code.push(`## Candidate callers (a plain name search; frozen copies, not reviewed files)\n${callerText || 'None found.'}`);
  // (any plan that can count for a file in this attempt is shown, so it never counts unseen)
  if (paired || planText) code.push(`## Test plans\n${planText || 'None is current for these files.'}`);
  let evidence = 'None was supplied.';
  if (evidenceFile) {
    const bytes = bytesOf(evidenceFile);
    if (bytes === null) return { why: `the evidence file ${evidenceFile} doesn't exist` };
    const mtime = file => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);
    // (a deletion leaves no time to compare with, so evidence next to one counts as stale)
    const deleted = Object.values(files).some(f => f.frozen === DELETED);
    const older = mtime(evidenceFile) < Math.max(...Object.values(files).map(f => mtime(path.join(root, f.path))));
    const stale = deleted ? '; STALE: a reviewed file was deleted at an unknown time, so it may predate that change'
      : older ? '; STALE: it is older than the last change to a reviewed file' : '';
    evidence = `Supplied by Claude and unverified${stale}.\n${fence(textOf(bytes))}`;
  }
  const lessons = gaps.lessons(root).trim() || 'None.';
  const copies = Object.values(files).map(f => `- ${f.path}: ${f.frozen === DELETED ? '(deleted)' : snapFile(root, f.frozen)}`).join('\n');
  const tail = `## Project lessons (confirmed past mistakes)\n${lessons}\n\n## Reviewed files\n${code.join('\n\n')}\n\n`
    + `## Frozen copies (the reviewed versions, whole)\n${copies}\n\n## Evidence\n${evidence}\n`;
  const rowIds = chain ? task.ids.filter(id => (chain.task.reqs || {})[id] !== task.reqs[id]) : task.ids;
  const prompt = chain
    ? `${FOLLOWUP_RULES}${narrow ? NARROW : ''}\n\n## Open findings\n${openList(chain.findings) || 'None.'}\n\n## Claude's response\n${response.trim() || '-'}\n\n`
      + `## Changed requirements\n${rowIds.map(id => task.reqs[id]).join('\n') || 'None.'}\n\n${tail}`
    : `${RULES}\n\n## Task requirements (the authority on what the work must do)\n${task.requirements}\n\n${tail}`;
  const manifest = { attempt, kind: chain ? 'followup' : 'review', root, session, names, admittedAt, files, chain: chain ? chain.id : null, rev,
    openIds: chain ? Object.keys(chain.findings).filter(id => chain.findings[id].status === 'open') : [],
    paired, riskyKeys, wholeKeys, plans: Object.fromEntries(Object.entries(current).map(([key, p]) => [key, sha(JSON.stringify(p))])),
    task: { path: taskFile, id: taskId, title: task.title, sha: sha(taskBytes), reqHash: task.reqHash, rowIds, linkIds: task.ids, reqs: task.reqs } };
  fs.mkdirSync(bundleDir(root, attempt), { recursive: true });
  fs.writeFileSync(path.join(bundleDir(root, attempt), 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(bundleDir(root, attempt), 'prompt.md'), prompt);
  return { manifest, prompt };
}

const askedOf = manifest => ({ rowIds: manifest.task.rowIds, linkIds: manifest.task.linkIds,
  files: Object.values(manifest.files).map(f => f.path), openIds: manifest.openIds || [] });
const NO_ANSWER = '# Answer\n\n(no answer:';

// The chain's accepted rounds as GPT saw and answered them, in order: what a fresh session needs to go on.
function historyOf(root, chain) {
  const turns = chain.rounds.flatMap((attempt, i) => {
    const dir = bundleDir(root, attempt);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^turn-/.test(f)).sort() : [];
    return files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).filter(t => !t.includes(NO_ANSWER)).map(t => `# Round ${i + 1}\n\n${t}`);
  });
  return `This review continues in a new session. Its earlier rounds:\n\n${turns.join('\n\n')}`;
}

// Runs GPT on a prompt, with one repair in the same session. A follow-up resumes the chain's session (`resume`), or
// starts a fresh one with the chain's `history` when there is none or resuming fails; with `strict` (a pair's
// cross-check, which needs that very session) a failed resume is the end. `kind` and `asked` default to the
// manifest's; `label` names the turns saved in the bundle (turn-<label>-<n>.md), so a pair's turns don't overlap.
async function run(root, manifest, prompt, { resume = null, history = '', strict = false, kind = manifest.kind, asked = askedOf(manifest), label = '', effort = 'high' } = {}) {
  const schema = answer.SCHEMAS[kind];
  const save = (n, text, result) => fs.writeFileSync(path.join(bundleDir(root, manifest.attempt), `turn-${label ? `${label}-` : ''}${n}.md`),
    `# Prompt\n\n${text}\n\n${result.ok ? `# Answer\n\n${result.text}` : `${NO_ANSWER} ${result.reason})`}\n`);
  let first = null;
  if (resume) {
    first = await codex.ask({ mode: 'review', effort, resume, schema, prompt, cwd: root });
    save(1, prompt, first);
    if (first.ok) first.sessionId = first.sessionId || resume;
  }
  if (!first || (!first.ok && !first.unavailable && !strict)) {
    // (a follow-up without a session to resume, e.g. after a fallback round, starts fresh with the chain's history)
    const fresh = history ? `${history}\n\n# The current round\n\n${prompt}` : prompt;
    first = await codex.ask({ mode: 'review', effort, persist: true, schema, prompt: fresh, cwd: root });
    save(resume ? '1-fresh' : 1, fresh, first);
  }
  // (a run Codex couldn't complete even after its retry means GPT is unavailable, so the fallback takes the bundle;
  // only a pair's cross-check, a strict resume, runs again instead)
  if (!first.ok) return { status: first.unavailable || !(resume && strict) ? 'GPT_UNAVAILABLE' : 'NOT_DONE', why: first.reason };
  let checked = answer.read(kind, first.text, asked);
  if (checked.problems.length) {
    if (!first.sessionId) return { status: 'NOT_DONE', why: `the answer has problems and its session can't be resumed: ${checked.problems.join('; ')}` };
    const repair = `Your answer has these problems. Answer again, in full, without them:\n- ${checked.problems.join('\n- ')}`;
    const second = await codex.ask({ mode: 'review', effort, resume: first.sessionId, schema, prompt: repair, cwd: root });
    save(2, repair, second);
    if (!second.ok) return { status: second.unavailable || !strict ? 'GPT_UNAVAILABLE' : 'NOT_DONE', why: second.reason }; // (as above)
    checked = answer.read(kind, second.text, asked);
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

// A finding as a KNOWN_GAPS.md entry.
const gapItem = (task, log, fid, f, why) => ({ task: task.title, where: [f.location], problem: `${fid}: ${f.title}`, trigger: f.trigger,
  severity: f.severity, fix: f.fix, test: f.test, log, why });

// Applies a checked answer in one locked write of the project state; KNOWN_GAPS.md changes first (the round's new
// GAP findings added, resolved or conceded ones marked fixed), under the same lock. A follow-up applies only to the
// chain revision it began from. Returns { chain, added, acked, pending, escalated, taskChanged } or { refused }.
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
    const id = manifest.chain || `C${manifest.attempt}`;
    let chain = s.chains[id];
    if (manifest.chain && (!chain || chain.closed || chain.rev !== manifest.rev)) {
      return { refused: `chain ${id} changed or closed since this round began, so nothing was applied` };
    }
    if (!manifest.chain) {
      chain = { rev: 0, began: manifest.admittedAt, session: manifest.session, rounds: [], codexSession: null, closed: false, files: {}, frozen: {}, findings: {} };
    }
    // (only a pair whose four runs all completed counts as a paired review: a fallback answer is one reviewer; the
    // chain keeps its risky files either way, so their follow-ups still need a plan)
    const pairComplete = !!(manifest.paired && result.pairComplete);
    chain.riskyKeys = [...new Set([...(chain.riskyKeys || []), ...manifest.riskyKeys])];
    if (pairComplete) chain.paired = true;
    const narrow = chain.rounds.length >= 3;
    const fixedGaps = [];
    for (const row of result.answer.followups || []) {
      const f = chain.findings[row.id];
      f.reason = row.reason;
      if (row.status !== 'MAINTAIN') f.status = row.status === 'RESOLVED' ? 'resolved' : 'conceded';
      if (row.status !== 'MAINTAIN' && f.gap) fixedGaps.push(f.gap);
    }
    let n = Object.keys(chain.findings).length;
    const added = [];
    for (const f of findingsOf(result.answer)) {
      if (manifest.kind === 'followup' && !narrow && f.severity === 'LOW') f.label = 'GAP'; // (past the limit, a regression keeps its label)
      chain.findings[`F${++n}`] = f;
      added.push(`F${n}`);
    }
    const newGaps = added.filter(fid => chain.findings[fid].label === 'GAP');
    const gapsFile = path.join(root, gaps.NAME);
    let gapText = null;
    if (newGaps.length || fixedGaps.length) {
      const known = gaps.readFile(root);
      if (known.unreadable) return { refused: `KNOWN_GAPS.md can't be read (${known.unreadable}), so nothing was applied` };
      const composed = gaps.compose(root, known.text, newGaps.map(fid => gapItem(manifest.task, manifest.attempt, fid, chain.findings[fid],
        chain.findings[fid].agreement ? `pair: ${chain.findings[fid].agreement}` : `labelled GAP by the reviewer; harm: ${chain.findings[fid].harm}`)));
      newGaps.forEach((fid, i) => { chain.findings[fid].gap = composed.ids[i]; });
      if (composed.added.length && !write(gapsFile, composed.text)) return { refused: 'the lock was taken over, so nothing was applied' };
      gapText = composed.text;
    }
    const taskBytes = bytesOf(manifest.task.path);
    const taskChanged = taskBytes === null || sha(taskBytes) !== manifest.task.sha;
    const ratedRisky = result.answer.class.level === 'risky' ? result.answer.class.files.map(state.pathKey) : [];
    const { id: taskId, reqHash } = manifest.task;
    const forThisTask = r => !!r && r.task === taskId && r.reqHash === reqHash;
    const acked = [], pending = [], escalated = [], unplanned = [];
    for (const [key, f] of Object.entries(manifest.files)) {
      const record = s.changes[key];
      const sameRecord = record ? record.at === f.at && record.session === f.session : f.at === null;
      const unchanged = sameRecord && versionOf(root, f.path) === f.frozen; // (still the version the reviewers read)
      // (the pair read it in full: its paired review is done, but only for that version; a file changed since stays
      // escalated, so its next review is paired again)
      if (pairComplete && manifest.wholeKeys.includes(key) && unchanged && !taskChanged) {
        s.riskyReviews[key] = manifest.admittedAt;
        delete s.escalations[key];
        chain.wholeKeys = [...new Set([...(chain.wholeKeys || []), key])];
      }
      if (ratedRisky.includes(key)) {
        // (from now on only a real test plan counts for it in this task, never a skip; each task keeps its own record)
        const records = [].concat(s.needsPlan[key] || []).filter(r => !forThisTask(r));
        s.needsPlan[key] = [...records, { task: taskId, reqHash }];
        // (a file this chain's pair read in full needs a plan, not another pair; any other file that turns risky gets
        // its own paired review, as in a chain that isn't paired)
        if (!(chain.wholeKeys || []).includes(key)) {
          s.escalations[key] = { chain: id, at: Date.now() };
          chain.risky = { ...chain.risky, [key]: Date.now() }; // (this chain's own record: closing it needs a paired review)
          escalated.push(f.path);
        }
      }
      // A risky file is acknowledged only with the test plan the reviewers saw, still current for this task; a
      // trading file may have a skip instead, unless GPT ever rated it risky for this task.
      const planned = forThisTask(s.plans[key]) && manifest.plans[key] === sha(JSON.stringify(s.plans[key]));
      const foundRisky = [].concat(s.needsPlan[key] || []).some(forThisTask);
      const skipped = RISKY_FILE.test(key) && forThisTask(s.skips[key]) && !foundRisky;
      // (once a file was found risky for this task or in this chain, it needs a plan however a later round rates it)
      const needsPlan = manifest.riskyKeys.includes(key) || ratedRisky.includes(key) || (chain.riskyKeys || []).includes(key)
        || Object.keys(chain.risky || {}).includes(key) || foundRisky;
      if (needsPlan && !planned && !skipped) unplanned.push(f.path);
      const reviewed = !taskChanged && !s.escalations[key];
      if (reviewed && unchanged && (!needsPlan || planned || skipped)) {
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
    chain.rounds.push(manifest.attempt);
    chain.rev += 1;
    chain.task = manifest.task;
    chain.codexSession = result.session || null; // (a fallback round leaves none: the next round starts fresh with the history)
    s.applied[manifest.attempt] = true;
    s.chains[id] = chain;
    if (!write(stateFile, JSON.stringify(s, null, 2))) return { refused: 'the lock was taken over, so the state was not changed' };
    // (gaps are marked fixed only once the state holds their resolution: a failed write leaves them open, never hidden)
    const marked = fixedGaps.reduce((t, g) => gaps.composeMark(t, g, 'fixed') || t, gapText);
    if (fixedGaps.length && marked !== gapText) write(gapsFile, marked);
    return { chain: id, added: Object.fromEntries(added.map(fid => [fid, chain.findings[fid]])), acked, pending, escalated, unplanned, taskChanged };
  });
  return done.ok === false ? { refused: done.why } : done;
}

// What Claude reads after a round: the answer with the chain's ids for its new findings, and what was acknowledged.
function summary(a, applied) {
  const findings = Object.entries(applied.added).map(([id, f]) => ({ ...f, id }));
  const lines = [`chain ${applied.chain}`, answer.render({ ...a, findings })];
  if (applied.acked.length) lines.push(`acknowledged: ${applied.acked.join(', ')}`);
  if (applied.pending.length) lines.push(`still pending (changed during the review, rated risky, or the task changed): ${applied.pending.join(', ')}`);
  if (applied.escalated.length) lines.push(`rated risky by GPT, so they need a test plan and a paired review: ${applied.escalated.join(', ')}`);
  if (applied.unplanned.length) lines.push(`not acknowledged until they have a current test plan (a trading file not rated risky may have a skip): ${applied.unplanned.join(', ')}`);
  if (applied.taskChanged) lines.push('the task file changed during the review, so nothing was acknowledged: run the review again');
  return lines.join('\n');
}

// A fresh review of this session's pending changes plus the named files (`files`, from the project root), against
// `taskFile`; paired when a file is risky (or `risky`). Returns { status, text, chain, bundle }: status DONE,
// REFUSED, GPT_UNAVAILABLE, PAIR_INCOMPLETE or NOT_DONE (the bundle stays for another run or the fallback reviewer).
async function review(root, { session = null, files = [], taskFile = null, evidenceFile = null, full = false, risky = false } = {}) {
  const refused = why => ({ status: 'REFUSED', text: `REFUSED: ${why}` });
  if (!taskFile) return refused('a review needs its task file');
  if (!session && !files.length) return refused('without a session id, name the files to review');
  const resolved = resolveNamed(root, files);
  if (resolved.why) return refused(resolved.why);
  const attempt = newAttempt();
  const admitted = admit(root, { attempt, session, named: resolved.named, risky });
  if (admitted.refused) return refused(admitted.refused);
  const bundle = bundleDir(root, attempt);
  try {
    const frozen = freeze(root, { attempt, session, names: files, ...admitted, taskFile, evidenceFile, full });
    if (frozen.why) return refused(frozen.why);
    const result = frozen.manifest.paired
      ? await pair.runPair({ prompt: frozen.prompt, materialize: findingsOf,
        runOne: (prompt, options) => run(root, frozen.manifest, prompt, { ...options, effort: 'xhigh' }) })
      : await run(root, frozen.manifest, frozen.prompt);
    if (result.status !== 'OK') {
      const unavailable = result.status === 'GPT_UNAVAILABLE' || !!result.unavailable; // (then the fallback reviewer takes the bundle)
      return { status: result.status, unavailable, text: `${result.status}: ${result.why}`, bundle };
    }
    const applied = apply(root, frozen.manifest, result);
    if (applied.refused) return { status: 'NOT_DONE', text: `NOT_DONE: ${applied.refused}`, bundle };
    return { status: 'DONE', chain: applied.chain, text: summary(result.answer, applied), bundle };
  } finally {
    release(root, attempt, Object.keys(admitted.files));
  }
}

// The next round of a chain: its open findings by id, Claude's response (`responseFile`) and the code changed since
// the last round. Returns the same shape as `review`.
async function followup(root, { chain: id, responseFile, evidenceFile = null }) {
  const refused = why => ({ status: 'REFUSED', text: `REFUSED: ${why}` });
  const response = responseFile ? bytesOf(responseFile) : null;
  if (response === null) return refused('a follow-up needs Claude\'s response file');
  const attempt = newAttempt();
  const admitted = admit(root, { attempt, chain: id });
  if (admitted.refused) return refused(admitted.refused);
  const bundle = bundleDir(root, attempt);
  try {
    const { chain } = admitted;
    const frozen = freeze(root, { attempt, session: chain.session, ...admitted, taskFile: chain.task.path, evidenceFile, response: textOf(response) });
    if (frozen.why) return refused(frozen.why);
    // (a paired chain's follow-ups are one GPT at xhigh, resuming reviewer A; so are a fallback chain's with risky files)
    const effort = chain.paired || admitted.riskyKeys.length ? 'xhigh' : 'high';
    const result = await run(root, frozen.manifest, frozen.prompt, { resume: chain.codexSession, history: historyOf(root, chain), effort });
    if (result.status !== 'OK') return { status: result.status, text: `${result.status}: ${result.why}`, bundle };
    const applied = apply(root, frozen.manifest, result);
    if (applied.refused) return { status: 'NOT_DONE', text: `NOT_DONE: ${applied.refused}`, bundle };
    return { status: 'DONE', chain: id, text: summary(result.answer, applied), bundle };
  } finally {
    release(root, attempt, Object.keys(admitted.files));
  }
}

const ROUND_LIMIT = /\bround(s)?\b.*\blimit\b|\blimit\b.*\bround/i;

// Closes a chain. Every open BUG needs a disposition in `notes`: "gap: <why it is left unfixed>" ({ F3: 'gap: ...' }),
// which relabels it a GAP. A fix counts only once a follow-up resolved it, so nothing else is accepted, and the
// round limit is never a reason. A file rated risky in this chain needs a paired review recorded after the chain
// began. The relabelled BUGs go into KNOWN_GAPS.md first, under the same lock. `rev` is the revision the caller saw.
function close(root, { chain: id, notes = {}, rev }) {
  const stateFile = state.files.project(root);
  const done = state.withLock(stateFile, write => {
    const current = state.read(stateFile);
    if (current.unreadable) return { refused: `the state can't be read (${current.unreadable})` };
    const s = withMaps(current.data);
    const c = s.chains[id];
    if (!c || c.closed) return { refused: `chain ${id} is ${c ? 'already closed' : 'unknown'}` };
    if (c.rev !== rev) return { refused: `chain ${id} is at revision ${c.rev}, not ${rev}: read it again before closing it` };
    const problems = [];
    const relabel = [];
    for (const [fid, f] of Object.entries(c.findings)) {
      if (f.label !== 'BUG' || f.status !== 'open') continue;
      const why = ((String(notes[fid] || '').trim().match(/^gap:\s*([\s\S]+)$/i) || [])[1] || '').trim();
      if (!why) problems.push(`${fid} is an open BUG: close it only with "gap: <why it is left unfixed>" (a fix counts once a follow-up resolves it)`);
      else if (ROUND_LIMIT.test(why)) problems.push(`${fid}: the round limit is never a reason`);
      else relabel.push([fid, f, why]);
    }
    for (const key of Object.keys(c.risky || {})) {
      // (the receipt must be newer than the file's latest risky rating in this chain, so an older pair of an older
      // version never counts for a later one)
      if (!((s.riskyReviews || {})[key] > c.risky[key])) problems.push(`${c.files[key]} was rated risky in this chain: it needs a paired review recorded after that`);
    }
    if (problems.length) return { refused: problems.join('; ') };
    if (relabel.length) {
      const known = gaps.readFile(root);
      if (known.unreadable) return { refused: `KNOWN_GAPS.md can't be read (${known.unreadable}), so nothing was closed` };
      const composed = gaps.compose(root, known.text, relabel.map(([fid, f, why]) => gapItem(c.task, c.rounds[c.rounds.length - 1], fid, f, why)));
      if (composed.added.length && !write(path.join(root, gaps.NAME), composed.text)) return { refused: 'the lock was taken over, so nothing was closed' };
      relabel.forEach(([, f, why], i) => Object.assign(f, { label: 'GAP', status: 'closed', reason: why, gap: composed.ids[i] }));
    }
    c.closed = true;
    c.rev += 1;
    if (!write(stateFile, JSON.stringify(s, null, 2))) return { refused: 'the lock was taken over, so the state was not changed' };
    return { chain: id, relabelled: relabel.map(([fid, f]) => `${fid} (${f.gap})`) };
  });
  if (done.ok === false || done.refused) return { status: 'REFUSED', text: `REFUSED: ${done.why || done.refused}` };
  return { status: 'DONE', text: `closed chain ${id}${done.relabelled.length ? `; recorded as gaps: ${done.relabelled.join(', ')}` : ''}` };
}

// Applies a fallback reviewer's answer (`answerFile`) to a bundle GPT couldn't finish: checked against the bundle's
// own manifest, with its files reserved again, applied once and only to the frozen versions.
function fallback(root, { bundle, answerFile }) {
  const refused = why => ({ status: 'REFUSED', text: `REFUSED: ${why}` });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  } catch (e) {
    return refused(`${bundle} has no readable manifest (${e.message})`);
  }
  if (state.projectDir(manifest.root) !== state.projectDir(root)) return refused(`${bundle} belongs to another project (${manifest.root})`);
  const given = answerFile ? bytesOf(answerFile) : null;
  if (given === null) return refused('the fallback answer file is missing');
  const checked = answer.read(manifest.kind, textOf(given), askedOf(manifest));
  if (checked.problems.length) return refused(`the answer has problems: ${checked.problems.join('; ')}`);
  const keys = Object.keys(manifest.files);
  const reserved = state.update(state.files.project(root), data => {
    const s = withMaps(data);
    dropDeadMarks(s);
    if (s.applied[manifest.attempt]) return 'this bundle\'s answer was already applied';
    const busy = keys.filter(k => s.running[k]);
    if (busy.length) return `already in a running review: ${busy.map(k => manifest.files[k].path).join(', ')}`;
    for (const key of keys) s.running[key] = { attempt: manifest.attempt, pid: process.pid };
    return null;
  });
  if (!reserved.ok || reserved.value) return refused(reserved.why || reserved.value);
  try {
    fs.writeFileSync(path.join(bundle, 'turn-fallback.md'), `# Prompt\n\n${fs.readFileSync(path.join(bundle, 'prompt.md'), 'utf8')}\n\n# Answer\n\n${textOf(given)}\n`);
    const applied = apply(root, manifest, { answer: checked.answer, session: null });
    if (applied.refused) return { status: 'NOT_DONE', text: `NOT_DONE: ${applied.refused}`, bundle };
    return { status: 'DONE', chain: applied.chain, text: summary(checked.answer, applied), bundle };
  } finally {
    release(root, manifest.attempt, keys);
  }
}

// Acknowledges a task's changes without GPT (`review --skip`), for a task that touches nothing but comments,
// formatting or docs: this session's pending changes plus the named files, at their current versions. Everything is
// chosen and checked in the same locked state write that acknowledges it. Refused without a reason, for any risky
// file (a trading file, an escalated one, one GPT rated risky for any task, one with a test plan, one in an open
// chain's risky list) and for a file under review. The reason is kept with the versions, apart from test-plan skips.
function skip(root, { session = null, files = [], why = '' }) {
  const refused = text => ({ status: 'REFUSED', text: `REFUSED: ${text}` });
  const reason = String(why).trim();
  if (!reason) return refused('a review skip needs its reason (--why "...")');
  if (!session && !files.length) return refused('without a session id, name the files to skip');
  const resolved = resolveNamed(root, files);
  if (resolved.why) return refused(resolved.why);
  const done = state.update(state.files.project(root), data => {
    const s = withMaps(data);
    dropDeadMarks(s);
    const chosen = {};
    for (const [key, change] of Object.entries(s.changes)) if (session && change.session === session) chosen[key] = change.path;
    for (const n of resolved.named) chosen[n.key] = chosen[n.key] || n.path;
    const keys = Object.keys(chosen);
    const list = ks => ks.map(k => chosen[k]).join(', ');
    if (!keys.length) return { refused: 'nothing to skip: this session has no pending changes and no file was named' };
    const chainRisky = new Set(Object.values(s.chains).filter(c => !c.closed).flatMap(c => [...(c.riskyKeys || []), ...Object.keys(c.risky || {})]));
    const risky = keys.filter(k => RISKY_FILE.test(k) || s.escalations[k] || [].concat(s.needsPlan[k] || []).length || s.plans[k] || chainRisky.has(k));
    if (risky.length) return { refused: `a review skip is only for comments, formatting or docs, never for risky files: ${list(risky)}` };
    const busy = keys.filter(k => s.running[k]);
    if (busy.length) return { refused: `already in a running review: ${list(busy)}` };
    const versions = {};
    for (const key of keys) {
      versions[key] = snapshot(root, bytesOf(path.join(root, chosen[key])));
      s.acks[key] = versions[key];
      delete s.changes[key];
    }
    s.reviewSkips = [...(s.reviewSkips || []), { at: Date.now(), session, why: reason, versions }];
    return { acked: keys.map(k => chosen[k]) };
  });
  if (!done.ok) return refused(done.why);
  if (done.value.refused) return refused(done.value.refused);
  return { status: 'DONE', text: `acknowledged without GPT (${reason}): ${done.value.acked.join(', ')}` };
}

// ---- Queries for the hooks and the CLI (they throw when the state can't be read) ----

function stateOf(root) {
  const current = state.read(state.files.project(root));
  if (current.unreadable) throw new Error(`the state can't be read (${current.unreadable})`);
  return withMaps(current.data);
}
const pending = (root, session) => Object.values(stateOf(root).changes).filter(c => !session || c.session === session);
const openChains = root => Object.entries(stateOf(root).chains).filter(([, c]) => !c.closed).map(([id]) => id);
// (in a state already read: the hooks check it in the same read as the changes)
const bugsIn = s => Object.entries(s.chains).filter(([, c]) => !c.closed)
  .flatMap(([chain, c]) => Object.entries(c.findings || {}).filter(([, f]) => f.label === 'BUG' && f.status === 'open').map(([id, f]) => ({ chain, id, ...f })));
const openBugs = root => bugsIn(stateOf(root));

module.exports = { review, followup, close, fallback, skip, pending, openChains, openBugs, bugsIn, DELETED,
  RISKY_FILE, sessionTask, stateOf, withMaps, bytesOf, textOf, snapshot, snapFile, versionOf, asBaseline };
