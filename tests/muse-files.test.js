// Tests for muse-files.js, the read-only project-files tool Muse gets (test plan cases T1 and T3 of its task): every
// path is checked again on every call, so a path that became a link to an ignored or outside folder loses its access,
// secrets files and forbidden content never come back, and one manifest's answers share one allowance that a new
// server process (a resumed Muse) can't reset. They drive the real server over stdio.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck muse-files test ü '));
const SERVER = path.join(__dirname, '..', 'src', 'muse-files.js');

const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
// A git project with these files committed.
function project(name, files) {
  const root = path.join(HOME, name);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'base']]) {
    assert.strictEqual(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).status, 0);
  }
  return fs.realpathSync.native(root);
}
// A manifest as crosscheck writes it, and the server it starts: call(name, args) resolves to the answer's text.
function manifestFor(root, over = {}) {
  const file = path.join(root, '..', `${path.basename(root)}-manifest-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ root, reviewed: {}, plan: null, log: `${file}.log`, ...over }));
  return file;
}
const started = []; // (every server a test started, stopped after it even when an assertion failed)
test.afterEach(() => { for (const child of started.splice(0)) child.kill(); });
function open(manifest) {
  const child = spawn(process.execPath, [SERVER, manifest], { stdio: ['pipe', 'pipe', 'inherit'] });
  started.push(child);
  const waiting = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const request = (method, params) => new Promise(resolve => { id += 1; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return {
    request,
    call: async (name, args) => (await request('tools/call', { name, arguments: args })).result.content[0].text,
    close: () => new Promise(resolve => { child.on('close', resolve); child.stdin.end(); }),
  };
}
const logged = manifest => fs.readFileSync(`${manifest}.log`, 'utf8');

test('the file tools check each path again on every call: only eligible project files and their contents come back', async () => {
  const root = project('t1', { '.gitignore': 'private/\n', 'src/app.js': 'SHARED-WORD APP-SENTINEL\nline two\nline three\n',
    '.env.production': 'SHARED-WORD ENV-SECRET\n', 'vendor/customer.js': 'SHARED-WORD CUSTOMER-OK\n' });
  put(root, 'private/customer.js', 'SHARED-WORD IGNORED-SECRET\n');
  const outside = path.join(HOME, 't1-outside');
  put(outside, 'customer.js', 'SHARED-WORD OUTSIDE-SECRET\n');
  const manifest = manifestFor(root);
  const s = open(manifest);
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.strictEqual(init.result.serverInfo.name, 'project-files');
  const listed = (await s.request('tools/list', {})).result.tools;
  assert.deepStrictEqual(listed.map(t => [t.name, t.annotations.readOnlyHint]), [['list_files', true], ['read_file', true], ['search', true]]);
  const list = await s.call('list_files', {});
  assert.ok(list.includes('src/app.js') && list.includes('vendor/customer.js') && !list.includes('.env.production'), list);
  assert.match(await s.call('read_file', { path: 'src/app.js' }), /^src\/app\.js, lines 1-4 of 4:\nSHARED-WORD APP-SENTINEL/);
  assert.strictEqual(await s.call('read_file', { path: 'src/app.js', start_line: 2, end_line: 2 }), 'src/app.js, lines 2-2 of 4:\nline two');
  assert.match(await s.call('read_file', { path: '.env.production' }), /: a secrets file$/);
  let found = await s.call('search', { text: 'SHARED-WORD' });
  assert.ok(found.includes('src/app.js:1:') && found.includes('CUSTOMER-OK') && !found.includes('ENV-SECRET'), found);
  // (the tracked vendor folder becomes a link to an ignored folder in the project, then to one outside it)
  for (const [target, secret, why] of [[path.join(root, 'private'), 'IGNORED-SECRET', 'not a file git lists for the project'],
    [outside, 'OUTSIDE-SECRET', 'a link to somewhere outside the project']]) {
    fs.rmSync(path.join(root, 'vendor'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'vendor'), 'junction');
    assert.strictEqual(await s.call('read_file', { path: 'vendor/customer.js' }), `vendor/customer.js: ${why}`);
    found = await s.call('search', { text: 'SHARED-WORD' });
    assert.ok(found.includes('APP-SENTINEL') && !found.includes(secret) && !found.includes('vendor/customer.js'), found);
    assert.ok(!(await s.call('list_files', {})).includes('vendor/customer.js'), 'a path it may not read isn\'t offered');
  }
  await s.close();
  for (const secret of ['ENV-SECRET', 'IGNORED-SECRET', 'OUTSIDE-SECRET']) assert.ok(!logged(manifest).includes(secret), `${secret} is in no answer`);
});

test('the file tools share one allowance per manifest: every answer is cut, the total stops, and a new server process can\'t reset it', async () => {
  const long = `${'x'.repeat(150000)}\n`;
  const root = project('t3', { 'src/big.js': long.repeat(2), 'src/line.js': `const k = "NEEDLE${'y'.repeat(5000)}";\n` });
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'alias'), 'junction');
  const manifest = manifestFor(root);
  let s = open(manifest);
  const hit = await s.call('search', { text: 'NEEDLE' });
  // (one hit: the file is searched once, under the first of its names, git listing it under the folder link too)
  assert.ok(/^(alias|src)\/line\.js:1: const k = "NEEDLE/.test(hit) && !hit.includes('\n') && hit.length <= 'alias/line.js:1: '.length + 200, hit.slice(0, 300));
  const answers = [];
  for (let i = 0; i < 25; i++) answers.push(await s.call('read_file', { path: i % 2 ? 'src/big.js' : 'alias/big.js' }));
  assert.ok(answers.every(a => a.length <= 100000 + 80), 'no answer passes the answer limit, with its cut note');
  assert.match(answers[0], /\(cut at 100000 characters: read on with a later start_line\)$/);
  const delivered = answers.filter(a => !a.includes('is used up'));
  assert.ok(delivered.length < 25 && delivered.reduce((n, a) => n + a.length, hit.length) <= 2000000 + 25 * 80, 'the total stops');
  assert.match(answers[24], /the 2000000-character total of this review's file tool is used up/);
  await s.close();
  s = open(manifest); // (a resumed Muse starts the server again)
  assert.match(await s.call('list_files', {}), /is used up/);
  assert.match(await s.call('search', { text: 'NEEDLE' }), /is used up/);
  await s.close();
});

test('a reviewed file answers from the review whatever happens to it live, and a search names the files too large to search', async () => {
  // (crosscheck records a file the change deletes as null, and a present one by its frozen copy)
  process.env.CROSSCHECK_HOME = path.join(HOME, 'state');
  const review = require('../src/review');
  const root = project('t4', { 'src/kept.js': 'KEPT-LIVE\n', 'src/gone.js': 'GONE-LIVE\n', 'src/huge.txt': `${'h'.repeat(1100000)}\nNEEDLE2\n` });
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'alias'), 'junction');
  // (the deletion recorded under the folder link's name, while its file is gone: its real name is recorded too)
  fs.renameSync(path.join(root, 'src/gone.js'), path.join(root, 'gone.bak'));
  const tools = review.museTools(root, 'attempt-t4', { files: { a: { path: 'alias/gone.js', frozen: review.DELETED }, b: { path: 'src/kept.js', frozen: 'f'.repeat(64) } } });
  fs.renameSync(path.join(root, 'gone.bak'), path.join(root, 'src/gone.js'));
  const written = JSON.parse(fs.readFileSync(tools.files, 'utf8'));
  assert.deepStrictEqual([written.reviewed['alias/gone.js'], written.reviewed['src/gone.js'], typeof written.reviewed['src/kept.js']], [null, null, 'string'],
    'a deleted reviewed file is recorded as deleted, under both names');
  // (and when its whole folder is gone too)
  const deep = review.museTools(root, 'attempt-t4-deep', { files: { a: { path: 'alias/sub/deeper/gone.js', frozen: review.DELETED } } });
  assert.strictEqual(JSON.parse(fs.readFileSync(deep.files, 'utf8')).reviewed['src/sub/deeper/gone.js'], null, 'its real name, though its folders are gone');
  const frozen = path.join(HOME, 't4-kept-frozen');
  fs.writeFileSync(frozen, 'KEPT-FROZEN\n');
  const manifest = manifestFor(root, { reviewed: { 'src/kept.js': frozen, 'alias/gone.js': null, 'src/gone.js': null } });
  fs.rmSync(path.join(root, 'src/kept.js')); // (deleted live after it was frozen; src/gone.js stands for one deleted by the change and made again)
  const s = open(manifest);
  assert.strictEqual(await s.call('read_file', { path: 'src/kept.js' }), 'src/kept.js, lines 1-2 of 2:\nKEPT-FROZEN\n');
  for (const name of ['src/gone.js', 'alias/gone.js']) assert.strictEqual(await s.call('read_file', { path: name }), `${name}: deleted in the change under review`);
  const live = await s.call('search', { text: '-LIVE' });
  assert.ok(!live.includes('GONE-LIVE') && !live.includes('KEPT-LIVE'), live);
  assert.match(await s.call('search', { text: 'KEPT-FROZEN' }), /^src\/kept\.js:1: KEPT-FROZEN/, 'a reviewed file gone live is still searched, as its frozen copy');
  const list = await s.call('list_files', {});
  assert.ok(list.includes('src/kept.js') && !list.includes('gone.js'), list);
  // (named once, under the first name git lists it by)
  assert.match(await s.call('search', { text: 'NEEDLE2' }), /^No match\.\n\(not searched, over 1048576 bytes: (alias|src)\/huge\.txt; read them in parts with read_file\)$/);
  await s.close();
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
