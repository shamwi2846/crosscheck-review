// answer.js: the shape of GPT's answers, as JSON Schemas that Codex enforces (--output-schema), and the checks of
// their meaning that a schema can't express. Nothing GPT writes is parsed out of free text or rewritten.
'use strict';
const { pathKey } = require('./state');

const text = { type: 'string' };
const oneOf = (...values) => ({ type: 'string', enum: values });
const list = items => ({ type: 'array', items });
// (Codex's structured output wants every property required, nothing else allowed; "optional" is a null value)
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const FINDING = object({
  severity: oneOf('CRITICAL', 'HIGH', 'MEDIUM', 'LOW'),
  title: text,
  location: text,
  trigger: text,
  harm: text,
  failure: text,
  fix: text,
  test: { type: ['string', 'null'] }, // (required for CRITICAL and HIGH)
  label: oneOf('BUG', 'GAP'),
  reqs: list(text),
});
const SHARED = {
  findings: list(FINDING),
  requirements: list(object({ id: text, status: oneOf('MET', 'PARTIAL', 'NOT_MET', 'NOT_IN_THIS_CHANGE'), evidence: text })),
  possibly_missing: list(text),
  class: object({ level: oneOf('none', 'normal', 'risky'), files: list(text), why: text }),
  coverage: text,
};
const CASE = object({ id: text, severity: oneOf('CRITICAL', 'HIGH', 'MEDIUM'), covers: list(text), reqs: list(text), input: text, expected: text,
  test_file: text, test_name: text });
const NO_CASE = object({ target: text, why: text });
const SCHEMAS = {
  review: object({ verdict: oneOf('NO_ISSUES', 'ISSUES_FOUND'), ...SHARED }),
  followup: object({
    verdict: oneOf('RESOLVED', 'ISSUES_REMAIN'),
    followups: list(object({ id: text, status: oneOf('RESOLVED', 'MAINTAIN', 'CONCEDE'), reason: text })),
    ...SHARED,
  }),
  // a pair's cross-check: one mark for each of the other reviewer's findings (a CONFIRM with the checker's own harm
  // judgement in `label`)
  crosscheck: object({
    marks: list(object({ id: text, mark: oneOf('CONFIRM', 'DISPUTE', 'SAME_AS', 'UNCLEAR'), label: { type: ['string', 'null'], enum: ['BUG', 'GAP', null] },
      evidence: text, same_as: { type: ['string', 'null'] } })),
  }),
  // GPT's other jobs (modes.js)
  testplan: object({ cases: list(CASE), no_case: list(NO_CASE), not_worth_testing: text }),
  // Muse's check of GPT's test plan: each of GPT's cases kept, or dropped with why, and Muse's own added ones
  testplan_check: object({ keep: list(text), dropped: list(object({ id: text, why: text })), added: list(CASE), no_case: list(NO_CASE), not_worth_testing: text }),
  idea: object({ verdict: oneOf('SOUND', 'CHANGES_RECOMMENDED', 'AGAINST'), recommendation: text,
    points: list(object({ severity: oneOf('HIGH', 'MEDIUM', 'LOW'), point: text, why: text })) }),
  digest: object({ answer: text, evidence: list(object({ place: text, quote: text })),
    counts: object({ passed: { type: ['number', 'null'] }, failed: { type: ['number', 'null'] }, first_failure: { type: ['string', 'null'] } }),
    scope: text, confidence: oneOf('proven', 'hypothesis') }),
  research: object({ answer: text, sources: list(object({ url: text, claim: text })), confidence: oneOf('proven', 'hypothesis') }),
  write: object({ title: text, text: text }),
  computer: object({ outcome: oneOf('DONE', 'PARTIAL', 'FAILED'), report: text }),
  probe: object({ attempted: { type: 'boolean' }, error: text }), // (doctor --live's sandbox check)
};

