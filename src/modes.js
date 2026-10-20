// modes.js: GPT's jobs besides reviews (DESIGN.md section 4): test plans and skips, plan reviews, ideas, digests,
// research and long documents. Each is one read-only Codex run with a fixed JSON answer and one repair, through
// review.js's runner, with its prompt and turns kept in a bundle like a review's.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const state = require('./state');
const codex = require('./codex');
const answer = require('./answer');
const review = require('./review');
const gaps = require('./gaps');
const pair = require('./pair');
const { planKey } = require('./hook');

const refused = text => ({ status: 'REFUSED', text: `REFUSED: ${text}` });
const fence = text => { const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${ticks}\n${text}\n${ticks}`; };
const failed = r => ({ status: r.status, unavailable: r.status === 'GPT_UNAVAILABLE' || !!r.unavailable, text: `${r.status}: ${r.why}`, bundle: r.bundle });

// A new bundle for one job, holding its prompt; `files` are what a review-shaped answer may point at.
function bundleFor(root, kind, prompt, { files = [], task = null } = {}) {
  const attempt = review.newAttempt();
  const dir = review.bundleDir(root, attempt);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  const ids = task ? task.ids : [];
  return { attempt, kind, dir, files: Object.fromEntries(files.map(f => [state.pathKey(f), { path: f }])), task: { rowIds: ids, linkIds: ids }, openIds: [] };
}

// One GPT run of `kind` in its own bundle: the runner's result, plus the bundle.
async function ask(root, kind, prompt, { asked, effort = 'high', mode = 'consult', docs = null }) {
  const manifest = bundleFor(root, kind, prompt);
  return { ...await review.run(root, manifest, prompt, { kind, asked, effort, mode, docs }), bundle: manifest.dir };
}

// The task a test plan or skip belongs to, and the targets as project-relative paths (they may not exist yet).
function targetsOf(root, taskFile, files) {
  const task = taskFile && review.taskInfo(taskFile);
  if (!task) return { why: `the task file ${taskFile || '(none)'} doesn't exist or has no "## Requirements" section` };
  if (!files.length) return { why: 'name the files (--files a,b)' };
  const rels = [];
  for (const f of files) {
    const rel = path.relative(root, path.resolve(root, f)).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { why: `${f} is outside the project` };
    rels.push(rel);
  }
  return { task, rels };
}

const TESTPLAN_RULES = `You design the test cases for a change before its code is written, for the project in the current folder (read-only). Read the target files (some may not exist yet) and the context files yourself.
At most 5 cases: the main path, plus the realistic ways the change could lose money, lose data or open a security hole. No variants, nothing for logging, formatting or unlikely edge cases.
Each case: id (T1, T2, ... in order); severity (CRITICAL, HIGH or MEDIUM); covers: the target paths it tests, written exactly as listed below; reqs: the requirement ids it serves; input; expected; test_file (a path inside the project) and test_name.
not_worth_testing: one line on what you left out and why.`;

// Designs a change's test cases with GPT at xhigh, and stores each covered target's cases as its plan for the task,
// only if the task's requirements didn't change meanwhile.
async function testplan(root, { taskFile, files, context = [] }) {
  const found = targetsOf(root, taskFile, files);
  if (found.why) return refused(found.why);
  const { task, rels } = found;
  const missing = context.filter(c => !fs.existsSync(path.resolve(root, c)));
  if (missing.length) return refused(`context files must exist: ${missing.join(', ')}`);
  const docs = review.docsFor(rels);
  const prompt = `${TESTPLAN_RULES}${docs ? review.DOCS_NOTE : ''}\n\n## Task requirements\n${task.requirements}\n\n`
    + `## Target files\n${rels.map(r => `- ${r}${fs.existsSync(path.join(root, r)) ? '' : ' (new)'}`).join('\n')}\n\n## Context files\n${context.map(c => `- ${c}`).join('\n') || 'None.'}\n`;
  const r = await ask(root, 'testplan', prompt, { asked: { targets: rels, linkIds: task.ids }, effort: 'xhigh', docs });
  if (r.status !== 'OK') return failed(r);
  const covered = rels.filter(rel => r.answer.cases.some(c => c.covers.includes(rel)));
  const done = state.update(state.files.project(root), data => {
    const s = review.withMaps(data);
    const now = review.taskInfo(taskFile);
    if (!now || now.reqHash !== task.reqHash) return 'the task\'s requirements changed while GPT designed the cases, so nothing was stored: run testplan again';
    for (const rel of covered) {
      const cases = r.answer.cases.filter(c => c.covers.includes(rel));
      s.plans[state.pathKey(rel)] = { task: task.id, reqHash: task.reqHash, at: Date.now(),
        cases: cases.map(c => ({ id: c.id, text: `[${c.severity}] ${c.input} -> ${c.expected} (${c.reqs.join(', ')})`, test: `${c.test_file} — ${c.test_name}` })),
        tests: [...new Set(cases.map(c => c.test_file.trim().replace(/\\/g, '/')))] };
    }
    return null;
  });
  if (!done.ok || done.value) return refused(done.why || done.value);
  const uncovered = rels.filter(rel => !covered.includes(rel));
  return { status: 'DONE', text: [...r.answer.cases.map(c => `${c.id} [${c.severity}] covers ${c.covers.join(', ')} (${c.reqs.join(', ')}): ${c.input} -> ${c.expected} (test: ${c.test_file} — ${c.test_name})`),
    `not worth testing: ${r.answer.not_worth_testing}`, `stored as this task's test plan of: ${covered.join(', ')}`,
    ...(uncovered.length ? [`no case covers ${uncovered.join(', ')}, so no plan was stored for it: plan it again`] : [])].join('\n') };
}

