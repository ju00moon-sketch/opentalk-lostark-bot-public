import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeCharacter} from './character-profile.js';

// Durable best 환산 점수 per character. The display snapshot only keeps the latest calculation and is
// disposable; this file only ever rises, like the bracelet value records, and lives beside them.
export const SCORE_RECORD_APPLICATION_ID = 0x4f545343;
export const SCORE_RECORD_TABLE_SQL = `CREATE TABLE score_records (
  name_key TEXT NOT NULL PRIMARY KEY, character_name TEXT NOT NULL,
  score REAL NOT NULL CHECK(score>0), role TEXT NOT NULL CHECK(role IN ('dealer','support')),
  model_version TEXT NOT NULL, recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64)
) STRICT`;
const FILE_LIMIT = 64 * 1024 * 1024;
const FIELDS = ['score','role','modelVersion','recordedAt'];
const ROLES = ['dealer','support'];
const unavailable = () => Object.assign(new Error('Score record storage is unavailable'),{code:'score_record_unavailable'});
const capacity = () => Object.assign(new Error('Score record capacity reached'),{code:'score_record_capacity'});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(name) {
  const characterName=normalizeCharacter(name);
  if(!characterName) throw unavailable();
  return {characterName,nameKey:characterName.toLowerCase()};
}
function candidate(id,value,timestamp) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==FIELDS.length ||
      Object.keys(value).some(key=>!FIELDS.includes(key)) ||
      typeof value.score!=='number' || !Number.isFinite(value.score) || value.score<=0 || value.score>Number.MAX_SAFE_INTEGER ||
      !ROLES.includes(value.role) ||
      typeof value.modelVersion!=='string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(value.modelVersion) ||
      !Number.isSafeInteger(timestamp) || timestamp<0 || !Number.isSafeInteger(value.recordedAt) || value.recordedAt<0 || value.recordedAt>timestamp) throw unavailable();
  return {characterName:id.characterName,score:value.score,role:value.role,modelVersion:value.modelVersion,recordedAt:value.recordedAt};
}
function storageError(error) {
  return error?.code==='score_record_capacity' || error?.errcode===13 ? capacity() : unavailable();
}

export function createScoreRecordStore(path,{now=Date.now,maxRecords=100000,maxFileBytes=FILE_LIMIT}={}) {
  let db;
  try {
    if(typeof path!=='string' || !isAbsolute(path) || typeof now!=='function' ||
        !Number.isSafeInteger(maxRecords) || maxRecords<1 || maxRecords>100000 ||
        !Number.isSafeInteger(maxFileBytes) || maxFileBytes<65536 || maxFileBytes>FILE_LIMIT) throw unavailable();
    const directory=dirname(path);
    mkdirSync(directory,{recursive:true,mode:0o700});
    if(lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() ||
        (process.platform!=='win32' && (lstatSync(directory).mode&0o077))) throw unavailable();
    if(!existsSync(path)) {
      try {const fd=openSync(path,'wx',0o600);closeSync(fd);}
      catch(error){if(error.code!=='EEXIST')throw error;}
    }
    if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size>maxFileBytes) throw unavailable();
    for(const suffix of ['-journal','-wal','-shm'])if(existsSync(path+suffix) &&
        (!lstatSync(path+suffix).isFile() || lstatSync(path+suffix).isSymbolicLink()))throw unavailable();
    db=new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=250;');
    const version=db.prepare('PRAGMA user_version').get().user_version;
    const app=db.prepare('PRAGMA application_id').get().application_id;
    const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const fresh=version===0 && app===0 && objects.length===0;
    if(!fresh && !(version===1 && app===SCORE_RECORD_APPLICATION_ID && objects.length===1 &&
        objects[0].type==='table' && objects[0].name==='score_records' && objects[0].sql===SCORE_RECORD_TABLE_SQL)) throw unavailable();
    // Inspect provenance before altering permissions, schema, or journal settings.
    chmodSync(path,0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(maxFileBytes/pageSize)};`);
    if(fresh){db.exec('BEGIN IMMEDIATE');try{db.exec(`${SCORE_RECORD_TABLE_SQL}; PRAGMA application_id=${SCORE_RECORD_APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);}catch(error){db.exec('ROLLBACK');throw error;}}
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw unavailable();
  } catch(error) {try{db?.close();}catch{}throw storageError(error);}

  let closed=false;
  const read=db.prepare('SELECT * FROM score_records WHERE name_key=?');
  const count=db.prepare('SELECT COUNT(*) AS n FROM score_records');
  // Only a strictly higher score replaces the row; ties and drops keep the earlier record and its time.
  const upsert=db.prepare(`INSERT INTO score_records VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(name_key) DO UPDATE SET
    character_name=excluded.character_name,score=excluded.score,role=excluded.role,
    model_version=excluded.model_version,recorded_at=excluded.recorded_at,record_sha256=excluded.record_sha256
    WHERE excluded.score>score_records.score`);
  function decode(row,id,timestamp) {
    if(!row)return null;
    const storedId=identity(row.character_name);
    if(row.name_key!==id.nameKey || storedId.nameKey!==id.nameKey)throw unavailable();
    const data=candidate(storedId,{score:row.score,role:row.role,modelVersion:row.model_version,recordedAt:row.recorded_at},timestamp);
    if(row.record_sha256!==digest(data))throw unavailable();
    return data;
  }
  function get(name) {
    try{if(closed)throw unavailable();const id=identity(name);return decode(read.get(id.nameKey),id,now());}
    catch(error){throw storageError(error);}
  }
  function record(name,value) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name),timestamp=now(),data=candidate(id,value,timestamp);
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decode(read.get(id.nameKey),id,timestamp);
      if(!previous && count.get().n>=maxRecords)throw capacity();
      upsert.run(id.nameKey,id.characterName,data.score,data.role,data.modelVersion,data.recordedAt,digest(data));
      const maximum=decode(read.get(id.nameKey),id,timestamp);
      db.exec('COMMIT');transaction=false;return maximum;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  return {get,record,close(){if(closed)return;closed=true;db.close();}};
}
