// muse-files.js: the read-only project-files tool crosscheck gives Muse (DESIGN.md section 7), a stdio MCP server
// (newline-delimited JSON-RPC: initialize, tools/list, tools/call). Muse starts it with the absolute path of a manifest
// crosscheck wrote into the review's bundle: { root, reviewed: { key: frozen copy }, plan, log }. Every path goes
// through the rule of every file Muse gets (review.located and unsendable); a reviewed file is read only as its frozen
// copy, and the plan under review never again. Every answer is logged whole before it is returned.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const review = require('./review');
const state = require('./state');

const ANSWER_MAX = 100000; // characters of one answer
const TOTAL_MAX = 2000000; // characters one manifest's answers may hold in all, counted from its log
const READ_MAX = 2 << 20; // bytes of a file read_file reads
const SEARCH_FILE_MAX = 1 << 20; // bytes of a file search reads
const SCAN_MAX = 20 << 20; // bytes one search reads in all
const LINE_MAX = 200; // characters of a matching line shown

const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root } = manifest;
const reviewed = new Map(Object.entries(manifest.reviewed || {}));
let plan = null;
try { plan = manifest.plan && fs.realpathSync.native(manifest.plan); } catch {}

const folder = prefix => state.pathKey(String(prefix || '').replace(/\\/g, '/').replace(/^(\.\/)+/, ''));

// The reviewed-file entry for `asked`, by the name asked or its real name (found even for a missing file), or
// undefined: a frozen copy's path, or null for a file the change deletes.
function reviewedEntry(asked) {
  const named = path.relative(root, path.resolve(root, asked)).replace(/\\/g, '/');
  const key = [named, review.realName(root, asked)].filter(Boolean).map(state.pathKey).find(k => reviewed.has(k));
  return key === undefined ? undefined : reviewed.get(key);
}

// The files Muse may name: git's list, each by the same rule as a read under both its names (a tracked path whose
// folder became a link to an ignored or outside one isn't offered), a reviewed file by its frozen copy (offered even
// once its live file is gone, never when the change deletes it).
function files() {
  const all = review.listedFiles(root);
  const keys = new Set(all.map(state.pathKey));
  return { all: all.filter(rel => {
    const entry = reviewedEntry(rel);
    if (entry !== undefined) return entry !== null;
    const at = review.located(root, rel);
    return !at.why && !review.unsendable(keys, at.rel, at.realRel);
  }), keys };
}

// The text Muse may read at `asked` ({ rel, text }), or { why }: a reviewed file's frozen copy, found by the name
// asked or its real name before anything live is read (a reviewed file deleted in the change, a null entry, stays
// deleted even if it is made again, and one deleted since keeps its frozen copy), else a project file the rule admits,
// within `maxBytes`.
function textAt(asked, keys, maxBytes) {
  const named = path.relative(root, path.resolve(root, asked)).replace(/\\/g, '/');
  const entry = reviewedEntry(asked);
  const at = review.located(root, asked);
  if (entry === null) return { why: 'deleted in the change under review' };
  if (entry !== undefined) return { rel: at.rel || named, text: review.textOf(fs.readFileSync(entry)) };
  if (at.why) return { why: at.why };
  if (at.real === plan) return { why: 'already in your prompt (the plan under review)' };
  const why = review.unsendable(keys, at.rel, at.realRel);
  if (why) return { why };
  if (fs.statSync(at.real).size > maxBytes) return { why: `larger than ${maxBytes} bytes` };
  return { rel: at.rel, text: review.textOf(fs.readFileSync(at.real)) };
}