// The first place where a value doesn't fit a schema built above, or null. Codex enforces the schema for its
// own answers; this also checks an answer that didn't come through Codex (the fallback reviewer's).
function mismatch(schema, value, where = 'answer') {
  const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const types = [].concat(schema.type);
  if (!types.includes(typeOf(value))) return `${where} must be ${types.join(' or ')}`;
  if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of ${schema.enum.join(', ')}`;
  if (schema.type === 'array') {
    for (const [i, item] of value.entries()) {
      const found = mismatch(schema.items, item, `${where}[${i}]`);
      if (found) return found;
    }
  }
  if (schema.type === 'object') {
    for (const key of Object.keys(value)) if (!schema.properties[key]) return `${where}.${key} isn't part of the answer`;
    for (const key of schema.required) {
      if (!(key in value)) return `${where}.${key} is missing`;
      const found = mismatch(schema.properties[key], value[key], `${where}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

// A reason that rests on the round limit, which never closes a finding (neither a follow-up's concession nor a close):
// the plain phrasings ("round limit", "round-limit", "the limit of three full rounds", "the limit was reached after three
// rounds": rounds counted by a number), line breaks included, never numerical rounding ("the broker limit is checked
// after the helper rounds the lot down"). It is a backstop for plain wording, not a reading of every phrasing
// (DESIGN.md section 14, fact 7).
const COUNTED_ROUNDS = '(?:\\d+|one|two|three|four|five|six)\\s+(?:\\w+\\s+)?rounds\\b';
const ROUND_LIMIT = new RegExp(`\\brounds?[-\\s]+limit|\\blimit\\s+(?:of|on)\\s+${COUNTED_ROUNDS}|\\blimit\\b[^.;]{0,30}\\bafter\\s+${COUNTED_ROUNDS}`, 'i');

// The reviewed file a finding's location names ("path", "path:12" or "path:12-30"), as a key; '-' is the task.
const locationKey = location => (location === '-' ? '-' : pathKey(location.replace(/:\d+(-\d+)?$/, '')));

// Reads an answer of `kind` ('review', 'followup' or 'crosscheck'). `asked` says what GPT was asked about: { rowIds
// (the requirements to rate), linkIds (every requirement a finding may name), files (the reviewed paths), openIds
// (follow-ups) }, or for a cross-check { otherIds, ownIds }. Returns { answer, problems }: every problem found, for
// GPT's one repair.
function read(kind, answerText, asked) {
  let answer;
  try {
    answer = JSON.parse(answerText);
  } catch {
    return { answer: null, problems: ['the answer is not JSON'] };
  }
  const shape = mismatch(SCHEMAS[kind], answer);
  if (shape) return { answer: null, problems: [shape] };
  const problems = [];
  const exactlyOnce = (ids, expected, what) => {
    for (const id of expected) {
      const count = ids.filter(x => x === id).length;
      if (count !== 1) problems.push(`${what} ${id} appears ${count} times; it must appear exactly once`);
    }
    for (const id of new Set(ids)) if (!expected.includes(id)) problems.push(`${what} ${id} wasn't asked about`);
  };
  if (kind === 'crosscheck') {
    exactlyOnce(answer.marks.map(m => m.id), asked.otherIds, 'finding');
    for (const m of answer.marks) {
      if (m.mark === 'SAME_AS' && !asked.ownIds.includes(m.same_as)) problems.push(`${m.id} is marked SAME_AS ${m.same_as}, which isn't one of your findings`);
      if (m.mark === 'DISPUTE' && !m.evidence.trim()) problems.push(`${m.id} is disputed without evidence: give the concrete reason it can't happen`);
      if (m.mark === 'CONFIRM' && !m.label) problems.push(`${m.id} is confirmed without your label: BUG if it can cause real harm, else GAP`);
      if (m.mark === 'UNCLEAR' && !m.evidence.trim()) problems.push(`${m.id} is marked UNCLEAR without saying what you couldn't check`);
    }
    return { answer, problems };
  }
  // A plan's cases and reasons for none. `asked.targets`: the target paths exactly as the prompt listed them; a test
  // file must be inside the project.
  const checkPlan = (cases, noCase) => {
    if (cases.length > 5) problems.push(`a plan has at most 5 cases, not ${cases.length}`);
    // (every target has a case, or one reason it needs none: a plan never counts for a file nobody judged)
    const covered = asked.targets.filter(t => cases.some(c => c.covers.includes(t)));
    for (const n of noCase) {
      if (!asked.targets.includes(n.target)) problems.push(`no_case names ${n.target}: name targets exactly as listed`);
      else if (covered.includes(n.target)) problems.push(`${n.target} has a case, so it takes no no_case reason`);
      if (!n.why.trim()) problems.push(`no_case for ${n.target} gives no reason`);
    }
    for (const t of asked.targets) {
      const reasons = noCase.filter(n => n.target === t).length;
      if (!covered.includes(t) && reasons !== 1) problems.push(`${t} needs a case, or one no_case reason, not ${reasons}`);
    }
    for (const c of cases) {
      if (!c.covers.length) problems.push(`${c.id} covers no target`);
      for (const p of c.covers) if (!asked.targets.includes(p)) problems.push(`${c.id} covers ${p}: covers must name targets exactly as listed`);
      if (!c.reqs.length) problems.push(`${c.id} serves no requirement`);
      for (const id of c.reqs) if (!asked.linkIds.includes(id)) problems.push(`${c.id} names requirement ${id}, which doesn't exist`);
      const file = c.test_file.trim().replace(/\\/g, '/');
      if (!file || !c.test_name.trim()) problems.push(`${c.id} names no test`);
      else if (/^([a-z]:|\/)/i.test(file) || file.split('/').includes('..')) problems.push(`${c.id}'s test file ${c.test_file} must be a path inside the project`);
    }
  };
  if (kind === 'testplan') {
    exactlyOnce(answer.cases.map(c => c.id), answer.cases.map((c, i) => `T${i + 1}`), 'case');
    checkPlan(answer.cases, answer.no_case);
    return { answer, problems };
  }
  if (kind === 'testplan_check') {
    // (`asked.cases`: GPT's cases. Each is kept or dropped, never lost, and dropped only to make room for an added one)
    const gptIds = asked.cases.map(c => c.id);
    exactlyOnce([...answer.keep, ...answer.dropped.map(d => d.id)], gptIds, 'GPT case');
    exactlyOnce(answer.added.map(c => c.id), answer.added.map((c, i) => `M${i + 1}`), 'added case');
    for (const d of answer.dropped) if (!d.why.trim()) problems.push(`dropping ${d.id} needs a reason`);
    const room = Math.max(0, gptIds.length + answer.added.length - 5);
    if (answer.dropped.length > room) problems.push(`drop a GPT case only to make room for an added one: at most ${room} may go, not ${answer.dropped.length}`);
    checkPlan([...asked.cases.filter(c => answer.keep.includes(c.id)), ...answer.added], answer.no_case);
    return { answer, problems };
  }
  if (kind !== 'review' && kind !== 'followup') return { answer, problems }; // (the other jobs: their schema is the check)
  exactlyOnce(answer.requirements.map(r => r.id), asked.rowIds, 'requirement');
  if (kind === 'followup') {
    exactlyOnce(answer.followups.map(f => f.id), asked.openIds, 'finding');
    for (const f of answer.followups) {
      if (f.status === 'CONCEDE' && ROUND_LIMIT.test(f.reason)) problems.push(`${f.id} is conceded because of the round limit, which is never a reason: concede only a finding that was never real`);
    }
  }
  const reviewed = asked.files.map(pathKey);
  for (const f of answer.findings) {
    for (const id of f.reqs) if (!asked.linkIds.includes(id)) problems.push(`finding "${f.title}" names requirement ${id}, which doesn't exist`);
    if ((f.severity === 'CRITICAL' || f.severity === 'HIGH') && !(f.test || '').trim()) problems.push(`finding "${f.title}" is ${f.severity} but has no test`);
    if (locationKey(f.location) !== '-' && !reviewed.includes(locationKey(f.location))) {
      problems.push(`finding "${f.title}" is located at ${f.location}: a location must be one of the reviewed paths (optionally with :line), or - for the task as a whole`);
    }
  }
  if (answer.class.level === 'risky' && !answer.class.files.length) problems.push('a risky class must name the files it applies to');
  for (const file of answer.class.files) if (!reviewed.includes(pathKey(file))) problems.push(`the class names ${file}, which wasn't reviewed`);
  const issues = answer.findings.length > 0
    || answer.requirements.some(r => r.status === 'NOT_MET' || r.status === 'PARTIAL')
    || (kind === 'followup' && answer.followups.some(f => f.status === 'MAINTAIN'));
  const clean = answer.verdict === 'NO_ISSUES' || answer.verdict === 'RESOLVED';
  if (clean && issues) problems.push(`the verdict ${answer.verdict} sits next to a finding, an unmet requirement or a maintained finding`);
  if (!clean && !issues) problems.push(`the verdict ${answer.verdict} comes with no finding, unmet requirement or maintained finding`);
  return { answer, problems };
}

// Muse's first review may ask for project files it wasn't shown, by path, once (DESIGN.md section 7): its shape adds
// `more_files`, which is taken out before the answer is read as a plain one of `kind`. Returns read's result and
// `more`, the paths asked for ([] when the answer has problems: those get their repair first).
const MORE_FILES = 20;
const withMoreFiles = schema => ({ ...schema, required: [...schema.required, 'more_files'], properties: { ...schema.properties, more_files: list(text) } });
function readAsking(kind, answerText, asked) {
  let parsed;
  try {
    parsed = JSON.parse(answerText);
  } catch {
    return { ...read(kind, answerText, asked), more: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...read(kind, answerText, asked), more: [] };
  const { more_files: more = [], ...rest } = parsed;
  const r = read(kind, JSON.stringify(rest), asked);
  if (!Array.isArray(more) || more.some(p => typeof p !== 'string')) r.problems.push('more_files must be a list of project-relative paths');
  else if (more.length > MORE_FILES) r.problems.push(`more_files asks for ${more.length} files; ask for at most ${MORE_FILES}`);
  return { ...r, more: r.problems.length ? [] : more };
}

// A short readable summary of a checked answer for Claude. Findings may carry their chain id (`id`).
function render(answer) {
  const lines = [`VERDICT: ${answer.verdict} · class ${answer.class.level}${answer.class.files.length ? ` (${answer.class.files.join(', ')})` : ''}: ${answer.class.why}`];
  for (const f of answer.followups || []) lines.push(`${f.id} ${f.status}: ${f.reason}`);
  for (const f of answer.findings) {
    lines.push(`[${f.severity}] ${f.label}${f.id ? ` ${f.id}` : ''}: ${f.title} (${f.location})`);
    lines.push(`  trigger: ${f.trigger}`, `  harm: ${f.harm}`, `  failure: ${f.failure}`, `  fix: ${f.fix}${f.test ? ` · test: ${f.test}` : ''}`);
    if (f.agreement) lines.push(`  pair: ${f.agreement}`); // (a paired review: who found it, and any dispute's evidence)
  }
  // (the requirements this change doesn't touch share a line: a long task's rows once pushed the findings out of view)
  const untouched = answer.requirements.filter(r => r.status === 'NOT_IN_THIS_CHANGE').map(r => r.id);
  for (const r of answer.requirements) if (r.status !== 'NOT_IN_THIS_CHANGE') lines.push(`${r.id} ${r.status.replace(/_/g, ' ')}: ${r.evidence}`);
  if (untouched.length) lines.push(`not in this change: ${untouched.join(', ')}`);
  for (const p of answer.possibly_missing) lines.push(`possibly missing: ${p}`);
  lines.push(`coverage: ${answer.coverage}`);
  return lines.join('\n');
}

module.exports = { SCHEMAS, ROUND_LIMIT, read, readAsking, withMoreFiles, render, locationKey };
