// A stand-in for the Muse Code program in tests: it records every call's arguments and answers from a spec file
// (FAKE_MUSE_SPEC, log FAKE_MUSE_LOG). Each session's record, as `export` gives it, is what the spec says for the call
// that made it (default: a clean run's), kept next to the log. It never imitates Muse's behavior beyond that.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_MUSE_SPEC, 'utf8'));
const log = process.env.FAKE_MUSE_LOG;
const sessions = `${log}.sessions`;
const event = (type, payload) => process.stdout.write(`${JSON.stringify({ payload_type: type, payload })}\n`);
const opt = name => args[args.indexOf(name) + 1];
const CLEAN = ['workspace_identity', 'capability_policy', 'security_mode', 'meta_context_note', 'session_identity'];

// A session's record as Muse exports it: one run with its toolset and context messages.
function record({ tools = [], context = [], skills = ['bundled:git'] } = {}) {
  const catalog = `<skill-catalog>\n${skills.map(id => `<skill id="${id}" scope="${id.split(':')[0]}" path="x">`).join('\n')}\n</skill-catalog>`;
  return { sessions: [{ config: { toolset: { source: 'settings', mode: 'named', active_tools: tools },
    run_context_messages: [...CLEAN, ...context].map(id => ({ id, text: '' })).concat([{ id: 'skills_catalog', text: catalog }]) } }] };
}

fs.appendFileSync(log, `${JSON.stringify({ args, prompt: args.includes('--prompt-file') ? fs.readFileSync(opt('--prompt-file'), 'utf8') : null })}\n`);
if (args[0] === '--version') {
  process.stdout.write(`Muse Code 9.9.9 (${spec.version || '9.9.9-test'})\n`);
} else if (args[0] === 'plugins') {
  process.stdout.write(JSON.stringify({ plugins: spec.plugins || [] }));
} else if (args[0] === 'export') {
  const file = path.join(sessions, `${opt('--session')}.json`);
  if (fs.existsSync(file)) fs.copyFileSync(file, opt('--out'));
} else if (args[0] === 'exec') {
  fs.mkdirSync(sessions, { recursive: true });
  const echo = opt('--provider') === 'echo';
  // (each real run takes the next answer in order; the echo run its own)
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    .filter(c => c.args[0] === 'exec' && c.args[c.args.indexOf('--provider') + 1] !== 'echo').length;
  const answer = echo ? (spec.echo || {}) : (spec.exec || [])[calls - 1] || { fail: 'no answer in the spec' };
  if (!answer.noRecord) fs.writeFileSync(path.join(sessions, `${opt('--session-id')}.json`), JSON.stringify(record(answer.record))); // (`noRecord`: a run that left none)
  if (answer.write) { // (a Muse that really writes the file its prompt names, whatever it then says)
    const target = fs.readFileSync(opt('--prompt-file'), 'utf8').match(/Create the file (.+?) containing/)[1];
    fs.writeFileSync(target, 'probe');
    fs.appendFileSync(log, `${JSON.stringify({ wrote: target })}\n`);
  }
  if (answer.blank) { // (blank output without end, each event split across two writes; `answer.child`: a child's id file)
    if (answer.child) fs.writeFileSync(answer.child, String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']).pid));
    const line = JSON.stringify({ payload_type: 'run.output.delta', payload: { text: ' \r\n' } });
    setInterval(() => { process.stdout.write(line.slice(0, 20)); setTimeout(() => process.stdout.write(`${line.slice(20)}\n`), 1); }, 3);
  } else if (answer.fail) {
    event('run.terminal.failed', { terminal: 'failed', text: '', reason: answer.fail });
    process.exitCode = 1;
  } else {
    const reply = () => {
      if (answer.text) event('run.output.delta', { text: answer.text });
      event('run.terminal.completed', { terminal: 'completed', text: answer.text || 'echo', reason: null });
    };
    if (!answer.hold) reply();
    else { // (`hold`: a folder where it marks `started` and waits for `go` before answering, so a test can act meanwhile)
      fs.writeFileSync(path.join(answer.hold, 'started'), '');
      const wait = setInterval(() => { if (fs.existsSync(path.join(answer.hold, 'go'))) { clearInterval(wait); reply(); } }, 20);
    }
  }
}
