// A stand-in for the Codex CLI in tests: it records every call's arguments and answers from a spec file.
// It never imitates Codex's behavior; each answer is pinned in the test (FAKE_CODEX_SPEC, FAKE_CODEX_LOG).
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const forever = () => setInterval(() => {}, 1000);
const event = e => process.stdout.write(`${JSON.stringify(e)}\n`); // (Codex's --json events, as seen live)
const sessionStarted = () => event({ type: 'thread.started', thread_id: '0123abcd-0000-4000-8000-00000000c0de' });
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
  fs.appendFileSync(log, JSON.stringify({ kind, args }) + '\n');
  const answers = spec[kind] || [];
  const answer = answers[Math.min(index, answers.length - 1)] || {};
  const outFile = args[args.indexOf('-o') + 1];

  if (kind !== 'exec') {
    process.stdout.write(answer.out || '');
    process.exit(answer.code || 0);
  }

  let prompt = '';
  process.stdin.on('data', d => { prompt += d; });
  process.stdin.on('end', () => {
    if (answer.hang) {
      // a tree that lives forever, under this launcher, which waits forever too
      startRole('tree', [answer.hang, 'ignore'], { stdio: 'ignore' });
      forever();
    } else if (answer.orphan) {
      // like Codex's launcher: it runs the native process and exits when that exits, leaving the tree behind
      const native = startRole('native', [answer.orphan, 'inherit', outFile, answer.text || 'answer'], { stdio: 'inherit' });
      native.on('exit', code => process.exit(code));
    } else if (answer.fail && answer.gpt) {
      // a failure during a session in which GPT already wrote `gpt`
      sessionStarted();
      event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer.gpt } });
      event({ type: 'error', message: answer.fail });
      event({ type: 'turn.failed', error: { message: answer.fail } });
      process.exit(answer.code || 1);
    } else if (answer.fail) {
      // a failure before any session starts: plain text
      process.stderr.write(answer.fail);
      process.exit(answer.code || 1);
    } else {
      fs.writeFileSync(outFile, answer.text || 'answer');
      sessionStarted();
      event({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer.text || 'answer' } });
      event({ type: 'turn.completed' });
    }
  });
}
