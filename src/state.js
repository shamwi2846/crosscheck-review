// state.js: where crosscheck keeps its state, and safe reading and writing of it.
// Every JSON file is written atomically (a temporary file, then a rename) under one lock per file,
// and a file that can't be read is never overwritten: the update is refused instead.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const HOME = process.env.CROSSCHECK_HOME || path.join(os.homedir(), '.claude', 'crosscheck-state');
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

// Replaces the file while this process still holds its lock. Returns false, writing nothing, if it doesn't.
function writeAtomic(file, data, token) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    for (let attempt = 1; ; attempt++) {
      if (!holds(file, token)) return false;
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

// Changes a file under its lock. `fn` gets the current data, changes it in place and may return a value.
// Returns { ok: true, value } or { ok: false, why }. If `fn` throws, nothing is written.
function update(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = lock(file);
  // (if a crashed owner's process id went to a new process, the lock stays until the folder is deleted)
  if (!token) return { ok: false, why: `${file} is locked by another process (if no crosscheck command is running, delete ${lockDir(file)})` };
  try {
    const current = read(file);
    if (current.unreadable) return { ok: false, why: `${file} can't be read (${current.unreadable}), so it was left as it is` };
    const value = fn(current.data);
    if (!writeAtomic(file, current.data, token)) return { ok: false, why: `another process took over ${file}'s lock, so nothing was written` };
    return { ok: true, value };
  } finally {
    unlock(file, token);
  }
}

// The project a folder belongs to: the top folder of its git repository, or null outside git.
function projectRoot(dir) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? path.resolve(r.stdout.trim()) : null;
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

module.exports = { HOME, read, update, projectRoot, projectDir, files, config };
