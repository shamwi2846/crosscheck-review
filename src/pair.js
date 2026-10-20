// pair.js: a risky review by two GPTs (DESIGN.md section 7, Pairs). Reviewer A checks the task, reviewer B attacks
// the risky parts. Each then marks the other's findings in its own session (the cross-check), and a deterministic
// merge decides what stands. Any failed run records nothing: the pair is incomplete and runs again.
'use strict';

const ROLES = {
  A: 'Your role in this pair: reviewer A. Check that the code does what the task and its requirements ask.',
  B: `Your role in this pair: reviewer B. Attack the risky parts with this checklist, skipping what doesn't apply:
- money and trading: duplicate or missing orders, stop losses, lot and margin limits, symbol specs, magic numbers, broker rejects and requotes, partial fills, a restart mid-trade, stale state, rounding;
- data: partial runs, no rollback, running twice, integrity, the wrong target, deletion without a guard;
- security: a check missing on some path, secrets in code, logs or errors, comparisons and expiry, injection, unsafe input;
- general: errors and timeouts, concurrency and stale state, the interfaces between parts.`,
};
const SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const RATING = ['MET', 'NOT_IN_THIS_CHANGE', 'PARTIAL', 'NOT_MET']; // (from best to worst)
const FIELDS = ['severity', 'title', 'location', 'trigger', 'harm', 'failure', 'fix', 'test'];
const other = side => (side === 'A' ? 'B' : 'A');

const listOf = found => Object.entries(found)
  .map(([id, f]) => `- ${id} [${f.severity} ${f.label}] ${f.title} (${f.location}): trigger: ${f.trigger}; harm: ${f.harm}; failure: ${f.failure}`)
  .join('\n') || 'None.';

const crosscheckPrompt = (side, found) => `Cross-check (you are reviewer ${side}). The other reviewer, ${other(side)}, reported the findings below. Mark every one of them once, by id:
- CONFIRM: it can really happen as described;
- DISPUTE: it can't happen; give concrete evidence (path:line and why);
- SAME_AS: it is one of your own findings; give that finding's id in same_as.
Nothing else: no new findings in this step.

## Your findings
${listOf(found[side])}

## Reviewer ${other(side)}'s findings
${listOf(found[other(side)])}`;

// Merges the two reviews. `found` holds each side's findings by id (A1…, B1…, unmet rows already among them), and
// `marks` each side's marks on the other's findings. Agreement and harm are kept apart: a finding both found, or
// one confirmed, is a BUG unless every author labelled it a GAP; a disputed one is a GAP, with the evidence; one
// neither confirmed nor disputed is a BUG, since the code is risky.
function merge(a, b, found, marks) {
  const markOn = id => marks[other(id[0])].find(m => m.id === id);
  const ids = [...Object.keys(found.A), ...Object.keys(found.B)];
  const parent = Object.fromEntries(ids.map(id => [id, id]));
  const top = id => (parent[id] === id ? id : top(parent[id]));
  for (const side of ['A', 'B']) {
    for (const m of marks[side]) {
      if (m.mark !== 'SAME_AS') continue;
      const [x, y] = [top(m.id), top(m.same_as)];
      const [keep, joined] = ids.indexOf(x) < ids.indexOf(y) ? [x, y] : [y, x]; // (a group is led by its first id, A before B)
      if (keep !== joined) parent[joined] = keep;
    }
  }
  const findings = [];
  for (const root of ids.filter(id => top(id) === id)) {
    const members = ids.filter(id => top(id) === root).map(id => ({ id, f: found[id[0]][id], mark: markOn(id) }));
    const sides = [...new Set(members.map(m => m.id[0]))];
    const confirmed = members.some(m => m.mark && m.mark.mark === 'CONFIRM');
    const disputed = sides.length === 1 && !confirmed && members.every(m => m.mark && m.mark.mark === 'DISPUTE');
    const lead = members.reduce((best, m) => (SEVERITY.indexOf(m.f.severity) > SEVERITY.indexOf(best.f.severity) ? m : best));
    const label = disputed ? 'GAP' : sides.length === 2 || confirmed ? (members.every(m => m.f.label === 'GAP') ? 'GAP' : 'BUG') : 'BUG';
    const agreement = sides.length === 2 ? 'both' : confirmed ? `confirmed by ${other(sides[0])}`
      : disputed ? `disputed by ${other(sides[0])}: ${members.map(m => m.mark.evidence).join(' / ')}` : 'unsettled';
    const picked = Object.fromEntries(FIELDS.map(k => [k, lead.f[k]]));
    findings.push({ ...picked, label, reqs: [...new Set(members.flatMap(m => m.f.reqs))], agreement, by: sides.sort().join('+') });
  }
  const requirements = a.requirements.map(r => {
    const o = b.requirements.find(x => x.id === r.id) || r;
    const worse = RATING.indexOf(o.status) > RATING.indexOf(r.status) ? o : r;
    return { ...worse, evidence: `A: ${r.evidence} / B: ${o.evidence}` };
  });
  const riskySides = [a, b].filter(x => x.class.level === 'risky');
  const level = riskySides.length ? 'risky' : [a, b].some(x => x.class.level === 'normal') ? 'normal' : 'none';
  const unmet = requirements.some(r => r.status === 'NOT_MET' || r.status === 'PARTIAL');
  return {
    verdict: findings.length || unmet ? 'ISSUES_FOUND' : 'NO_ISSUES',
    findings,
    requirements,
    possibly_missing: [...new Set([...a.possibly_missing, ...b.possibly_missing])],
    // (only a side that rated the change risky names risky files)
    class: { level, files: [...new Set(riskySides.flatMap(x => x.class.files))], why: `A: ${a.class.why} / B: ${b.class.why}` },
    coverage: `A: ${a.coverage} / B: ${b.coverage}`,
  };
}

