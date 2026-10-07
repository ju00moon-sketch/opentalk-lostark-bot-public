import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, readFileSync, readSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore } from './store.js';
import { validateScheduleSeed } from './guild-schedule-store.js';

const LIMIT = 32 * 1024 * 1024;

function privatePath(path, file = true) {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error('An existing absolute private path is required');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (file ? !stat.isFile() : !stat.isDirectory()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Private regular storage is required');
  return stat;
}

function checkDatabase(path) {
  privatePath(dirname(path), false);
  privatePath(path);
  for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) privatePath(path + suffix);
}

export function importSchedule(path, raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!bytes.length || bytes.length > LIMIT) throw new Error('Schedule source size is invalid');
  let seed;
  try { seed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Schedule source must be valid JSON'); }
  validateScheduleSeed(seed);
  checkDatabase(path);
  const store = createStore(path);
  try {
    return { ...store.schedule.import(seed), sourceSha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { store.close(); }
}

export function preserveSchedule(path) {
  checkDatabase(path);
  const snapshot = new DatabaseSync(path, { readOnly: true });
  let counts;
  try {
    const version = snapshot.prepare('PRAGMA user_version').get().user_version;
    if (![4, 5, 6, 7, 8].includes(version)) throw new Error('A compatible existing schedule database is required');
    if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || snapshot.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('Existing database integrity check failed');
    }
    const metadata = snapshot.prepare('SELECT COUNT(*) AS count FROM guild_schedule_metadata').get().count;
    const sheets = snapshot.prepare('SELECT COUNT(*) AS count FROM guild_schedule_sheets').get().count;
    const groups = snapshot.prepare('SELECT COUNT(*) AS count FROM guild_schedule_entries').get().count;
    if (metadata !== 1 || sheets < 1) throw new Error('A previously imported schedule is required');
    counts = { preserved: true, sheets, groups };
  } finally { snapshot.close(); }
  const store = createStore(path);
  store.close();
  return counts;
}

function readSource(source) {
  if (source !== '-') {
    if (privatePath(source).size > LIMIT) throw new Error('Schedule source is too large');
    return readFileSync(source);
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.alloc(65536);
    const length = readSync(0, buffer, 0, buffer.length, null);
    if (!length) break;
    total += length;
    if (total > LIMIT) throw new Error('Schedule source is too large');
    chunks.push(buffer.subarray(0, length));
  }
  return Buffer.concat(chunks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argumentsList = process.argv.slice(2);
    const options = new Map();
    for (let index = 0; index < argumentsList.length; index++) {
      const option = argumentsList[index];
      if (!['--database', '--source', '--preserve-existing', '--service-stopped'].includes(option) || options.has(option)) throw new Error('Invalid importer arguments');
      const value = ['--database', '--source'].includes(option) ? argumentsList[++index] : true;
      if (!value || (typeof value === 'string' && value.startsWith('--'))) throw new Error('Invalid importer arguments');
      options.set(option, value);
    }
    if (!options.has('--database') || !options.has('--service-stopped') || options.has('--source') === options.has('--preserve-existing')) {
      throw new Error('Usage: node src/schedule-import.js --database ABSOLUTE_DB_PATH (--source ABSOLUTE_PRIVATE_JSON_OR_DASH | --preserve-existing) --service-stopped');
    }
    process.umask(0o077);
    const result = options.has('--source') ? importSchedule(options.get('--database'), readSource(options.get('--source'))) : preserveSchedule(options.get('--database'));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
