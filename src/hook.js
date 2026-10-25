// hook.js: every Claude Code hook (DESIGN.md section 5). `node hook.js <event>` reads the hook's JSON from stdin
// and prints its answer. Every hook fails open (an error lets the tool run, and is written to hooks.log), except the
// screen gate, which fails closed: two operators on one desktop is the harm it prevents.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const state = require('./state');
const review = require('./review');
const gaps = require('./gaps');

const CLI = `node "${path.join(__dirname, 'crosscheck.js')}"`;
const KEEP_MS = 30 * 86400000; // review bundles and session lists older than this go
const SHOWN = 10; // files listed in a refusal or reminder

const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const listed = items => `${items.slice(0, SHOWN).join(', ')}${items.length > SHOWN ? ` and ${items.length - SHOWN} more` : ''}`;

let event = '-'; // (the hook running, for the log)
// Writes a problem to hooks.log (to stderr when even that fails), so a hook that fails open is never silent.
function log(problem) {
  try {
    fs.mkdirSync(state.HOME, { recursive: true });
    fs.appendFileSync(path.join(state.HOME, 'hooks.log'), `${new Date().toISOString()} ${event}: ${problem}\n`);
  } catch (e) {
    process.stderr.write(`crosscheck ${event}: ${problem} (and hooks.log can't be written: ${e.message})\n`);
  }
}

// The shared state; it throws when it can't be read, and each hook then fails its own way.
function globalState() {
  const g = state.read(state.files.global());
  if (g.unreadable) throw new Error(`${state.files.global()} can't be read (${g.unreadable})`);
  return g.data;
}

// The open BUG findings of a project's open chains, as listed in a refusal (a running follow-up doesn't hide them).
const openBugs = s => review.bugsIn(s).map(f => `${f.chain} ${f.id} (${f.location}: ${f.title})`);

// ---- Edits ----

// Why a trading file can't be edited yet, or null: it needs a test plan, or a skip, bound to the session's task.
function tradingGate(s, key, rel, task, taskFile) {
  if (!task) return `${rel} is a trading file: it needs a test plan or a skip first, and those belong to a task. Write this session's task file (${taskFile}, with a "## Requirements" section), then run ${CLI} testplan --files "${rel}" (or, when no test applies, ${CLI} skip --files "${rel}" --why "...").`;
  const forTask = r => !!r && r.task === task.id && r.reqHash === task.reqHash;
  if (forTask(s.plans[key])) return null;
  const rated = [].concat(s.needsPlan[key] || []).some(forTask) || !!s.escalations[key];
  if (rated) return `GPT rated ${rel} risky, so a skip no longer counts: it needs a test plan for the current task first: ${CLI} testplan --files "${rel}".`;
  if (forTask(s.skips[key])) return null;
  return `${rel} is a trading file: it needs a test plan for the current task first (${CLI} testplan --files "${rel}"), or, when no test applies, ${CLI} skip --files "${rel}" --why "...". A plan or skip made before the requirements changed no longer counts.`;
}