// Records that files need no test plan in this task; refused once GPT rated one risky in it, or while it is escalated.
function skip(root, { taskFile, files, why }) {
  if (!String(why || '').trim()) return refused('a skip needs its reason (--why "...")');
  const found = targetsOf(root, taskFile, files);
  if (found.why) return refused(found.why);
  const { task, rels } = found;
  const forTask = r => !!r && r.task === task.id && r.reqHash === task.reqHash;
  const done = state.update(state.files.project(root), data => {
    const s = review.withMaps(data);
    const rated = rels.filter(rel => s.escalations[state.pathKey(rel)] || [].concat(s.needsPlan[state.pathKey(rel)] || []).some(forTask));
    if (rated.length) return `GPT rated ${rated.join(', ')} risky, so only a test plan counts: run testplan`;
    for (const rel of rels) s.skips[state.pathKey(rel)] = { task: task.id, reqHash: task.reqHash, why: String(why).trim(), at: Date.now() };
    return null;
  });
  if (!done.ok || done.value) return refused(done.why || done.value);
  return { status: 'DONE', text: `skip recorded for this task: ${rels.join(', ')}` };
}

const PLAN_RULES = `You review a plan before its work starts, for the project in the current folder (read-only). Judge whether following it does what the task asks, safely and simply.
Report every real problem as a finding: BUG when following the plan would really cause harm (a wrong result, lost data, lost money or a security hole; in money or trading work, an unlikely trigger with a big possible loss too), else GAP.
Each finding: severity; title; location: the plan's name below, or "-"; trigger; harm; failure; fix: the smallest change that works, with no option, layer or config the problem doesn't need; test (required for CRITICAL and HIGH, else null); label; reqs: the requirement ids it shows unmet.
Rate every requirement once, by whether the plan delivers it: MET (with evidence), PARTIAL, NOT_MET or NOT_IN_THIS_CHANGE.
possibly_missing: requirements the work clearly needs that the list lacks. class: none, normal or risky for the work the plan describes (files: [] or the plan's name), and why. coverage: one line.
verdict: ISSUES_FOUND when there is a finding or an unmet requirement, else NO_ISSUES.`;

// Reviews a plan (paired at xhigh with `risky`), or records a reasoned skip, under the hash the plan gate checks:
// the text as read when the review began, whatever the verdict, so only that exact plan may leave plan mode.
async function plan(root, { file, taskFile, risky, skipWhy }) {
  const bytes = file ? review.bytesOf(path.resolve(file)) : null;
  const text = bytes === null ? '' : review.textOf(bytes);
  if (!text.trim()) return refused(`the plan file ${file || '(none)'} doesn't exist or is empty`);
  // (bound to the task's requirements as they are now, so a changed request needs the plan reviewed again)
  const task = taskFile ? review.taskInfo(taskFile) : null;
  // (only while the requirements are still those the review saw; each task keeps its own record of a plan)
  const record = rec => {
    const saved = state.update(state.files.global(), g => {
      const now = taskFile ? review.taskInfo(taskFile) : null;
      if (task && (!now || now.reqHash !== task.reqHash)) return 'the task\'s requirements changed meanwhile, so nothing was recorded: run plan again';
      g.plans = { ...(g.plans || {}), [planKey(text, task)]: { at: Date.now(), task: task ? task.id : null, reqHash: task ? task.reqHash : null, ...rec } };
      return null;
    });
    return saved.ok ? saved.value : saved.why;
  };
  if (skipWhy !== undefined) {
    if (!String(skipWhy).trim()) return refused('a plan skip needs its reason (--why "...")');
    const problem = record({ skip: String(skipWhy).trim() });
    return problem ? refused(problem) : { status: 'DONE', text: 'plan skip recorded: this exact plan text may leave plan mode' };
  }
  const name = path.basename(file);
  const prompt = `${PLAN_RULES}\n\n## Task requirements\n${task ? task.requirements : 'No task file: rate no requirement.'}\n\n`
    + `## Project lessons (confirmed past mistakes)\n${gaps.lessons(root).trim() || 'None.'}\n\n## The plan (${name})\n${fence(text)}\n`;
  const manifest = bundleFor(root, 'review', prompt, { files: [name], task });
  // (a pair's cross-check passes its own `asked`; the plan's comes from the manifest)
  const r = risky
    ? await pair.runPair({ prompt, materialize: review.findingsOf, runOne: (p, options) => review.run(root, manifest, p, { ...options, effort: 'xhigh' }) })
    : await review.run(root, manifest, prompt, { effort: 'high' });
  if (r.status !== 'OK') return failed({ ...r, bundle: manifest.dir });
  const problem = record({ verdict: r.answer.verdict, bundle: manifest.dir });
  if (problem) return refused(problem);
  return { status: 'DONE', text: `${answer.render({ ...r.answer, findings: review.findingsOf(r.answer) })}\nrecorded: this exact plan text may leave plan mode; a revised plan needs another review, or a plan skip with its reason.` };
}

