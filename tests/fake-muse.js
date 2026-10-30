// A stand-in for the Muse Code program in tests: it records every call's arguments and answers from a spec file
// (FAKE_MUSE_SPEC, log FAKE_MUSE_LOG). Each session's record, as `export` gives it, is what the spec says for the call
// that made it (default: a clean run's, with the tools of the servers its -c settings attach, as Muse lists them), kept
// next to the log. A run may also call the attached file server's tools (`calls`) or start the docs server
// (`startDocs`), as Muse does, logging what they answered. It never imitates Muse's behavior beyond that.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(process.env.FAKE_MUSE_SPEC, 'utf8'));
const log = process.env.FAKE_MUSE_LOG;
const sessions = `${log}.sessions`;
const event = (type, payload) => process.stdout.write(`${JSON.stringify({ payload_type: type, payload })}\n`);
const opt = name => args[args.indexOf(name) + 1];
const note = entry => fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
const CLEAN = ['workspace_identity', 'capability_policy', 'security_mode', 'meta_context_note', 'session_identity'];

// The servers the run's -c settings attach ({ name: config }), and the tools Muse would list for them: the file server's
// three, and the docs server's two when its program exists (it is optional, so one that can't start gives none).
const servers = Object.fromEntries(args.flatMap((a, i) => {
  const m = args[i - 1] === '-c' && /^mcpServers\.([\w-]+)=([\s\S]*)$/.exec(a);
  return m ? [[m[1], JSON.parse(m[2])]] : [];
}));
const attached = [...(servers['project-files'] ? ['list_files', 'read_file', 'search'].map(t => `mcp__project_files__${t}`) : []),
  ...(servers['mql5-docs'] && fs.existsSync(servers['mql5-docs'].command) ? ['mql5_find', 'mql5_read'].map(t => `mcp__mql5_docs__${t}`) : [])];

// A session's record as Muse exports it: one run with its toolset and context messages.
function record({ tools = attached, context = [], skills = ['bundled:git'] } = {}) {
  const catalog = `<skill-catalog>\n${skills.map(id => `<skill id="${id}" scope="${id.split(':')[0]}" path="x">`).join('\n')}\n</skill-catalog>`;
  return { sessions: [{ config: { toolset: { source: 'settings', mode: 'named', active_tools: tools },
    run_context_messages: [...CLEAN, ...context].map(id => ({ id, text: '' })).concat([{ id: 'skills_catalog', text: catalog }]) } }] };
}

// Starts an attached server as Muse would (each ${VAR} of its env taken from this process's environment) and sends it
// `requests` after initialize; returns the results by request, in order.
function talk(config, requests) {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(config.env || {}).map(([k, v]) => [k, String(v).replace(/^\$\{(\w+)\}$/, (_, name) => process.env[name] || '')])) };
  const lines = [{ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-muse' } } },
    ...requests.map((r, i) => ({ jsonrpc: '2.0', id: i + 1, ...r }))];
  const r = spawnSync(config.command, config.args || [], { input: `${lines.map(l => JSON.stringify(l)).join('\n')}\n`, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  const answers = String(r.stdout || '').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return requests.map((_, i) => (answers.find(a => a.id === i + 1) || {}).result || null);
}

note({ args, prompt: args.includes('--prompt-file') ? fs.readFileSync(opt('--prompt-file'), 'utf8') : null,
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CROSSCHECK_MQL5_DOCS_|NODE_OPTIONS$)/.test(k))) });
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
    .filter(c => c.args && c.args[0] === 'exec' && c.args[c.args.indexOf('--provider') + 1] !== 'echo').length;
  const answer = echo ? (spec.echo || {}) : (spec.exec || [])[calls - 1] || { fail: 'no answer in the spec' };
  if (!answer.noRecord) fs.writeFileSync(path.join(sessions, `${opt('--session-id')}.json`), JSON.stringify(record(answer.record))); // (`noRecord`: a run that left none)
  if (answer.write) { // (a Muse that really writes the file its prompt names, whatever it then says)
    const target = fs.readFileSync(opt('--prompt-file'), 'utf8').match(/Create the file (.+?) containing/)[1];
    fs.writeFileSync(target, 'probe');
    note({ wrote: target });
  }
  if (answer.blank) { // (blank output without end, each event split across two writes; `answer.child`: a child's id file)
    if (answer.child) fs.writeFileSync(answer.child, String(require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']).pid));
    const line = JSON.stringify({ payload_type: 'run.output.delta', payload: { text: ' \r\n' } });
    setInterval(() => { process.stdout.write(line.slice(0, 20)); setTimeout(() => process.stdout.write(`${line.slice(20)}\n`), 1); }, 3);
  } else if (answer.fail) {
    event('run.terminal.failed', { terminal: 'failed', text: '', reason: answer.fail });
    process.exitCode = 1;
  } else {
    const finish = () => {
      // (`calls`: [{ name, arguments }] to the attached file server; `startDocs`: list the docs server's tools)
      if (answer.calls) note({ fileCalls: talk(servers['project-files'], answer.calls.map(c => ({ method: 'tools/call', params: c }))).map(r => (r ? r.content[0].text : null)) });
      if (answer.startDocs) note({ docsTools: (talk(servers['mql5-docs'], [{ method: 'tools/list', params: {} }])[0] || { tools: [] }).tools.map(t => t.name) });
      if (answer.text) event('run.output.delta', { text: answer.text });
      event('run.terminal.completed', { terminal: 'completed', text: answer.text || 'echo', reason: null });
    };
    if (!answer.hold) finish();
    else { // (`hold`: a folder where it marks `started` and waits for `go` before going on, so a test can act meanwhile)
      fs.writeFileSync(path.join(answer.hold, 'started'), '');
      const wait = setInterval(() => { if (fs.existsSync(path.join(answer.hold, 'go'))) { clearInterval(wait); finish(); } }, 20);
    }
  }
}