// Before an edit: the trading-file gate, then the file's baseline (its content before its first edit since the last
// review, saved before a Write destroys it) and this session's change record, in one transaction of the project state.
function edit(inp) {
  if (globalState().off) return null;
  const ti = inp.tool_input || {};
  const given = ti.file_path || ti.notebook_path;
  if (!given) return null;
  const abs = path.resolve(inp.cwd || '.', given);
  const repo = state.repoOf(abs);
  if (!repo) return null; // (outside git: not tracked; session start points that out)
  const root = repo.root;
  const rel = path.relative(repo.dir, abs).replace(/\\/g, '/');
  const key = state.pathKey(rel);
  const session = inp.session_id || null;
  const task = review.sessionTask(root, session);
  let refusal = null;
  let first = false;
  const done = state.update(state.files.project(root), data => {
    const s = review.withMaps(data);
    if (review.RISKY_FILE.test(key)) refusal = tradingGate(s, key, rel, task, state.files.task(root, session || '<session id>'));
    if (refusal) return;
    const record = s.changes[key];
    first = !record || record.session !== session;
    if (record) return void Object.assign(record, { session, at: Date.now() });
    // (the last reviewed version, so shell changes made since stay in the review; else the content as it is now)
    const acked = s.acks[key];
    const bytes = review.bytesOf(abs);
    const baseline = acked !== undefined && (acked === review.DELETED || fs.existsSync(review.snapFile(root, acked)))
      ? review.asBaseline(acked) : bytes === null ? null : review.snapshot(root, bytes);
    s.changes[key] = { path: rel, session, at: Date.now(), baseline };
  });
  if (!done.ok) throw new Error(done.why);
  if (refusal) return deny(refusal);
  if (session) noteProject(session, root);
  if (!first) return null;
  if (gaps.readFile(root).unreadable) log(`${gaps.NAME} of ${root} can't be read, so ${rel}'s open gaps weren't shown`);
  const open = gaps.openFor(root, rel);
  if (!open.length) return null;
  return context('PreToolUse', `Open known gaps in ${rel} (fix one only if this change makes it realistic; then: ${CLI} gap <id> --fixed):\n`
    + open.map(e => `- ${e.id} [${e.severity}] ${e.fields.Problem || '-'} (trigger: ${e.fields.Trigger || '-'})`).join('\n'));
}

// Adds a project to the session's list in the shared state (Stop reads it), only when it isn't there yet. A
// failure is logged and doesn't stop the edit.
function noteProject(session, root) {
  if ((((globalState().sessions || {})[session] || {}).roots || []).includes(root)) return;
  const done = state.update(state.files.global(), g => {
    g.sessions = Object.fromEntries(Object.entries(g.sessions || {}).filter(([, v]) => v.at > Date.now() - KEEP_MS));
    const roots = (g.sessions[session] || {}).roots || [];
    g.sessions[session] = { roots: roots.includes(root) ? roots : [...roots, root], at: Date.now() };
  });
  if (!done.ok) log(`${root} couldn't be added to session ${session}'s projects, so Stop may miss its findings: ${done.why}`);
}

// ---- Commits ----