// The simple jobs: one input, one answer shape, shown as text. `write` saves its document as a draft, unapplied.
const SIMPLE = {
  idea: { rules: 'You give a second opinion on a proposal for the project in the current folder (read-only): whether it is sound, what could go wrong, and what you recommend instead. verdict: SOUND, CHANGES_RECOMMENDED or AGAINST.',
    show: a => [`VERDICT: ${a.verdict}`, `recommendation: ${a.recommendation}`, ...a.points.map(p => `- [${p.severity}] ${p.point} (${p.why})`)] },
  digest: { rules: 'You read large material for Claude (read-only): logs, reports or unfamiliar code. Read the listed paths yourself and answer the question. evidence: each claim\'s place as path:line, with its exact quote. counts: passed and failed (null when that doesn\'t apply) and the first failure. scope: what you read, and anything cut off. confidence: proven or hypothesis.',
    show: a => [`answer: ${a.answer}`, ...a.evidence.map(e => `- ${e.place}: "${e.quote}"`), `counts: passed ${a.counts.passed}, failed ${a.counts.failed}, first failure: ${a.counts.first_failure || '-'}`, `scope: ${a.scope}`, `confidence: ${a.confidence}`] },
  research: { mode: 'research', rules: 'You look things up on the web for Claude. Answer the question, with sources: each source\'s URL and the claim it backs. confidence: proven or hypothesis.',
    show: a => [`answer: ${a.answer}`, ...a.sources.map(s => `- ${s.url}: ${s.claim}`), `confidence: ${a.confidence}`] },
  write: { effort: 'medium', rules: 'You write a long document from the brief below, for Claude to check and apply. Return its title and its full text (Markdown). Write plainly: the answer first, short sentences.' },
};

// `input` is the job's text: the proposal, the question (with the material's paths for a digest) or the brief.
async function simple(root, kind, input) {
  const job = SIMPLE[kind];
  const r = await ask(root, kind, `${job.rules}\n\n${input}\n`, { asked: {}, effort: job.effort || 'high', mode: job.mode || 'consult' });
  if (r.status !== 'OK') return failed(r);
  if (kind !== 'write') return { status: 'DONE', text: job.show(r.answer).join('\n') };
  const draft = path.join(state.projectDir(root), 'drafts', `${path.basename(r.bundle)}.md`);
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, `# ${r.answer.title}\n\n${r.answer.text}\n`);
  return { status: 'DONE', text: `draft saved, not applied: ${draft}\nRead it and apply what is right with Edit.` };
}

// ---- Screen control (DESIGN.md section 9): one operator at a time ----

const SCREEN_MS = 30 * 60000;

// Whether GPT holds the desktop: a computer run while its driver or any of its noted Codex processes may still run.
// A malformed record holds it too, as in the hook. Returns who holds it, or null.
function gptHolds(g) {
  const o = g.desktop;
  if (!o) return null;
  const pids = [o.pid, ...(Array.isArray(o.workers) ? o.workers : [null])];
  if (!pids.every(pid => Number.isInteger(pid) && pid > 0)) return 'a malformed desktop record';
  return pids.some(state.mayRun) ? `GPT's computer run for ${o.project || 'another project'}` : null;
}
const openWindow = g => (g.screen && typeof g.screen.until === 'number' && g.screen.until > Date.now() ? g.screen : null);

const COMPUTER_RULES = `You operate this computer's screen for Claude. Do the task below, then answer in the JSON shape asked.
Never trade, move money, enter credentials or passwords, accept terms or agreements, or send messages: stop at that point and report instead.
outcome: DONE, PARTIAL or FAILED. report: what you did and what you saw, with anything Claude must check.`;

