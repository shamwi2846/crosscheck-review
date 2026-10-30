// pair.js: a paired review (DESIGN.md section 7, Pairs): GPT as reviewer A, and as reviewer B a second GPT, or Muse
// while `crosscheck muse on`. Reviewer A checks the task, reviewer B attacks the risky parts. Each then marks the
// other's findings in its own session (the cross-check), and a deterministic merge decides what stands. Any failed run
// records nothing: the pair is incomplete and runs again.
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
// (the rating a requirement shows when the two differ: an unmet one over a met one, a met one over "not in this change")
const RATING = ['NOT_IN_THIS_CHANGE', 'MET', 'PARTIAL', 'NOT_MET'];
const FIELDS = ['severity', 'title', 'location', 'trigger', 'harm', 'failure', 'fix', 'test'];
const other = side => (side === 'A' ? 'B' : 'A');

const listOf = found => Object.entries(found)
  .map(([id, f]) => `- ${id} [${f.severity} ${f.label}] ${f.title} (${f.location}): trigger: ${f.trigger}; harm: ${f.harm}; failure: ${f.failure}`)
  .join('\n') || 'None.';

const crosscheckPrompt = (side, found) => `Cross-check (you are reviewer ${side}). The other reviewer, ${other(side)}, reported the findings below. Mark every one of them once, by id:
- CONFIRM: it can really happen as described; in label, your own judgement of it: BUG if it can cause real harm, else GAP;
- DISPUTE: it can't happen; give concrete evidence (path:line and why);
- SAME_AS: it is one of your own findings; give that finding's id in same_as;
- UNCLEAR: you can't tell from what you have; say in evidence what you couldn't check.
label is null except for CONFIRM. Nothing else: no new findings in this step.

## Your findings
${listOf(found[side])}

## Reviewer ${other(side)}'s findings
${listOf(found[other(side)])}`;

// The member whose text a merged finding keeps: one that called it what it ended up as, then the more severe, then
// one with a real place over a requirement's "-" (ties: the first, A before B).
function leadOf(members, label) {
  const rank = m => [m.f.label === label ? 1 : 0, SEVERITY.indexOf(m.f.severity), m.f.location === '-' ? 0 : 1];
  const better = (x, y) => { const i = x.findIndex((v, k) => v !== y[k]); return i >= 0 && x[i] > y[i]; };
  return members.reduce((best, m) => (better(rank(m), rank(best)) ? m : best));
}