// (one shell word: unquoted characters and quoted parts together, as in ~/"a folder"; one character at a time, since
// a repetition inside the repetition makes a long path take exponential time and the guard time out)
const PLACE = '((?:"[^"]*"|\'[^\']*\'|[^\\s;&|"\'])+)';
// git (git.exe, maybe at the end of a quoted path) with its own options before the subcommand: -C or -c and their
// value, a one-letter flag such as -p, or a long one such as --no-pager, --git-dir=x or --work-tree x (`git --no-pager
// commit` once wasn't seen as a commit at all). (Each option parses one way, or fails at once, so the time stays linear.)
const GIT = `\\bgit(?:\\.exe)?["']?((?:\\s+(?:-[Cc]\\s+${PLACE}|-(?![Cc]\\b)[A-Za-z](?![\\w-])|--[A-Za-z][\\w-]*(?:=\\S+|\\s+(?!-)${PLACE})?))*)\\s+`;
const COMMIT = new RegExp(`${GIT}commit\\b`);
// (anywhere in the command, a commit message's words included: every way of leaving a message out let staging escape,
// as in `cat <<'EOF' && git add ...`, PowerShell's `\$(git add ...)` or `-m "$(bash -cm 'git add -A')"`, while a match
// only adds untracked files to the check)
const STAGE = new RegExp(`${GIT}(?:add|stage)\\b`);
// A leading change of folder, ended by &&, ; or a new line: Bash's cd, or PowerShell's Set-Location by any of its
// names, in any letter case, with or without -Path or -LiteralPath. (Each shell's own: in Bash, Set-Location fails, and
// the commit after it runs where the shell already was.)
const LEADING_CD = {
  Bash: new RegExp(`^\\s*cd\\s+${PLACE}\\s*(?:&&|;|\\n)`),
  PowerShell: new RegExp(`^\\s*(?:cd|chdir|sl|set-location)(?:\\s+-(?:literal)?path)?\\s+${PLACE}\\s*(?:&&|;|\\n)`, 'i'),
};
const unquote = s => s.replace(/"([^"]*)"|'([^']*)'/g, '$1$2');
// On Windows, Git Bash spells C:\ as /c/.
const drivePath = p => {
  const drive = process.platform === 'win32' && p.match(/^\/([a-z])(?=\/|$)/i);
  return drive ? `${drive[1].toUpperCase()}:${p.slice(2) || '/'}` : p;
};
// A folder as a shell command names it (`cd` its target, or else a program's argument such as git -C): `~` is Git
// Bash's HOME, or for PowerShell the user's profile folder. PowerShell's cd reads a leading ~ even inside quotes, while
// Bash and a program's argument read only an unquoted one (a quoted "~" is then a folder named ~). (Read as a plain
// path, a Git Bash or home path named a folder that doesn't exist, so the guard found no project and let the commit
// through.)
function shellPath(place, tool, isCd) {
  const quotedHome = tool === 'PowerShell' && isCd;
  const word = quotedHome ? unquote(place) : place;
  if (!/^~(?=[\\/]|$)/.test(word)) return drivePath(unquote(place));
  const home = tool !== 'PowerShell' && process.env.HOME ? drivePath(process.env.HOME) : os.homedir();
  return path.join(home, quotedHome ? word.slice(1) : unquote(word.slice(1))); // (unquoted once: O'Brien's stays whole)
}

// Before a shell command: on `git commit` only, refuses while a changed file differs from its last reviewed version
// or a BUG is open. A backstop against slipping, so it reads no commit flags and compares no staged contents.
function bash(inp) {
  if (globalState().off) return null;
  const command = String((inp.tool_input || {}).command || '');
  const commit = command.match(COMMIT);
  if (!commit) return null;
  // (git status runs before the command, so what the command itself stages is still untracked: a new file made by a
  // shell once went into a commit unchecked; a command that stages has its untracked files checked too)
  const stages = STAGE.test(command);
  const cd = command.match(inp.tool_name === 'PowerShell' ? LEADING_CD.PowerShell : LEADING_CD.Bash);
  const start = path.resolve(inp.cwd || '.');
  let dir = cd ? path.resolve(start, shellPath(cd[1], inp.tool_name, true)) : start;
  // (a cd into a folder that doesn't exist fails, and a commit after `;` then runs where the shell already was)
  if (!fs.existsSync(dir)) dir = start;
  // (option by option, so a -C inside a quoted -c value is never taken for one)
  for (const [, flag, value] of commit[1].matchAll(new RegExp(`-([Cc])\\s+${PLACE}`, 'g'))) if (flag === 'C') dir = path.resolve(dir, shellPath(value, inp.tool_name, false));
  const root = state.projectRoot(dir);
  // (`git init` in the same command makes a repository whose first commit takes every file unchecked)
  if (!root && stages) return deny('Not committed: this command stages files and commits in a folder that isn\'t a git repository yet, so they can\'t be checked: run git init and git add on their own first, then commit.');
  if (!root) return null;
  const s = review.stateOf(root);
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', `--untracked-files=${stages ? 'all' : 'no'}`], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git status failed in ${root}: ${String(r.stderr).trim()}`);
  const files = new Map(Object.values(s.changes).map(c => [state.pathKey(c.path), c.path]));
  const entries = r.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    const renamed = /^[RC]/.test(entries[i]);
    files.set(state.pathKey(entries[i].slice(3)), entries[i].slice(3));
    if (renamed && entries[++i]) files.set(state.pathKey(entries[i]), entries[i]); // (its old path, now a deletion)
  }
  const unreviewed = [...files].filter(([k, rel]) => review.versionOf(root, rel) !== s.acks[k]).map(([, rel]) => rel);
  const bugs = openBugs(s);
  if (!unreviewed.length && !bugs.length) return null;
  return deny([
    unreviewed.length ? `Not committed: these files differ from their last reviewed version: ${listed(unreviewed)}. Review them first: ${CLI} review (add shell-made changes with --files "a,b").` : '',
    bugs.length ? `Not committed: open BUG findings: ${listed(bugs)}. Fix them and run the follow-up, or close the chain with a reason per BUG.` : '',
    'This check runs before the shell command, so a review, skip, close or gap command in it never ran: run that on its own first, then commit.',
  ].filter(Boolean).join('\n'));
}

