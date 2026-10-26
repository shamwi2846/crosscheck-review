// crosscheck.js: the command line (DESIGN.md section 4). It finds the project and the session's task, runs one
// command and prints its result. Exit codes: 0 done, 1 refused or not done, 2 wrong usage, 3 GPT unavailable (the
// fallback reviewer takes the bundle).
'use strict';
const fs = require('fs');
const path = require('path');
const state = require('./state');
const review = require('./review');
const gaps = require('./gaps');
const pair = require('./pair');
const modes = require('./modes');

const CLI = `node "${__filename}"`;
const USAGE = `Usage: crosscheck <command>
  review [--files a,b] [--risky] [--full] [--evidence-file out.log]
                                                   (--risky marks the named files, or all without --files: name only
                                                   risky code, since .mq5, .mqh and .set files are risky by themselves)
  review --followup <chain> --file response.md [--evidence-file out.log]
  review --fallback <bundle> --answer answer.json
  review --skip --why "..." [--files a,b]          (a task of comments, formatting or docs only)
  close <chain> --note "F1: gap: <why>; F2: gap: <why>"
  status
  gap [list] | gap <id> --fixed [--real-bug] | gap --add --where <file[:line]> --problem "..." --why "..." [--severity LOW]
  lesson --text "..."
  on | off                                         (only when the user asks)
  fast on | fast off                               (Codex's Fast tier for every GPT run: faster, higher usage)
  testplan --files a,b [--context c,d]             (at most 5 cases, or GPT's reason for none, stored as the files' plan for this task)
  skip --files a,b --why "..."                     (no test plan needed for these files in this task)
  plan --file plan.md [--risky] | plan --skip --why "..." --file plan.md
  idea --file draft.md | research --question "..." | write --brief brief.md
  digest --files a,b --question "..." | digest --dir <folder> --question "..."
  computer --task "..."                            (GPT operates the screen; never retried)
  allow-screen --why "..."                         (a 30-minute window for your own screen tools)
  doctor [--live]                                  (whether crosscheck can work here; --live also runs harmless GPT checks)
Outside a Claude Code session, add --task <task.md> and name the files.`;
const FLAGS = new Set(['risky', 'full', 'skip', 'fixed', 'real-bug', 'add', 'live']);

class Usage extends Error {}

// The arguments: words in order (`_`) and --name options; the flags above take no value.
function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i].match(/^--([a-z-]+)$/);
    if (!option && argv[i].startsWith('-')) throw new Usage(`${argv[i]}: write options as --name value`);
    if (option && option[1] in args) throw new Usage(`--${option[1]} is given twice: write a list as a,b`); // (the first would be lost)
    if (!option) args._.push(argv[i]);
    else if (FLAGS.has(option[1])) args[option[1]] = true;
    // (an option where its value should be means the value was left out, never that the option is the value)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) args[option[1]] = argv[++i];
    else throw new Usage(`--${option[1]} needs a value`);
  }
  return args;
}
const listOf = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

// The project (the git repository around the current folder), the session and its task file. `at` resolves a path
// option from the project's root, as every path is (DESIGN.md section 14, fact 20).
function where(args) {
  const root = state.projectRoot(process.cwd());
  if (!root) throw new Usage(`${process.cwd()} isn't inside a git repository: run crosscheck from the project's folder`);
  const at = p => (p ? path.resolve(root, p) : null);
  const session = process.env.CLAUDE_CODE_SESSION_ID || null;
  const taskFile = args.task ? at(args.task) : session ? state.files.task(root, session) : null;
  return { root, session, taskFile, at };
}

// A review result as an exit code and text. When GPT was unavailable (a pair included), the text starts with
// GPT_UNAVAILABLE and hands the frozen bundle to the fallback reviewer.
// (`handoff`: only a review has a fallback reviewer; another job GPT can't do just says so)
function reported(result, handoff = true) {
  if (result.status === 'DONE') return { code: 0, text: result.text };
  if (!handoff && (result.unavailable || result.status === 'GPT_UNAVAILABLE')) return { code: 3, text: `GPT_UNAVAILABLE: ${result.text.replace(/^GPT_UNAVAILABLE: /, '')}` };
  if (!(result.unavailable || result.status === 'GPT_UNAVAILABLE') || !result.bundle) {
    const again = result.status === 'PAIR_INCOMPLETE' ? '\nNothing was recorded: run the review again.' : '';
    return { code: 1, text: `${result.text}${again}` };
  }
  let risky = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(result.bundle, 'manifest.json'), 'utf8'));
    risky = manifest.riskyKeys.map(k => manifest.files[k].path);
  } catch {}
  return { code: 3, text: [`GPT_UNAVAILABLE: ${result.text.replace(/^(REFUSED|GPT_UNAVAILABLE): /, '')}`, 'FALLBACK HANDOFF: run the fallback-reviewer agent on this bundle.',
    `- bundle: ${result.bundle} (prompt.md holds the task, the frozen code, the test plans and the answer's rules; answer in the same JSON as GPT)`,
    risky.length ? `- risky files: ${risky.join(', ')}; attack them with this checklist:\n${pair.ROLES.B}` : '- no risky files',
    `- then record its answer: ${CLI} review --fallback "${result.bundle}" --answer "<answer.json>"`].join('\n') };
}

