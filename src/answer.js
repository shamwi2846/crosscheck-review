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
const SCHEMAS = {
  review: object({ verdict: oneOf('NO_ISSUES', 'ISSUES_FOUND'), ...SHARED }),
  followup: object({
    verdict: oneOf('RESOLVED', 'ISSUES_REMAIN'),
    followups: list(object({ id: text, status: oneOf('RESOLVED', 'MAINTAIN', 'CONCEDE'), reason: text })),
    ...SHARED,
  }),
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

// The reviewed file a finding's location names ("path", "path:12" or "path:12-30"), as a key; '-' is the task.
const locationKey = location => (location === '-' ? '-' : pathKey(location.replace(/:\d+(-\d+)?$/, '')));

// Reads an answer of `kind` ('review' or 'followup'). `asked` says what GPT was asked about: { rowIds (the
// requirements to rate), linkIds (every requirement a finding may name), files (the reviewed paths), openIds
// (follow-ups) }. Returns { answer, problems }: every problem found, for GPT's one repair.
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
  exactlyOnce(answer.requirements.map(r => r.id), asked.rowIds, 'requirement');
  if (kind === 'followup') exactlyOnce(answer.followups.map(f => f.id), asked.openIds, 'finding');
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

// A short readable summary of a checked answer for Claude. Findings may carry their chain id (`id`).
function render(answer) {
  const lines = [`VERDICT: ${answer.verdict} · class ${answer.class.level}${answer.class.files.length ? ` (${answer.class.files.join(', ')})` : ''}: ${answer.class.why}`];
  for (const f of answer.followups || []) lines.push(`${f.id} ${f.status}: ${f.reason}`);
  for (const f of answer.findings) {
    lines.push(`[${f.severity}] ${f.label}${f.id ? ` ${f.id}` : ''}: ${f.title} (${f.location})`);
    lines.push(`  trigger: ${f.trigger}`, `  harm: ${f.harm}`, `  fix: ${f.fix}${f.test ? ` · test: ${f.test}` : ''}`);
  }
  for (const r of answer.requirements) lines.push(`${r.id} ${r.status.replace(/_/g, ' ')}: ${r.evidence}`);
  for (const p of answer.possibly_missing) lines.push(`possibly missing: ${p}`);
  lines.push(`coverage: ${answer.coverage}`);
  return lines.join('\n');
}

module.exports = { SCHEMAS, read, render, locationKey };