// Runs a pair on a frozen bundle's prompt. `runOne(prompt, options)` runs one reviewer (review.js's run, with one
// repair); `materialize(answer)` gives an answer's findings with its unmet rows among them. Returns
// { status: 'OK', answer, session, pairComplete: true }, or { status: 'PAIR_INCOMPLETE', why, unavailable } where
// `unavailable` says GPT itself was unavailable (a usage limit, a login problem, a timeout), for the fallback.
async function runPair({ prompt, runOne, materialize }) {
  // (`unavailable` looks at both sides' runs: one side's bad answer mustn't hide that GPT was down for the other)
  const failed = (side, step, r, runs) => ({ status: 'PAIR_INCOMPLETE', unavailable: runs.some(x => x.status === 'GPT_UNAVAILABLE'),
    why: `reviewer ${side}'s ${step} didn't complete (${r.why}), so nothing was recorded` });
  const reviews = {};
  const first = await Promise.all(['A', 'B'].map(side => runOne(`${prompt}\n\n${ROLES[side]}`, { label: `1-${side}` })));
  for (const [i, side] of ['A', 'B'].entries()) {
    if (first[i].status !== 'OK') return failed(side, 'review', first[i], first);
    if (!first[i].session) return failed(side, 'review', { why: 'no session to resume for the cross-check' }, first);
    reviews[side] = first[i];
  }
  const found = {};
  for (const side of ['A', 'B']) found[side] = Object.fromEntries(materialize(reviews[side].answer).map((f, i) => [`${side}${i + 1}`, f]));
  const checks = await Promise.all(['A', 'B'].map(side => runOne(crosscheckPrompt(side, found), {
    label: `2-${side}`, resume: reviews[side].session, strict: true, kind: 'crosscheck',
    asked: { otherIds: Object.keys(found[other(side)]), ownIds: Object.keys(found[side]) },
  })));
  for (const [i, side] of ['A', 'B'].entries()) if (checks[i].status !== 'OK') return failed(side, 'cross-check', checks[i], checks);
  const answer = merge(reviews.A.answer, reviews.B.answer, found, { A: checks[0].answer.marks, B: checks[1].answer.marks });
  return { status: 'OK', answer, session: reviews.A.session, pairComplete: true };
}

module.exports = { runPair, merge, ROLES };
