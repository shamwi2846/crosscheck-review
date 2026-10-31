// An opt-in live test of doctor --live's Muse check with the installed, real Muse Code (shell task, case T5): the probe
// runs Muse exactly as a review does, shell and sandbox included, has it try a write outside its folder, and passes only
// when the sandbox refused it and the session check passed. It makes a real model call, so it runs only with
// CROSSCHECK_LIVE_MUSE=1, on its own state folder (never the user's verification) and its own temp folder, whose
// sentinel must survive.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

test('live_probe_exercises_the_review_shell_sandbox (shell task T5)', { skip: !process.env.CROSSCHECK_LIVE_MUSE && 'set CROSSCHECK_LIVE_MUSE=1 to run it with the real Muse', timeout: 900000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck live muse '));
  const temp = path.join(home, 'temp');
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(temp, 'sentinel.txt'), 'keep');
  Object.assign(process.env, { CROSSCHECK_HOME: path.join(home, 'state'), TEMP: temp, TMP: temp, TMPDIR: temp }); // (the probe's folders go in `temp`)
  fs.mkdirSync(process.env.CROSSCHECK_HOME);
  const state = require('../src/state');
  const muse = require('../src/muse');
  try {
    const r = await muse.probe();
    assert.ok(r.ok, r.info);
    assert.match(r.info, /its shell sandboxed \(a write outside its folder refused\)/);
    assert.ok(state.config().museVerified, 'verified in this test\'s own state');
    assert.deepStrictEqual(fs.readdirSync(temp), ['sentinel.txt'], 'the probe left nothing behind, and its target was never written');
    assert.strictEqual(fs.readFileSync(path.join(temp, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
