// gaps.js: KNOWN_GAPS.md at each project's root (the findings left unfixed on purpose) and the project's lessons.
// The file keeps the format the old setup wrote, so its entries stay as they are:
//   ## G<n> · <status> · <date> · <SEVERITY>
//   - Task: ...  - Where: ...  - Problem: ...  - Trigger: ...  - Fix: ...  - Log: ...  - Why skipped: ...
// Entries are never deleted, only marked fixed; a change rewrites nothing but the header line it changes. Paths
// are stored relative to the project, and the home folder and e-mail addresses are removed.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const state = require('./state');

const NAME = 'KNOWN_GAPS.md';
const HEAD = '# Known gaps\n\nFindings left unfixed on purpose. Entries are never deleted, only marked fixed.\n';
const STATUSES = ['open', 'fixed', 'fixed — was a real bug'];
const HEADER = /^## (G\d+) · (open|fixed|fixed — was a real bug) · (\S+) · (\S+?)\r?$/;

const fileOf = root => path.join(root, NAME);
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One line of text with the project folder, the home folder and e-mail addresses taken out.
function clean(root, value) {
  let s = String(value === undefined || value === null ? '' : value).replace(/\s*[\r\n]+\s*/g, ' ').trim();
  for (const [folder, by] of [[path.resolve(root), '.'], [os.homedir(), '~']]) {
    if (!folder || folder === path.parse(folder).root) continue; // (a home or project at "/" or "C:\" would eat every path)
    for (const form of new Set([folder, folder.replace(/\\/g, '/')])) s = s.replace(new RegExp(escape(form), 'gi'), by);
  }
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<e-mail>') || '-';
}

// A place as the file shows it: relative to the project, with forward slashes and any ":line" end kept.
function place(root, where) {
  const [, file, line = ''] = String(where).replace(/^[`"']+|[`"']+$/g, '').match(/^(.*?)(:\d+(?:[-–]\d+)?)?$/);
  const abs = path.resolve(root, file);
  const relative = path.relative(root, abs);
  const inside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  return clean(root, (inside ? relative : abs).replace(/\\/g, '/') + line); // (outside it, clean() hides the home folder)
}

// A file's text ('' when there is none yet), or { unreadable }: a file that can't be read is never taken as empty.
function readText(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return e.code === 'ENOENT' ? { text: '' } : { unreadable: e.message };
  }
}

// The entries: [{ id, status, date, severity, fields: { Task, Where, ... } }].
function parse(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(HEADER);
    const field = line.match(/^- ([A-Za-z ]+): (.*)$/);
    if (header) entries.push({ id: header[1], status: header[2], date: header[3], severity: header[4], fields: {} });
    else if (field && entries.length) entries[entries.length - 1].fields[field[1]] = field[2];
  }
  return entries;
}

function list(root) {
  const current = readText(fileOf(root));
  return current.unreadable ? { ok: false, why: `${NAME} can't be read (${current.unreadable})` } : { ok: true, entries: parse(current.text) };
}

// The file's text, or { unreadable }, for a caller that holds the project lock and writes the file itself.
const readFile = root => readText(fileOf(root));