// ---- Plans ----

// A plan's identity: its text with every run of whitespace made one space. The `plan` command records reviews and
// skips in the shared state (`plans`) under it plus the task's id (`planKey`), so each task keeps its own record.
const planHash = text => crypto.createHash('sha256').update(String(text).replace(/\s+/g, ' ').trim()).digest('hex');
const planKey = (text, task) => (task ? `${planHash(text)} ${task.id}` : planHash(text));

// Before leaving plan mode: the plan presented must have been reviewed, or skipped with a reason.
function plan(inp) {
  const g = globalState();
  if (g.off) return null;
  const ti = inp.tool_input || {};
  let text = typeof ti.plan === 'string' && ti.plan.trim() ? ti.plan : null;
  if (!text && ti.planFilePath) {
    const bytes = review.bytesOf(path.resolve(inp.cwd || '.', ti.planFilePath));
    text = bytes && review.textOf(bytes).trim() ? review.textOf(bytes) : null; // (decoded as the plan command decodes it)
  }
  if (!text) return { systemMessage: 'crosscheck: the hook got no plan text, so it could not check that the plan was reviewed.' };
  // (a review counts for the session's task as it is now: a changed request needs the plan reviewed again)
  const root = state.projectRoot(path.resolve(inp.cwd || '.'));
  const task = root ? review.sessionTask(root, inp.session_id) : null;
  const plans = g.plans || {};
  // (a session without a task takes any record of this text; one with a task, only its task's own and current one)
  if (!task && Object.keys(plans).some(k => k === planHash(text) || k.startsWith(`${planHash(text)} `))) return null;
  const rec = plans[planKey(text, task)];
  if (rec && (!task || rec.reqHash === task.reqHash)) return null;
  if (rec) return deny(`This plan's review or skip was for an earlier version of the task's requirements. Review it again: ${CLI} plan --file <plan.md> (or ${CLI} plan --skip --why "..." --file <plan.md>).`);
  return deny(`This plan has no review for this session's task. Save it to a file and run ${CLI} plan --file <plan.md> (add --risky for a risky feature) in the background, weigh GPT's points and revise the plan; for a plan too small to matter: ${CLI} plan --skip --why "..." --file <plan.md>. Then present the reviewed text.`);
}

// ---- The screen ----

const { mayRun } = state;

// Before a computer-use tool (fails closed). GPT owns the desktop while its driver or any of its workers runs
// (`desktop`: { pid, workers, project }, written by the computer command). Claude's own screen tools work only inside
// this session's window (`screen`: { session, until, why }, opened by allow-screen).
function screen(inp) {
  const g = globalState();
  const owner = g.desktop;
  if (owner) {
    const pids = [owner.pid, ...(Array.isArray(owner.workers) ? owner.workers : [null])];
    if (!pids.every(pid => Number.isInteger(pid) && pid > 0)) return deny(`The desktop record is malformed (${JSON.stringify(owner).slice(0, 200)}), so the screen tool is refused. Run ${CLI} doctor.`);
    if (pids.some(mayRun)) return deny(`GPT is operating the desktop (${owner.project || 'a computer run'}). Wait for that run to finish, then retry.`);
  }
  if (g.off) return null;
  const window = g.screen && typeof g.screen.until === 'number' && g.screen.until > Date.now() ? g.screen : null;
  if (window && window.session === inp.session_id) return null;
  if (window) return deny('Another Claude session holds the screen window. Wait until it ends, then retry.');
  return deny(`Screen control is delegated to GPT. First check whether files, logs, CLI tools or APIs can do it (MT5 logs and tester reports are files). If the screen is really needed: ${CLI} computer --task "<the goal, the app, what to report>" (in the background). Only when delegating is clearly worse: ${CLI} allow-screen --why "..." opens a 30-minute window for your own screen tools.`);
}