async function reviewCommand(args) {
  // (one mode at a time: a skip bypasses GPT, so it never rides along with another mode)
  const modes = ['followup', 'fallback', 'skip'].filter(m => args[m]);
  if (modes.length > 1) throw new Usage(`review takes one of --followup, --fallback and --skip, not ${modes.join(' and ')}`);
  const taken = { followup: ['followup', 'file', 'evidence-file'], fallback: ['fallback', 'answer'], skip: ['skip', 'why', 'files'] }[modes[0]]
    || ['files', 'risky', 'full', 'evidence-file'];
  const other = Object.keys(args).filter(k => k !== '_' && k !== 'task' && !taken.includes(k));
  if (other.length) throw new Usage(`review${modes[0] ? ` --${modes[0]}` : ''} doesn't take ${other.map(k => `--${k}`).join(', ')}`);
  if (args.followup && !args.file) throw new Usage('review --followup needs --file <response.md>');
  if (args.fallback && !args.answer) throw new Usage('review --fallback needs --answer <answer.json>');
  const { root, session, taskFile, at } = where(args);
  const evidenceFile = at(args['evidence-file']);
  if (args.fallback) return reported(review.fallback(root, { bundle: at(args.fallback), answerFile: at(args.answer) }));
  if (args.followup) return reported(await review.followup(root, { chain: args.followup, responseFile: at(args.file), evidenceFile }));
  if (args.skip) return reported(review.skip(root, { session, files: listOf(args.files), why: args.why }));
  if (taskFile && !fs.existsSync(taskFile)) {
    return { code: 1, text: `REFUSED: the task file ${taskFile} doesn't exist yet: write it ("# <title>", then "## Requirements" with R1., R2. ..., then "## Notes") and run the review again.` };
  }
  return reported(await review.review(root, { session, files: listOf(args.files), taskFile, risky: !!args.risky, full: !!args.full, evidenceFile }));
}

// Closes a chain with one reason per open BUG: --note "F1: gap: <why>; F2: gap: <why>".
function closeCommand(args) {
  const id = args._[1];
  if (!id) throw new Usage('close needs a chain id');
  const { root } = where(args);
  const notes = {};
  for (const part of String(args.note || '').split(/;\s*(?=F\d+\s*:)/)) {
    const note = part.match(/^\s*(F\d+)\s*:\s*([\s\S]*)$/);
    if (note) notes[note[1]] = note[2].trim();
  }
  const chain = review.stateOf(root).chains[id];
  const result = review.close(root, { chain: id, notes, rev: chain ? chain.rev : null });
  return { code: result.status === 'DONE' ? 0 : 1, text: result.text };
}

// Pending changes, open chains with their open findings, running reviews and anything wrong, in a few lines.
function statusCommand(args) {
  const { root, session, taskFile } = where(args);
  const g = state.read(state.files.global());
  const shared = g.data || {};
  const lines = [`project: ${root}`, `crosscheck: ${g.unreadable ? `the shared state can't be read (${g.unreadable})` : shared.off ? 'OFF' : 'on'}`];
  if (shared.fast) lines.push('GPT speed: Fast (higher usage)');
  if (shared.cooldownUntil > Date.now()) lines.push(`GPT is cooling down until ${new Date(shared.cooldownUntil).toLocaleTimeString()}: ${shared.cooldownReason}`);
  lines.push(`session: ${session || 'none (outside Claude Code: use --task and name the files)'}`);
  lines.push(`task file: ${taskFile ? `${taskFile}${fs.existsSync(taskFile) ? '' : ' (not written yet)'}` : 'none'}`);
  const s = review.stateOf(root);
  const changes = Object.values(s.changes);
  const mine = session ? changes.filter(c => c.session === session).map(c => c.path) : [];
  lines.push(`unreviewed changes of this session: ${mine.join(', ') || 'none'}${changes.length > mine.length ? `; of other sessions: ${changes.length - mine.length}` : ''}`);
  // (the commit guard's own check, so a commit is never refused right after status said nothing blocks it)
  const blockers = review.unreviewedForCommit(root, s);
  const bugs = review.bugsIn(s).length;
  const why = [blockers.length ? `not reviewed: ${blockers.join(', ')}` : '', bugs ? `${bugs} open BUG(s)` : ''].filter(Boolean).join('; ');
  lines.push(`a commit now: ${shared.off ? 'not checked (crosscheck is OFF)' : why ? `would be refused (${why})` : 'would pass'}`);
  for (const [id, c] of Object.entries(s.chains).filter(([, chain]) => !chain.closed)) {
    const open = Object.entries(c.findings).filter(([, f]) => f.status === 'open');
    lines.push(`chain ${id} (revision ${c.rev}, ${c.rounds.length} round(s)${c.paired ? ', paired' : ''}): ${open.length} open finding(s)`);
    for (const [fid, f] of open) lines.push(`  ${fid} [${f.severity} ${f.label}] ${f.title} (${f.location})`);
  }
  const running = [...new Set(Object.values(s.running).filter(r => state.alive(r.pid)).map(r => r.attempt))];
  if (running.length) lines.push(`running reviews: ${running.join(', ')}`);
  const log = path.join(state.HOME, 'hooks.log');
  const recent = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => Date.parse(l.slice(0, 24)) > Date.now() - 86400000) : [];
  if (recent.length) lines.push(`hook problems in the last day: ${recent.length} (see ${log}); the last: ${recent[recent.length - 1].slice(0, 300)}`);
  return { code: 0, text: lines.join('\n') };
}