// Merges the two reviews. `found` holds each side's findings by id (A1…, B1…, unmet rows already among them), and
// `marks` each side's marks on the other's findings. Two findings are one only when each reviewer marked the other's
// as the same as its own: a one-sided SAME_AS can't fold another's finding away, it confirms it, judged with the
// label of the marker's own. Agreement and harm are kept apart: a finding both found, or confirmed, is a BUG unless
// everyone who judged its harm called it a GAP; a disputed one is a GAP, with the evidence; one its checker couldn't
// tell keeps its author's label.
function merge(a, b, found, marks) {
  const own = id => found[id[0]][id];
  const markOn = id => marks[other(id[0])].find(m => m.id === id);
  const twinOf = id => {
    const m = markOn(id);
    const back = m && m.mark === 'SAME_AS' ? markOn(m.same_as) : null;
    return back && back.mark === 'SAME_AS' && back.same_as === id ? m.same_as : null;
  };
  const findings = [];
  for (const id of [...Object.keys(found.A), ...Object.keys(found.B)]) {
    const twin = twinOf(id);
    if (twin && id[0] === 'B') continue; // (a pair both named is taken once, from A's side)
    const members = [id, ...(twin ? [twin] : [])].map(x => ({ id: x, f: own(x) }));
    const mark = markOn(id);
    let label = 'BUG';
    let agreement;
    if (twin) {
      agreement = 'both';
      if (members.every(m => m.f.label === 'GAP')) label = 'GAP';
    } else if (mark.mark === 'DISPUTE') {
      agreement = `disputed by ${other(id[0])}: ${mark.evidence}`;
      label = 'GAP';
    } else if (mark.mark === 'UNCLEAR') {
      agreement = `unsettled: ${other(id[0])} couldn't tell (${mark.evidence})`;
      label = own(id).label;
    } else { // (CONFIRM, or a one-sided SAME_AS: the checker judged the harm as its label, or as its own finding's)
      agreement = `confirmed by ${other(id[0])}`;
      const judged = mark.mark === 'CONFIRM' ? mark.label : own(mark.same_as).label;
      if (own(id).label === 'GAP' && judged === 'GAP') label = 'GAP';
    }
    const picked = Object.fromEntries(FIELDS.map(k => [k, leadOf(members, label).f[k]]));
    findings.push({ ...picked, label, reqs: [...new Set(members.flatMap(m => m.f.reqs))], agreement, by: twin ? 'A+B' : id[0] });
  }
  const unmetRating = status => status === 'PARTIAL' || status === 'NOT_MET';
  const requirements = a.requirements.map(r => {
    const o = b.requirements.find(x => x.id === r.id) || r;
    let shown = RATING.indexOf(o.status) > RATING.indexOf(r.status) ? o : r;
    // (rated unmet by one side only, and every one of that side's own findings naming it disputed: the other side's
    // rating stands; its own findings, since a merged one can name it through the other side's member)
    const lone = unmetRating(r.status) === unmetRating(o.status) ? null : unmetRating(r.status) ? 'A' : 'B';
    const linked = lone ? Object.keys(found[lone]).filter(id => own(id).reqs.includes(r.id)) : [];
    if (linked.length && linked.every(id => markOn(id).mark === 'DISPUTE')) shown = lone === 'A' ? o : r;
    return { ...shown, evidence: `A: ${r.evidence} / B: ${o.evidence}` };
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

// Runs a pair on a frozen bundle's prompt. `runOne(prompt, options, side)` runs one reviewer (review.js's run, with
// one repair); `materialize(answer)` gives an answer's findings with its unmet rows among them. Reviewer B may read
// its own version of the prompt (`promptB`: Muse's, with the material inline), and a finished first review of
// reviewer A may be reused (`firstA`), so A never runs twice. Returns { status: 'OK', answer, session,
// pairComplete: true }, or { status: 'PAIR_INCOMPLETE', why, unavailable, step, whyB, firstA } where `unavailable`
// says GPT itself was unavailable (a usage limit, a login problem, a timeout), for the fallback, `step` says which
// step failed, `whyB` why reviewer B's run in it failed (null when it didn't, even if A's did too), and `firstA` is A's
// first review if it completed.
async function runPair({ prompt, promptB = prompt, runOne, materialize, firstA = null }) {
  const prompts = { A: prompt, B: promptB };
  const first = await Promise.all(['A', 'B'].map(side => (side === 'A' && firstA ? firstA
    : runOne(`${prompts[side]}\n\n${ROLES[side]}`, { label: `1-${side}` }, side))));
  // (`unavailable` looks at both sides' runs: one side's bad answer mustn't hide that GPT was down for the other)
  const failed = (side, step, r, runs) => ({ status: 'PAIR_INCOMPLETE', unavailable: runs.some(x => x.status === 'GPT_UNAVAILABLE'),
    why: `reviewer ${side}'s ${step} didn't complete (${r.why}), so nothing was recorded`, step, whyB: runs[1].status === 'OK' ? null : runs[1].why,
    firstA: first[0].status === 'OK' ? first[0] : null });
  const reviews = {};
  for (const [i, side] of ['A', 'B'].entries()) {
    if (first[i].status !== 'OK') return failed(side, 'review', first[i], first);
    reviews[side] = first[i];
  }
  const found = {};
  for (const side of ['A', 'B']) found[side] = Object.fromEntries(materialize(reviews[side].answer).map((f, i) => [`${side}${i + 1}`, f]));
  // (a side marks only when the other found something: an empty cross-check could change nothing, and its failure
  // would cost the whole pair)
  const marking = side => Object.keys(found[other(side)]).length > 0;
  for (const [i, side] of ['A', 'B'].entries()) {
    if (marking(side) && !first[i].session) return failed(side, 'review', { why: 'no session to resume for the cross-check' }, first);
  }
  const checks = await Promise.all(['A', 'B'].map(side => (!marking(side) ? { status: 'OK', answer: { marks: [] } } : runOne(crosscheckPrompt(side, found), {
    label: `2-${side}`, resume: reviews[side].session, strict: true, kind: 'crosscheck',
    asked: { otherIds: Object.keys(found[other(side)]), ownIds: Object.keys(found[side]) },
  }, side))));
  for (const [i, side] of ['A', 'B'].entries()) if (checks[i].status !== 'OK') return failed(side, 'cross-check', checks[i], checks);
  const answer = merge(reviews.A.answer, reviews.B.answer, found, { A: checks[0].answer.marks, B: checks[1].answer.marks });
  return { status: 'OK', answer, session: reviews.A.session, pairComplete: true };
}

module.exports = { runPair, merge, ROLES };