// ---- Stopping and starting ----

// When Claude stops: blocks while a BUG is open in one of this session's projects, at most once in a row, and
// reminds about this session's unreviewed changes without blocking.
function stop(inp) {
  const g = globalState();
  if (g.off) return null;
  const session = inp.session_id || null;
  const roots = new Map((((g.sessions || {})[session] || {}).roots || []).map(r => [state.projectDir(r), r]));
  const here = state.projectRoot(path.resolve(inp.cwd || '.'));
  if (here) roots.set(state.projectDir(here), here);
  const bugs = [];
  const pending = [];
  const problems = [];
  for (const root of roots.values()) {
    let s;
    try {
      s = review.stateOf(root);
    } catch (e) {
      problems.push(`${path.basename(root)}: ${e.message}`);
      continue;
    }
    bugs.push(...openBugs(s).map(b => `${path.basename(root)} ${b}`));
    pending.push(...Object.values(s.changes).filter(c => c.session === session).map(c => `${path.basename(root)}/${c.path}`));
  }
  if (problems.length) log(`state can't be read: ${problems.join('; ')}`);
  if (bugs.length && !inp.stop_hook_active) {
    return { decision: 'block', reason: `Open BUG findings: ${listed(bugs)}. Fix each one with a regression test that would catch it again (an existing or planned one that does counts; a BUG that only records an unmet requirement needs one only when money, data or security depends on it) and run the follow-up (${CLI} review --followup <chain> --file <response.md>), or close the chain with a reason per BUG (${CLI} close <chain> --note "...").` };
  }
  const notes = [];
  if (pending.length) notes.push(`crosscheck: unreviewed changes: ${listed(pending)}.`);
  if (problems.length) notes.push(`crosscheck: the state can't be read (${problems.join('; ')}), so findings and changes there are unknown.`);
  return notes.length ? { systemMessage: notes.join('\n') } : null;
}

// Whether an old bundle may go: not a round of an open chain, not reserved now (a fallback's bundle has no chain
// yet), and not a failed follow-up of an open chain (its manifest names the chain), which a fallback may still apply.
function disposable(bundle, name, s, kept) {
  if (kept.has(name) || fs.statSync(bundle).mtimeMs >= Date.now() - KEEP_MS) return false;
  let chain = null;
  try {
    chain = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8')).chain;
  } catch {}
  return !(chain && s.chains[chain] && !s.chains[chain].closed);
}

// Deletes review bundles older than 30 days that nothing open needs, under the project lock. Returns the state.
function cleanBundles(root) {
  const dir = path.join(state.projectDir(root), 'bundles');
  const done = state.update(state.files.project(root), data => {
    const s = review.withMaps(data);
    const kept = new Set([...Object.values(s.chains).filter(c => !c.closed).flatMap(c => c.rounds || []),
      ...Object.values(s.running).filter(r => state.alive(r.pid)).map(r => r.attempt)]); // (a crashed review's mark keeps nothing)
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const bundle = path.join(dir, name);
      if (disposable(bundle, name, s, kept)) fs.rmSync(bundle, { recursive: true, force: true });
    }
    return s;
  });
  if (!done.ok) throw new Error(done.why);
  return done.value;
}