const done = (result, text) => ({ code: result.ok ? 0 : 1, text: result.ok ? text : `REFUSED: ${result.why}` });

function gapCommand(args) {
  const { root } = where(args);
  const id = args._[1] && args._[1] !== 'list' ? args._[1] : null;
  if (id) {
    if (!args.fixed) throw new Usage('gap <id> needs --fixed (with --real-bug when it was a real bug)');
    return done(gaps.mark(root, id, args['real-bug'] ? 'fixed — was a real bug' : 'fixed', review.acknowledgeGaps(root)), `${id} marked fixed`);
  }
  if (args.add) {
    if (!args.where || !args.problem || !args.why) throw new Usage('gap --add needs --where, --problem and --why');
    const added = gaps.add(root, [{ task: args.task || '-', where: listOf(args.where), problem: args.problem, trigger: args.trigger || '-',
      severity: args.severity || 'LOW', fix: args.fix || '-', test: null, log: args.log || 'recorded by hand', why: args.why }], review.acknowledgeGaps(root));
    return done(added, `recorded: ${(added.ids || []).join(', ') || 'it was already recorded'}`);
  }
  const known = gaps.list(root);
  if (!known.ok) return { code: 1, text: `REFUSED: ${known.why}` };
  const open = known.entries.filter(e => e.status === 'open');
  return { code: 0, text: open.map(e => `${e.id} [${e.severity}] ${e.fields.Where}: ${e.fields.Problem}`).join('\n') || 'no open gaps' };
}

function lessonCommand(args) {
  if (!String(args.text || '').trim()) throw new Usage('lesson needs --text "..."');
  return done(gaps.addLesson(where(args).root, args.text), 'lesson saved');
}

// (off also closes any screen window, so switching back on never revives one)
function switchCommand(args) {
  const off = args._[0] === 'off';
  return done(state.update(state.files.global(), g => { g.off = off; if (off) delete g.screen; }),
    off ? 'crosscheck is OFF: the hooks check nothing until `crosscheck on`' : 'crosscheck is on');
}

// Codex's Fast tier for every GPT run crosscheck starts: faster, at a higher usage cost.
function fastCommand(args) {
  if (args._.length !== 2 || !['on', 'off'].includes(args._[1])) throw new Usage('fast takes on or off');
  const fast = args._[1] === 'on';
  return done(state.update(state.files.global(), g => { g.fast = fast; }),
    fast ? 'GPT speed: Fast (higher usage), until `crosscheck fast off`' : 'GPT speed: normal');
}

async function computerCommand(args) {
  return reported(await modes.computer(where(args).root, { task: args.task }), false);
}
const allowScreenCommand = args => reported(modes.allowScreen({ session: process.env.CLAUDE_CODE_SESSION_ID || null, why: args.why }), false);

async function doctorCommand(args) {
  const r = await require('./doctor').doctor({ live: !!args.live });
  return { code: r.ok ? 0 : 1, text: r.text };
}

// ---- GPT's other jobs (modes.js) ----

async function testplanCommand(args) {
  if (!listOf(args.files).length) throw new Usage('testplan needs --files a,b');
  const { root, taskFile } = where(args);
  return reported(await modes.testplan(root, { taskFile, files: listOf(args.files), context: listOf(args.context) }), false);
}

function skipCommand(args) {
  if (!listOf(args.files).length) throw new Usage('skip needs --files a,b');
  const { root, taskFile } = where(args);
  return reported(modes.skip(root, { taskFile, files: listOf(args.files), why: args.why }), false);
}