// `text` with findings left unfixed appended: [{ task, where: [places], problem, trigger, severity, fix, test,
// log, why }]. The same finding (log, problem and place) is recorded once. Returns { text, ids, added }: `ids`
// gives each item's entry (the existing one for a finding already recorded), `added` the new ones. Pure: the
// caller holds the project lock and writes the text.
function compose(root, text, items) {
  const have = parse(text);
  const keyOf = fields => `${fields.Log}|${fields.Problem}|${fields.Where}`;
  const known = new Map(have.map(e => [keyOf(e.fields), e.id]));
  let n = have.reduce((top, e) => Math.max(top, Number(e.id.slice(1))), 0);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const date = new Date().toISOString().slice(0, 10);
  const ids = [];
  const added = [];
  let more = '';
  for (const item of items) {
    const fields = {
      Task: clean(root, item.task),
      Where: (item.where || []).map(w => place(root, w)).join('; ') || '-',
      Problem: clean(root, item.problem),
      Trigger: clean(root, item.trigger),
      Fix: clean(root, item.fix) + (item.test ? ` — test: ${clean(root, item.test)}` : ''),
      Log: clean(root, path.basename(String(item.log || '-'))),
      'Why skipped': clean(root, item.why),
    };
    if (!known.has(keyOf(fields))) {
      const severity = clean(root, item.severity || 'UNKNOWN').toUpperCase().replace(/\W+/g, '_');
      known.set(keyOf(fields), `G${++n}`);
      added.push(`G${n}`);
      more += [``, `## G${n} · open · ${date} · ${severity}`, ...Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`), ``].join(eol);
    }
    ids.push(known.get(keyOf(fields)));
  }
  return { text: added.length ? (text || HEAD.replace(/\n/g, eol)) + more : text, ids, added };
}

// Adds findings left unfixed (see compose). Returns { ok, ids } (the new entries) or { ok: false, why }.
function add(root, items) {
  return state.withLock(state.files.project(root), write => {
    const current = readFile(root);
    if (current.unreadable) return { ok: false, why: `${NAME} can't be read (${current.unreadable}), so nothing was added` };
    const result = compose(root, current.text, items);
    if (!result.added.length) return { ok: true, ids: [] };
    if (!write(fileOf(root), result.text)) return { ok: false, why: `another process took over the lock, so nothing was added to ${NAME}` };
    return { ok: true, ids: result.added };
  });
}

// `text` with entry `id` given `status`, changing only its header line; null when there is no such entry. Pure.
function composeMark(text, id, status) {
  const header = new RegExp(`^## ${escape(id)} · (open|fixed|fixed — was a real bug) · (\\S+) · (\\S+?)(\\r?)$`, 'm');
  if (!header.test(text)) return null;
  return text.replace(header, (all, old, date, severity, cr) => `## ${id} · ${status} · ${date} · ${severity}${cr}`);
}

// Marks entry `id` 'fixed' or 'fixed — was a real bug'.
function mark(root, id, status) {
  if (!STATUSES.includes(status)) return { ok: false, why: `the status must be one of: ${STATUSES.join(', ')}` };
  return state.withLock(state.files.project(root), write => {
    const current = readText(fileOf(root));
    if (current.unreadable) return { ok: false, why: `${NAME} can't be read (${current.unreadable})` };
    const text = composeMark(current.text, id, status);
    if (text === null) return { ok: false, why: `${NAME} has no entry ${id}` };
    return write(fileOf(root), text) ? { ok: true } : { ok: false, why: `another process took over the lock, so ${id} wasn't changed` };
  });
}

// The open entries that name `file` in their Where line (for the hook: a plain read, [] when it can't read).
function openFor(root, file) {
  const me = place(root, file).replace(/:\d+(?:[-–]\d+)?$/, '').toLowerCase();
  const current = readText(fileOf(root));
  if (current.unreadable) return [];
  return parse(current.text).filter(e => e.status === 'open'
    && String(e.fields.Where || '').split(/;\s*/).some(w => w.replace(/:\d+(?:[-–]\d+)?$/, '').toLowerCase() === me));
}

// ---- Lessons: confirmed past mistakes, printed at session start and given to every review ----

const lessonsFile = root => path.join(state.projectDir(root), 'lessons.md');

// The lessons' text ('' when there are none or they can't be read: they are only shown).
const lessons = root => readText(lessonsFile(root)).text || '';

function addLesson(root, lesson) {
  return state.withLock(state.files.project(root), write => {
    const current = readText(lessonsFile(root));
    if (current.unreadable) return { ok: false, why: `the lessons can't be read (${current.unreadable}), so nothing was added` };
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${clean(root, lesson)}\n`;
    return write(lessonsFile(root), current.text + line) ? { ok: true } : { ok: false, why: 'another process took over the lock, so the lesson was not saved' };
  });
}

module.exports = { NAME, STATUSES, list, readFile, compose, composeMark, add, mark, openFor, lessons, addLesson };
