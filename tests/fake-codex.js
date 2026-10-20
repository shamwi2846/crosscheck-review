// A stand-in for the Codex CLI in tests: it records every call's arguments and answers from a spec file.
// It never imitates Codex's behavior; each answer is pinned in the test (FAKE_CODEX_SPEC, FAKE_CODEX_LOG).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1000);
const event = e => process.stdout.write(`${JSON.stringify(e)}\n`); // (Codex's --json events, as seen live)
let session = '0123abcd-0000-4000-8000-00000000c0de';
const sessionStarted = () => event({ type: 'thread.started', thread_id: session });
const startRole = (role, roleArgs, options) => spawn(process.execPath, [__filename, '--role', role, ...roleArgs], options);

if (args[0] === '--role') {
  // Helper processes for the process-tree cases, not calls. `tree`: a process and its child that live forever,
  // writing [parent, own, child] ids. `native`: like the native Codex under its launcher, it starts a session,
  // starts a detached tree that keeps the output pipes open, answers, reports more after 2 s and exits after 6 s.
  const [, role, pidFile, stdio, outFile, text] = args;
  if (role === 'idle') forever();
  if (role === 'tree') {
    const child = startRole('idle', [], { stdio });
    fs.writeFileSync(pidFile, JSON.stringify([process.ppid, process.pid, child.pid]));
    forever();
  }
  if (role === 'native') {
    sessionStarted();
    startRole('tree', [pidFile, 'inherit'], { stdio: 'inherit', detached: true });
    fs.writeFileSync(outFile, text);
    setTimeout(() => event({ type: 'turn.started' }), 2000);
    setTimeout(() => process.exit(0), 6000);
  }
} else {
  const spec = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SPEC, 'utf8'));
  const log = process.env.FAKE_CODEX_LOG;
  const kind = args[0] === 'exec' ? 'exec' : `${args[0]} ${args[1]}`; // 'exec', 'plugin list', 'mcp list', 'features list'
  const earlier = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const index = earlier.filter(call => call.kind === kind).length;
  const answers = spec[kind] || [];
  let answer = answers[Math.min(index, answers.length - 1)] || {};
  const outFile = args[args.indexOf('-o') + 1];
  // `byPrompt`: [{ match, answers }] picks the answers of the first group whose `match` the prompt contains, in the
  // order of that group's calls, for calls whose order isn't fixed (a pair's two reviewers run at once)
  const pick = prompt => {
    const logged = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    let group = (spec.byPrompt || []).findIndex(g => prompt.includes(g.match));
    if (group < 0 && args[1] === 'resume') { // (a repair goes on with the group of the session it resumes)
      const last = logged.filter(c => c.session === args[args.length - 2]).pop();
      group = last ? last.group : -1;
    }
    if (group < 0 || group === null) return { group: null };
    const done = logged.filter(c => c.group === group).length;
    const list = spec.byPrompt[group].answers;
    return { group, answer: list[Math.min(done, list.length - 1)] };
  };

  if (kind !== 'exec') {
    fs.appendFileSync(log, JSON.stringify({ kind, args }) + '\n');
    process.stdout.write(answer.out || '');
    process.exit(answer.code || 0);
  }

  let prompt = '';
  process.stdin.on('data', d => { prompt += d; });
  process.stdin.on('end', () => {
    fs.appendFileSync(log, ''); // (creates it if needed, never empties it: a pair's two reviewers run at once)
    const picked = pick(prompt);
    if (picked.group !== null) answer = picked.answer;
    if (answer.session) session = answer.session;
    fs.appendFileSync(log, JSON.stringify({ kind, args, prompt, group: picked.group, session }) + '\n'); // (with the prompt it was sent)
    if (answer.touch) {
      // `touch`: a sandbox that let a write through creates this file in the run's folder (a resumed run is in the
      // folder of the session it resumes, as it has no -C of its own)
      const own = args.indexOf('-C');
      const first = earlier.find(c => c.session === args[args.length - 2] && c.args.includes('-C'));
      const dir = own >= 0 ? args[own + 1] : first && first.args[first.args.indexOf('-C') + 1];
      if (dir) fs.writeFileSync(path.join(dir, answer.touch), 'probe');
    }
    if (answer.hang) {
      // a tree that lives forever, under this launcher, which waits forever too
      startRole('tree', [answer.hang, 'ignore'], { stdio: 'ignore' });
      forever();
    } else if (answer.orphan) {
      // like Codex's launcher: it runs the native process and exits when that exits, leaving the tree behind
      const native = startRole('native', [answer.orphan, 'inherit', outFile, answer.text || 'answer'], { stdio: 'inherit' });
      native.on('exit', code => process.exit(code));
    } else if (answer.fail && answer.gpt) {
      // a failure during a session in which GPT already wrote `gpt` (and Codex logged `log` on stderr)
      sessionStarted();
      event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer.gpt } });
      if (answer.log) process.stderr.write(`${answer.log}\n`);
      event({ type: 'error', message: answer.fail });
      event({ type: 'turn.failed', error: { message: answer.fail } });
      process.exit(answer.code || 1);
    } else if (answer.fail) {
      // a failure before any session starts: plain text
      process.stderr.write(answer.fail);
      process.exit(answer.code || 1);
    } else {
      const reply = () => {
        fs.writeFileSync(outFile, answer.text || 'answer');
        sessionStarted();
        // `commands`: the shell commands GPT ran, reported as Codex 0.162.1 reports them (seen live)
        for (const [i, c] of (answer.commands || []).entries()) {
          event({ type: 'item.completed', item: { id: `item_c${i}`, type: 'command_execution', command: c.command, aggregated_output: c.output, exit_code: c.exit_code, status: c.exit_code ? 'failed' : 'completed' } });
        }
        event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer.text || 'answer' } });
        event({ type: 'turn.completed' });
      };
      if (!answer.hold) return reply();
      // `hold`: a folder where it marks `started` and waits for `go` before answering, so a test can act meanwhile
      sessionStarted();
      fs.writeFileSync(path.join(answer.hold, 'started'), '');
      const wait = setInterval(() => {
        if (fs.existsSync(path.join(answer.hold, 'go'))) { clearInterval(wait); reply(); }
      }, 20);
    }
  });
}