const TOOLS = {
  list_files: {
    description: 'List the project files you may read (git\'s list, secrets files left out), under an optional folder prefix.',
    properties: { prefix: { type: 'string', description: 'A folder, such as src/ (optional)' } },
    run: ({ prefix }) => files().all.filter(rel => state.pathKey(rel).startsWith(folder(prefix))).join('\n') || 'No files.',
  },
  read_file: {
    description: 'Read one project file, or a range of its lines. A file under review comes back as its frozen copy.',
    properties: { path: { type: 'string', description: 'Project-relative path' }, start_line: { type: 'number' }, end_line: { type: 'number' } },
    required: ['path'],
    run: ({ path: asked, start_line: start, end_line: end }) => {
      const got = textAt(String(asked || ''), files().keys, READ_MAX);
      if (got.why) return `${asked}: ${got.why}`;
      const lines = got.text.split('\n');
      const from = Math.max(1, Math.floor(Number(start)) || 1);
      const to = Math.min(lines.length, Math.floor(Number(end)) || lines.length);
      return `${got.rel}, lines ${from}-${to} of ${lines.length}:\n${lines.slice(from - 1, to).join('\n')}`;
    },
  },
  search: {
    description: 'Find literal, case-sensitive text in the project files you may read, under an optional folder prefix.',
    properties: { text: { type: 'string' }, prefix: { type: 'string', description: 'A folder, such as src/ (optional)' } },
    required: ['text'],
    run: ({ text, prefix }) => {
      if (!text) return 'search needs text';
      const { all, keys } = files();
      const hits = [];
      const seen = new Set(); // (git lists a file again under a folder link to it: each real file is searched once)
      const skipped = []; // (files too large to search: a "no match" must say they weren't looked at)
      let scanned = 0;
      for (const rel of all.filter(r => state.pathKey(r).startsWith(folder(prefix)))) {
        const real = state.pathKey(review.realName(root, rel) || rel);
        if (seen.has(real)) continue;
        seen.add(real);
        const got = textAt(rel, keys, SEARCH_FILE_MAX);
        if (got.why && got.why.startsWith('larger than')) skipped.push(rel);
        if (got.why) continue;
        scanned += Buffer.byteLength(got.text);
        if (scanned > SCAN_MAX) return `${hits.join('\n') || 'No match so far.'}\n(stopped after ${SCAN_MAX} bytes: name a folder prefix)`;
        got.text.split('\n').forEach((line, i) => { if (line.includes(text)) hits.push(`${got.rel}:${i + 1}: ${line.trim().slice(0, LINE_MAX)}`); });
      }
      const unsearched = skipped.length ? `\n(not searched, over ${SEARCH_FILE_MAX} bytes: ${skipped.join(', ')}; read them in parts with read_file)` : '';
      return `${hits.join('\n') || 'No match.'}${unsearched}`;
    },
  },
};

// The answers this manifest's servers returned so far (a resumed Muse starts a new server; the log carries the count).
const returned = () => (fs.existsSync(manifest.log) ? fs.readFileSync(manifest.log, 'utf8').split('\n').filter(Boolean) : [])
  .reduce((n, line) => { try { return n + JSON.parse(line).answer.length; } catch { return n; } }, 0);

// One tool call's answer: cut to what this answer and the total may hold, logged whole before it goes back.
function answer(name, args) {
  const left = TOTAL_MAX - returned();
  let text;
  try {
    text = left <= 0 ? `the ${TOTAL_MAX}-character total of this review's file tool is used up` : TOOLS[name].run(args);
  } catch (e) {
    text = `${name} failed: ${e.message}`;
  }
  const max = Math.max(0, Math.min(ANSWER_MAX, left));
  if (text.length > max && left > 0) text = `${text.slice(0, max)}\n(cut at ${max} characters${name === 'read_file' ? ': read on with a later start_line' : ''})`;
  fs.appendFileSync(manifest.log, `${JSON.stringify({ at: Date.now(), tool: name, args, answer: text })}\n`);
  return text;
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const LIST = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description,
  inputSchema: { type: 'object', properties: t.properties, required: t.required || [] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));

readline.createInterface({ input: process.stdin }).on('line', line => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m || m.id === undefined || m.id === null) return; // (a notification needs no answer)
  const p = m.params || {};
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: p.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'project-files', version: '1' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: LIST } });
  else if (m.method === 'tools/call' && TOOLS[p.name]) send({ id: m.id, result: { content: [{ type: 'text', text: answer(p.name, p.arguments || {}) }] } });
  else if (m.method === 'ping') send({ id: m.id, result: {} });
  else send({ id: m.id, error: { code: -32601, message: `no ${m.method}${p.name ? ` ${p.name}` : ''}` } });
});