async function planCommand(args) {
  if (!args.file) throw new Usage('plan needs --file <plan.md>');
  if (args.skip ? args.risky : args.why) throw new Usage('plan takes --risky for a review, or --skip with --why, not both');
  const { root, taskFile, at } = where(args);
  // (a review without requirements only when no task was named and the session hasn't written one)
  const task = args.task || (taskFile && fs.existsSync(taskFile)) ? taskFile : null;
  if (task && !review.taskInfo(task)) return { code: 1, text: `REFUSED: the task file ${task} doesn't exist or has no "## Requirements" section` };
  return reported(await modes.plan(root, { file: at(args.file), taskFile: task, risky: !!args.risky, skipWhy: args.skip ? args.why || '' : undefined }), false);
}

// idea, digest, research and write: the job's input text, read from the files named.
async function simpleCommand(args) {
  const kind = args._[0];
  const { root, at } = where(args);
  const fileOption = { idea: 'file', write: 'brief' }[kind];
  let input;
  if (fileOption) {
    if (!args[fileOption]) throw new Usage(`${kind} needs --${fileOption} <file>`);
    const bytes = review.bytesOf(at(args[fileOption]));
    if (bytes === null) return { code: 1, text: `REFUSED: ${args[fileOption]} doesn't exist` };
    input = `## ${kind === 'idea' ? 'Proposal' : 'Brief'}\n${review.textOf(bytes)}`;
  } else {
    if (!String(args.question || '').trim()) throw new Usage(`${kind} needs --question "..."`);
    input = `## Question\n${args.question}`;
    if (kind === 'digest') {
      if (!args.files === !args.dir) throw new Usage('digest takes --files a,b or --dir <folder>: one of them');
      const material = args.dir ? [at(args.dir)] : listOf(args.files).map(at);
      const missing = material.filter(p => !fs.existsSync(p));
      if (missing.length) return { code: 1, text: `REFUSED: these don't exist: ${missing.join(', ')}` };
      input += `\n\n## Material (read it yourself)\n${material.map(p => `- ${p}`).join('\n')}`;
    }
  }
  return reported(await modes.simple(root, kind, input), false);
}

const COMMANDS = { review: reviewCommand, close: closeCommand, status: statusCommand, gap: gapCommand, lesson: lessonCommand, on: switchCommand, off: switchCommand, fast: fastCommand,
  testplan: testplanCommand, skip: skipCommand, plan: planCommand, idea: simpleCommand, digest: simpleCommand, research: simpleCommand, write: simpleCommand,
  computer: computerCommand, 'allow-screen': allowScreenCommand, doctor: doctorCommand };
// The options each command takes; any other is wrong usage, so a typo never silently changes what runs.
const OPTIONS = {
  review: ['files', 'risky', 'full', 'evidence-file', 'followup', 'file', 'fallback', 'answer', 'skip', 'why', 'task'],
  close: ['note', 'task'], status: ['task'], lesson: ['text', 'task'], on: [], off: [], fast: [],
  gap: ['fixed', 'real-bug', 'add', 'where', 'problem', 'why', 'severity', 'trigger', 'fix', 'log', 'task'],
  testplan: ['files', 'context', 'task'], skip: ['files', 'why', 'task'], plan: ['file', 'risky', 'skip', 'why', 'task'],
  idea: ['file'], digest: ['files', 'dir', 'question'], research: ['question'], write: ['brief'], computer: ['task'], 'allow-screen': ['why'], doctor: ['live'],
};
// The plain words a command takes after its name; any other is wrong usage too (`skip --files a b` once skipped
// only a).
const WORDS = { close: 1, gap: 1, fast: 1 };

// Runs one command line. Returns { code, text }; it never throws.
async function main(argv) {
  try {
    const args = parse(argv);
    const command = COMMANDS[args._[0]];
    if (!command) throw new Usage(args._[0] ? `unknown command ${args._[0]}` : 'no command given');
    const unknown = Object.keys(args).filter(k => k !== '_' && !OPTIONS[args._[0]].includes(k));
    if (unknown.length) throw new Usage(`${args._[0]} doesn't take ${unknown.map(k => `--${k}`).join(', ')}`);
    const extra = args._.slice(1 + (WORDS[args._[0]] || 0));
    if (extra.length) throw new Usage(`${args._[0]} doesn't take ${extra.join(' ')} (write a list as a,b)`);
    return await command(args);
  } catch (e) {
    if (e instanceof Usage) return { code: 2, text: `${e.message}\n\n${USAGE}` };
    return { code: 1, text: `crosscheck failed: ${e.message}` };
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(({ code, text }) => {
    process.stdout.write(`${text}\n`);
    process.exitCode = code;
  });
}

module.exports = { main };
