// Tests for answer.js: an answer whose meaning is off is refused, so nothing unchecked counts as reviewed.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const answer = require('../src/answer');

const asked = { rowIds: ['R1', 'R2'], linkIds: ['R1', 'R2'], files: ['src/a.js'], openIds: ['F1', 'F2'] };
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
  for (const reason of ['Math.round is not called on this path; the broker limit is checked at orders.js:40', // (evidence that merely uses both words is fine)
    'We round the volume down to the broker limit before submitting the order, so it cannot exceed the maximum.',
    'The broker limit is checked after we round the lot down, so the submitted volume cannot exceed the maximum.',
    'The broker limit is checked after the helper rounds the lot down, so the submitted volume cannot exceed the maximum.']) {
    const evidence = good();
    evidence.followups[1] = { id: 'F2', status: 'CONCEDE', reason };
    assert.deepStrictEqual(problemsOf(evidence), [], reason);
  }
  const cases = [
    ['a missing requirement', a => { a.requirements.pop(); }, /requirement R2 appears 0 times/],
    ['a duplicate requirement', a => { a.requirements[1].id = 'R1'; }, /requirement R1 appears 2 times/],
    ['an unknown follow-up id', a => { a.followups[1].id = 'F9'; }, /finding F9 wasn't asked about/],
    ['a missing follow-up id', a => { a.followups.pop(); }, /finding F2 appears 0 times/],
    ['a clean verdict next to a maintained BUG', a => { a.verdict = 'RESOLVED'; a.findings = []; a.requirements[0].status = 'MET'; }, /verdict RESOLVED sits next to/],
    ['a risky class naming a file that was not reviewed', a => { a.class.files = ['src/other.js']; }, /names src\/other\.js, which wasn't reviewed/],
    ['a finding located in a file that was not reviewed', a => { a.findings[0].location = 'src/a.js.bak:3'; }, /located at src\/a\.js\.bak:3/],
    ['a field outside the schema (a fallback answer)', a => { a.extra = 1; }, /answer\.extra isn't part of the answer/],
    ['a concession because of the round limit, its reason broken over two lines', a => { a.followups[1] = { id: 'F2', status: 'CONCEDE', reason: 'The round\nlimit has been reached, so leave this unfixed' }; },
      /F2 is conceded because of the round limit/],
    ['a concession because of the round limit, in other words', a => { a.followups[1] = { id: 'F2', status: 'CONCEDE', reason: 'The limit of three full rounds has been reached, so leave this unfixed' }; },
      /F2 is conceded because of the round limit/],
    ['a concession because of the round limit, the words the other way round', a => { a.followups[1] = { id: 'F2', status: 'CONCEDE', reason: 'The limit was reached after three rounds, so leave this unfixed' }; },
      /F2 is conceded because of the round limit/],
  ];
  for (const [name, change, expected] of cases) {
    const a = good();
    change(a);
    assert.match(problemsOf(a).join('\n'), expected, name);
  }
  assert.deepStrictEqual(answer.read('review', 'not json', asked).problems, ['the answer is not JSON']);
});

test('Muse\'s check of a test plan is refused when it loses a GPT case or drops more than its own cases need', () => {
  const testCase = id => ({ id, severity: 'HIGH', covers: ['src/a.js'], reqs: ['R1'], input: 'i', expected: 'e', test_file: 'tests/a.test.js', test_name: id });
  const plan = { targets: ['src/a.js'], linkIds: ['R1'], cases: ['T1', 'T2', 'T3', 'T4', 'T5'].map(testCase) };
  const check = over => answer.read('testplan_check', JSON.stringify({ keep: [], dropped: [], added: [], no_case: [], not_worth_testing: '-', ...over }), plan).problems;
  assert.deepStrictEqual(check({ keep: ['T1', 'T2', 'T3', 'T4'], dropped: [{ id: 'T5', why: 'weaker than M1' }], added: [testCase('M1')] }), [], 'one case swapped for a better one');
  assert.match(check({ keep: ['T1', 'T2', 'T3', 'T4'] }).join(' '), /GPT case T5 appears 0 times/, 'a case lost without a word');
  assert.match(check({ keep: ['T1', 'T2', 'T3'], dropped: [{ id: 'T4', why: 'x' }, { id: 'T5', why: 'y' }], added: [testCase('M1')] }).join(' '), /at most 1 may go, not 2/);
  assert.match(check({ keep: ['T1', 'T2', 'T3', 'T4'], dropped: [{ id: 'T5', why: ' ' }], added: [testCase('M1')] }).join(' '), /dropping T5 needs a reason/);
});