// The project's git status, or why it couldn't be read.
function gitStatus(root) {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() || '(clean)' : `(git status failed: ${String(r.stderr || r.error || '').trim()})`;
}

// Adds a computer run's processes to this driver's desktop record (only real process ids: a launch that failed has
// none). Returns null, or why they couldn't be recorded, a thrown error included.
function recordWorkers(pids) {
  const real = pids.filter(pid => Number.isInteger(pid) && pid > 0);
  if (!real.length) return null;
  try {
    const saved = state.update(state.files.global(), g => {
      if (g.desktop && g.desktop.pid === process.pid) g.desktop.workers = [...new Set([...g.desktop.workers, ...real])];
    });
    return saved.ok ? null : saved.why;
  } catch (e) {
    return e.message;
  }
}

// One computer run by GPT: the desktop taken in one locked step, the verified lockdown, one Codex run (never retried).
// Every process the run starts is added to the desktop record, so a worker that outlives this driver keeps the
// desktop owned until it ends; a run that ends with nothing of it running removes the record.
async function computer(root, { task }) {
  if (!String(task || '').trim()) return refused('computer needs --task "..."');
  const taken = state.update(state.files.global(), g => {
    const who = gptHolds(g) || (openWindow(g) && `Claude's screen window (session ${g.screen.session})`);
    if (who) return `BUSY: ${who} holds the desktop; wait until it ends`;
    g.desktop = { pid: process.pid, workers: [], project: root, at: Date.now() };
    return null;
  });
  if (!taken.ok || taken.value) return refused(taken.why || taken.value);
  const mine = g => g.desktop && g.desktop.pid === process.pid;
  // (a process that can't be recorded mustn't run unrecorded: the driver stops, and its exit stops Codex's processes)
  const note = pids => {
    const why = recordWorkers(pids);
    if (!why) return;
    process.stdout.write(`REFUSED: GPT's processes couldn't be recorded as the desktop's owner (${why}), so the run was stopped\n`);
    process.exit(1);
  };
  const lockdown = codex.computerLockdown();
  if (lockdown.problem) {
    state.update(state.files.global(), g => { if (mine(g)) delete g.desktop; });
    return refused(`the computer lockdown couldn't be established, so GPT doesn't get the screen: ${lockdown.problem}`);
  }
  const before = gitStatus(root);
  const r = await codex.ask({ mode: 'computer', effort: 'high', lockdown: lockdown.args, schema: answer.SCHEMAS.computer, cwd: root,
    prompt: `${COMPUTER_RULES}\n\n## Task\n${task}\n`, onSpawn: child => note([child.pid]), onProcesses: note });
  const after = gitStatus(root);
  // (the run has stopped what it started: once none of it runs, the record goes, so no old process id lingers in it;
  // a worker still running keeps it, and so does a driver killed before this point)
  state.update(state.files.global(), g => { if (mine(g) && !g.desktop.workers.some(state.mayRun)) delete g.desktop; });
  const files = before === after ? `git status is as before the run (a file already changed before it may still have changed): ${after}`
    : `git status before the run:\n${before}\nafter it:\n${after}`;
  if (!r.ok) return { status: 'GPT_UNAVAILABLE', text: `GPT_UNAVAILABLE: ${r.reason} (a computer run is never retried)\n${files}` };
  const checked = answer.read('computer', r.text, {});
  if (checked.problems.length) return { status: 'NOT_DONE', text: `NOT_DONE: the answer doesn't fit its shape (${checked.problems.join('; ')})\n${files}` };
  return { status: checked.answer.outcome === 'DONE' ? 'DONE' : 'NOT_DONE', text: `${checked.answer.outcome}: ${checked.answer.report}\n${files}` };
}

// Opens Claude's own 30-minute screen window for this session, in one locked step: refused while GPT holds the desktop
// or another session's window is open.
function allowScreen({ session, why }) {
  if (!session) return refused('allow-screen needs a Claude Code session (CLAUDE_CODE_SESSION_ID)');
  if (!String(why || '').trim()) return refused('allow-screen needs its reason (--why "...")');
  const done = state.update(state.files.global(), g => {
    const gpt = gptHolds(g);
    if (gpt) return `${gpt} holds the desktop; wait until it ends`;
    const window = openWindow(g);
    if (window && window.session !== session) return `another Claude session's screen window is open until ${new Date(window.until).toLocaleTimeString()}`;
    g.screen = { session, until: Date.now() + SCREEN_MS, why: String(why).trim() };
    return null;
  });
  if (!done.ok || done.value) return refused(done.why || done.value);
  return { status: 'DONE', text: 'your own screen tools are allowed for this session for 30 minutes' };
}

module.exports = { testplan, skip, plan, simple, computer, allowScreen, recordWorkers };
