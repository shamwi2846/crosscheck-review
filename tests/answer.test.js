// Tests for answer.js: an answer whose meaning is off is refused, so nothing unchecked counts as reviewed.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const answer = require('../src/answer');

const asked = { requirementIds: ['R1', 'R2'], files: ['src/a.js'], openIds: ['F1', 'F2'] };
const finding = { severity: 'HIGH', title: 'sum is wrong', location: 'src/a.js:3', trigger: 'add(1, 2)', harm: 'wrong total',
  failure: 'returns -1', fix: 'use +', test: 'add(1, 2) === 3', label: 'BUG', reqs: ['R1'] };
const good = () => ({
  verdict: 'ISSUES_REMAIN',
  followups: [{ id: 'F1', status: 'RESOLVED', reason: 'fixed at src/a.js:3' }, { id: 'F2', status: 'MAINTAIN', reason: 'still unchecked' }],
  findings: [finding],
  requirements: [{ id: 'R1', status: 'NOT_MET', evidence: 'src/a.js:3' }, { id: 'R2', status: 'MET', evidence: 'src/a.js:9' }],
  possibly_missing: [],
  class: { level: 'risky', files: ['src/a.js'], why: 'it moves money' },
  coverage: 'inputs checked; concurrency n/a',
});
const problemsOf = (a, kind = 'followup') => answer.read(kind, JSON.stringify(a), asked).problems;

test('answers with missing or duplicate requirement ids, an unknown follow-up id, or a clean verdict next to a maintained BUG are refused', () => {
  assert.deepStrictEqual(problemsOf(good()), []);
  const cases = [
    ['a missing requirement', a => { a.requirements.pop(); }, /requirement R2 appears 0 times/],
    ['a duplicate requirement', a => { a.requirements[1].id = 'R1'; }, /requirement R1 appears 2 times/],
    ['an unknown follow-up id', a => { a.followups[1].id = 'F9'; }, /finding F9 wasn't asked about/],
    ['a missing follow-up id', a => { a.followups.pop(); }, /finding F2 appears 0 times/],
    ['a clean verdict next to a maintained BUG', a => { a.verdict = 'RESOLVED'; a.findings = []; a.requirements[0].status = 'MET'; }, /verdict RESOLVED sits next to/],
    ['a risky class naming a file that was not reviewed', a => { a.class.files = ['src/other.js']; }, /names src\/other\.js, which wasn't reviewed/],
    ['a field outside the schema (a fallback answer)', a => { a.extra = 1; }, /answer\.extra isn't part of the answer/],
  ];
  for (const [name, change, expected] of cases) {
    const a = good();
    change(a);
    assert.match(problemsOf(a).join('\n'), expected, name);
  }
  assert.deepStrictEqual(answer.read('review', 'not json', asked).problems, ['the answer is not JSON']);
});
