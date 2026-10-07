// 기존 출석의 명시적인 일대일 연결. 기본은 후보 출력이며 적용에는 --apply가 필요하다.
import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, lstatSync, realpathSync, renameSync, unlinkSync, chmodSync, chownSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { buildAttendanceIdentityMigration, withAttendanceStoreLock } from '../src/attendance.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };
const physicalPath = (path) => resolve(realpathSync(dirname(resolve(path))), basename(path));

function writeExclusive(path, bytes, metadata) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    if (metadata) {
      if (process.platform !== 'win32') chownSync(path, metadata.uid, metadata.gid);
      chmodSync(path, metadata.mode & 0o777);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  if (hash(readFileSync(path)) !== hash(bytes)) fail('작성한 파일의 해시가 일치하지 않아요');
}

export function migrateAttendanceIdentity({ storePath, mappingPath, outputPath, apply = false }) {
  const store = physicalPath(storePath);
  const mappingFile = physicalPath(mappingPath);
  const output = physicalPath(outputPath);
  const forbidden = [store, `${store}.bak`, `${store}.tmp`, `${store}.identity-lock`, mappingFile];
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (forbidden.some((file) => same(file, output))) fail('후보 출력 경로가 보호 파일과 같아요');
  const metadata = lstatSync(store);
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail('원본은 일반 파일이어야 해요');
  const mapping = JSON.parse(readFileSync(mappingFile, 'utf8'));
  if (typeof mapping.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(mapping.expectedSha256)) fail('기대 원본 SHA256이 필요해요');
  const execute = () => {
    const original = readFileSync(store);
    if (hash(original) !== mapping.expectedSha256) fail('원본이 계획 이후 변경됐어요');
    const candidate = buildAttendanceIdentityMigration(JSON.parse(original), mapping);
    const bytes = Buffer.from(JSON.stringify(candidate, null, 2));
    // 기존 파일은 후보 출력으로도 절대 덮어쓰지 않는다.
    writeExclusive(output, bytes);
    const result = { applied: false, beforeSha256: hash(original), afterSha256: hash(bytes), candidate: output };
    if (!apply) return result;
    const backup = `${store}.identity-before-${hash(original)}.json`;
    writeExclusive(backup, original);
    if (hash(readFileSync(backup)) !== mapping.expectedSha256) fail('원본 백업 검증에 실패했어요');
    const temporary = `${store}.identity-${randomUUID()}.tmp`;
    try {
      writeExclusive(temporary, bytes, metadata);
      const currentMetadata = lstatSync(store);
      if (currentMetadata.isSymbolicLink() || currentMetadata.dev !== metadata.dev || currentMetadata.ino !== metadata.ino
        || hash(readFileSync(store)) !== mapping.expectedSha256) fail('적용 직전 원본이 변경됐어요');
      renameSync(temporary, store);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (hash(readFileSync(store)) !== hash(bytes)) fail('적용 후 원본 검증에 실패했어요');
    return { ...result, applied: true, backup };
  };
  return apply ? withAttendanceStoreLock(store, execute) : execute();
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  const flags = { '--store': 'storePath', '--mapping': 'mappingPath', '--output': 'outputPath' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--apply' && !options.apply) options.apply = true;
    else if (Object.hasOwn(flags, flag) && !options[flags[flag]] && args[i + 1] && !args[i + 1].startsWith('--')) options[flags[flag]] = args[++i];
    else fail('사용법: --store 원본 --mapping 계획 --output 새후보 [--apply]');
  }
  if (!options.storePath || !options.mappingPath || !options.outputPath) fail('원본·계획·새 후보 경로가 필요해요');
  console.log(JSON.stringify(migrateAttendanceIdentity(options), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
