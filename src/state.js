// state.js: where crosscheck keeps its state, and safe reading and writing of it.
// Every JSON file is written atomically (a temporary file, then a rename) under one lock per file,
// and a file that can't be read is never overwritten: the update is refused instead.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// (in the Claude Code profile it serves, so each profile keeps its own state: CLAUDE_CONFIG_DIR when set,
// else the profile this copy is installed in (<profile>/crosscheck/), else ~/.claude for the repository's own copy)
const PROFILE = path.basename(__dirname) === 'crosscheck' ? path.dirname(__dirname) : path.join(os.homedir(), '.claude');
const HOME = process.env.CROSSCHECK_HOME || path.join(process.env.CLAUDE_CONFIG_DIR || PROFILE, 'crosscheck-state');
const LOCK_WAIT_MS = 8000;     // give up waiting for a lock after this long
const LOCK_UNOWNED_MS = 30000; // a lock with no readable owner this old was left by a crash
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']); // Windows: another process briefly holds the file

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A file's data, or { unreadable } when it exists but isn't a JSON object. A missing file is empty data.
function read(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { data: {} } : { unreadable: e.message };
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return { data };
    return { unreadable: 'not a JSON object' };
  } catch (e) {
    return { unreadable: e.message };
  }
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// Whether a process may still run, for the desktop's owner: only "no such process" counts as ended, so a check that
// fails keeps the desktop owned (unlike `alive`, which errs toward ended, to reclaim locks).
function mayRun(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

// Whether a lock was left by a process that ended. A lock names its owner process, which keeps it however long
// it takes, even across a system sleep. A lock with no readable owner (just made, or the reclaim guard) counts
// as left by a crash after LOCK_UNOWNED_MS.
function isStale(dir) {
  let age;
  try {
    age = Date.now() - fs.statSync(dir).mtimeMs;
  } catch {
    return false; // (gone already)
  }
  let owner = 0;
  try {
    owner = Number(fs.readFileSync(path.join(dir, 'owner'), 'utf8').split(' ')[0]) || 0;
  } catch {}
  return owner ? !alive(owner) : age > LOCK_UNOWNED_MS;
}

// Removes a lock left by a process that ended. One process at a time decides, under a second lock, and checks
// again there, so a lock another process has just taken is never removed. (That second lock is held for a
// moment only, so it has no owner and is reclaimed by age.)
function reclaimIfStale(dir) {
  if (!isStale(dir)) return;
  const guard = `${dir}.reclaim`;
  try {
    fs.mkdirSync(guard);
  } catch {
    if (isStale(guard)) fs.rmSync(guard, { recursive: true, force: true });
    return;
  }
  try {
    if (isStale(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(guard, { recursive: true, force: true });
  }
}

// The lock is a folder next to the file, holding its owner's token: its process id and a random part.
const lockDir = file => `${file}.lock`;
const holds = (file, token) => {
  try {
    return fs.readFileSync(path.join(lockDir(file), 'owner'), 'utf8') === token;
  } catch {
    return false;
  }
};

// Takes a file's lock. Returns the owner token, or null when another process kept it for LOCK_WAIT_MS.
function lock(file) {
  const dir = lockDir(file);
  const token = `${process.pid} ${crypto.randomBytes(8).toString('hex')}`;
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let taken = false;
    try {
      fs.mkdirSync(dir);
      taken = true;
      fs.writeFileSync(path.join(dir, 'owner'), token);
      return token;
    } catch (e) {
      if (taken) fs.rmSync(dir, { recursive: true, force: true });
      if (taken || e.code !== 'EEXIST') throw e;
    }
    reclaimIfStale(dir);
    if (Date.now() > giveUpAt) return null;
    sleep(50);
  }
}

// Releases a lock, unless another process has taken it over in the meantime.
function unlock(file, token) {
  if (holds(file, token)) fs.rmSync(lockDir(file), { recursive: true, force: true });
}

// Replaces `file` with `text` while this process still holds the lock of `lockFile`. Returns false, writing
// nothing, if it doesn't.
function writeAtomic(file, text, lockFile, token) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    for (let attempt = 1; ; attempt++) {
      if (!holds(lockFile, token)) return false;
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (e) {
        if (attempt >= 10 || !BUSY.has(e.code)) throw e;
        sleep(50);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Runs `fn(write)` under the lock of `lockFile`; the other files of a project (KNOWN_GAPS.md, lessons) share the
// lock of its state file. `write(file, text)` replaces a file atomically while the lock is still held, and returns
// false, writing nothing, if another process took the lock over. Returns what `fn` returns, or { ok: false, why }
// when the lock is busy. If `fn` throws, the lock is released and the error passes on.
function withLock(lockFile, fn) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = lock(lockFile);
  // (if a crashed owner's process id went to a new process, the lock stays until the folder is deleted)
  if (!token) return { ok: false, why: `${lockFile} is locked by another process (if no crosscheck command is running, delete ${lockDir(lockFile)})` };
  try {
    return fn((file, text) => writeAtomic(file, text, lockFile, token));
  } finally {
    unlock(lockFile, token);
  }
}

// Changes a JSON file under its lock. `fn` gets the current data, changes it in place and may return a value.
// Returns { ok: true, value } or { ok: false, why }. If `fn` throws, nothing is written.
function update(file, fn) {
  return withLock(file, write => {
    const current = read(file);
    if (current.unreadable) return { ok: false, why: `${file} can't be read (${current.unreadable}), so it was left as it is` };
    const value = fn(current.data);
    if (!write(file, JSON.stringify(current.data, null, 2))) return { ok: false, why: `another process took over ${file}'s lock, so nothing was written` };
    return { ok: true, value };
  });
}

// A project file's identity in state: its project-relative path with forward slashes, lowercased on Windows,
// where two spellings of one path name the same file.
function pathKey(rel) {
  const p = String(rel).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
const fileKey = (root, file) => pathKey(path.relative(root, path.resolve(root, file)));

// The project a folder belongs to: the top folder of its git repository, or null outside git.
function projectRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? path.resolve(r.stdout.trim()) : null;
}

// The same, found without git (for the hooks, which run on every edit): the nearest folder above `file` holding a
// .git folder or file, as { root: its real spelling, the project's identity; dir: as `file` spells it, so a path
// through a linked folder stays inside it }, or null.
function repoOf(file) {
  for (let dir = path.dirname(path.resolve(file)); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return { root: fs.realpathSync.native(dir), dir };
    if (path.dirname(dir) === dir) return null;
  }
}

// A project's state folder: its name plus a short hash of its full path, so two projects never share one.
function projectDir(root) {
  const full = path.resolve(root);
  const key = process.platform === 'win32' ? full.toLowerCase() : full;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  return path.join(HOME, `${path.basename(full).replace(/[^\w.-]+/g, '_')}-${hash}`);
}

const files = {
  global: () => path.join(HOME, 'global.json'),
  config: () => path.join(HOME, 'config.json'),
  project: root => path.join(projectDir(root), 'state.json'),
  task: (root, session) => path.join(projectDir(root), 'tasks', `${String(session).replace(/[^\w-]+/g, '_')}.md`),
};

const DEFAULT_CONFIG = {
  model: 'gpt-6.1-sol',
  windowsSandbox: 'unelevated',
  codexJs: path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
};

// The config: the defaults, overridden by config.json (written once at install).
function config() {
  return { ...DEFAULT_CONFIG, ...(read(files.config()).data || {}) };
}

module.exports = { HOME, read, update, withLock, alive, mayRun, pathKey, fileKey, projectRoot, repoOf, projectDir, files, config };