// At session start: the on/off state, the project's lessons and one line of pending work.
function session(inp) {
  const g = globalState();
  const dir = path.resolve(inp.cwd || '.');
  const root = state.projectRoot(dir);
  if (g.off) return context('SessionStart', 'crosscheck is OFF (the user switched it off): its hooks check nothing, and GPT is consulted only when the user asks.');
  const lines = [];
  if (!root) lines.push(`crosscheck is on, but ${dir} is not a git repository, so changes made here are not tracked. Work in a project's repository (or run git init there).`);
  else {
    const lessons = gaps.readLessons(root);
    if (lessons.unreadable) log(`the lessons of ${root} can't be read: ${lessons.unreadable}`);
    if ((lessons.text || '').trim()) lines.push(`[Project lessons — confirmed past mistakes in this project; avoid repeating them]\n${lessons.text.trim()}`);
    let s = null;
    try {
      s = cleanBundles(root);
    } catch (e) {
      log(e.message);
      lines.push(`crosscheck: the state of ${path.basename(root)} can't be read (${e.message}), so its findings and changes are unknown.`);
    }
    if (s) lines.push(`crosscheck is on: ${Object.keys(s.changes).length} unreviewed change(s), ${Object.values(s.chains).filter(c => !c.closed).length} open review chain(s), ${openBugs(s).length} open BUG finding(s) in this project. Details: ${CLI} status.`);
  }
  return context('SessionStart', lines.join('\n'));
}

const EVENTS = { session, edit, bash, plan, screen, stop };

// A hook command that node runs a script with, its path ending in `name` (a pattern), quoted or not. The script must
// follow node directly: `node --check <path>` only checks a file, so such a hook is the user's own.
const runsScript = name => new RegExp(`^\\s*node(\\.exe)?\\s+(?:"([^"]*[\\\\/]${name})"|([^\\s"]*[\\\\/]${name}))(\\s|$)`, 'i');

// The hooks Claude Code runs for this file, as install.js registers them in settings.json and doctor checks them.
function registration(hookJs) {
  const hook = (event, timeout, extra = {}) => ({ type: 'command', command: `node "${hookJs.replace(/\\/g, '/')}" ${event}`, timeout, ...extra });
  return {
    SessionStart: [{ hooks: [hook('session', 30)] }],
    PreToolUse: [
      { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [hook('edit', 15)] },
      { matcher: 'Bash|PowerShell', hooks: [hook('bash', 30)] },
      { matcher: 'ExitPlanMode', hooks: [hook('plan', 15)] },
      { matcher: 'mcp__computer-use__.*|mcp__remote-devices__computer.*', hooks: [hook('screen', 15, { onFailure: 'block' })] },
    ],
    Stop: [{ hooks: [hook('stop', 30)] }],
  };
}

// Runs one hook on its raw input. An error lets the tool run (and is logged), except in the screen gate, which refuses.
function handle(name, raw) {
  event = name;
  try {
    if (!EVENTS[name]) throw new Error(`unknown hook event ${name}`);
    // (an input that once began with a byte-order mark failed to parse, and a failed edit or commit check lets it through)
    return EVENTS[name](typeof raw === 'string' ? JSON.parse(raw.replace(/^﻿/, '') || '{}') : raw);
  } catch (e) {
    log(e.stack || e);
    if (name === 'screen') return deny(`The desktop owner could not be checked (${e.message}), so the screen tool is refused. Retry; if it persists, run ${CLI} doctor.`);
    if (name === 'stop') return { systemMessage: `crosscheck couldn't check for open findings and unreviewed changes (${e.message}).` };
    return null;
  }
}

if (require.main === module) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {}
  const answer = handle(process.argv[2], raw);
  if (answer) process.stdout.write(JSON.stringify(answer));
}

module.exports = { handle, planHash, planKey, registration, runsScript };
