import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeCharacter} from './character-profile.js';

// 원정대 단위 최고 기록 (README.md). `.roster-values.sqlite`가 "지금 장비의 값"을
// 들고 있다면 이 sidecar는 "이 원정대가 지금까지 보여 준 가장 높은 합"을 들고 있다: 기록 시점의 1720↑ 구성원 목록과
// 캐릭터마다의 평가 입력 사본을 함께 두어, 장비는 기록 시점 그대로 두고 값만 오늘 시세로 다시 매길 수 있게 한다.
// 기록은 스스로 만료되지 않으며, 손상·용량 초과는 계산값 0과 구분되도록 예외로 알린다.
export const ROSTER_RECORD_APPLICATION_ID = 0x4f545252;
export const ROSTER_RECORD_TABLE_SQL = `CREATE TABLE roster_value_records (
  anchor_key TEXT NOT NULL PRIMARY KEY, anchor_name TEXT NOT NULL, server_name TEXT NOT NULL,
  recorded_at INTEGER NOT NULL CHECK(recorded_at>=0), record_gold REAL NOT NULL CHECK(record_gold>=0),
  repriced_gold REAL CHECK(repriced_gold>=0), repriced_at INTEGER CHECK(repriced_at>=0),
  members_json TEXT NOT NULL, checked_at INTEGER NOT NULL CHECK(checked_at>=0),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64)
) STRICT`;
export const ROSTER_RECORD_INPUT_TABLE_SQL = `CREATE TABLE roster_value_record_inputs (
  anchor_key TEXT NOT NULL, name_key TEXT NOT NULL, character_name TEXT NOT NULL,
  target_key TEXT NOT NULL CHECK(length(target_key)=64), inputs_json TEXT NOT NULL,
  PRIMARY KEY(anchor_key,name_key)
) STRICT`;
const FILE_LIMIT = 64 * 1024 * 1024;
export const MEMBERS_LIMIT = 64 * 1024;
export const INPUTS_LIMIT = 256 * 1024;
export const RECORD_MEMBER_LIMIT = 100;
const RECORD_FIELDS = ['serverName','recordedAt','recordGold','members','inputs'];
const MEMBER_FIELDS = ['characterName','serverName','itemLevel','role','targetKey','status','knownGold'];
const INPUT_FIELDS = ['characterName','targetKey','inputs'];
const STATUSES = ['ok','partial','unavailable'];
const ROLES = ['dealer','support'];
const SERVER_NAME = /^[가-힣A-Za-z0-9]{1,30}$/;
const HASH = /^[a-f0-9]{64}$/;
const unavailable = () => Object.assign(new Error('Roster value storage is unavailable'),{code:'roster_value_unavailable'});
const capacity = () => Object.assign(new Error('Roster value capacity reached'),{code:'roster_value_capacity'});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER;
const level = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=10000;
const stamp = value => Number.isSafeInteger(value) && value>=0;
function identity(name) {
  const characterName=normalizeCharacter(name);
  if(!characterName) throw unavailable();
  return {characterName,nameKey:characterName.toLowerCase()};
}
// What is stored has to survive a round trip through JSON unchanged — the snapshot is replayed through the
// valuation exactly as written — and stay inside the size the column accepts.
function encodeJson(value,limit) {
  if(value===null || typeof value!=='object') throw unavailable();
  let text;
  try{text=JSON.stringify(value);}catch{throw unavailable();}
  if(typeof text!=='string' || Buffer.byteLength(text)>limit) throw capacity();
  let parsed;
  try{parsed=JSON.parse(text);}catch{throw unavailable();}
  if(JSON.stringify(parsed)!==text) throw unavailable();
  return text;
}
// Optional since 2026-09-23: the prices the member went without at the recorded moment, so a later re-pricing can
// refuse a replay that lost one (roster-values.js). A record written before then has no such field.
const UNPRICED_LIMIT = 256;
function unpriced(value) {
  if(value===null) return null;
  if(!Array.isArray(value) || value.length>UNPRICED_LIMIT ||
      value.some(key=>typeof key!=='string' || !key.length || key.length>200)) throw unavailable();
  return [...value];
}
function member(row) {
  const optional=row && typeof row==='object' && Object.hasOwn(row,'unpriced') ? 1 : 0;
  if(!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).length!==MEMBER_FIELDS.length+optional ||
      Object.keys(row).some(key=>!MEMBER_FIELDS.includes(key) && key!=='unpriced')) throw unavailable();
  const characterName=normalizeCharacter(row.characterName);
  if(!characterName || typeof row.serverName!=='string' || !SERVER_NAME.test(row.serverName) || !level(row.itemLevel) ||
      (row.role!==null && !ROLES.includes(row.role)) || typeof row.targetKey!=='string' || !HASH.test(row.targetKey) ||
      !STATUSES.includes(row.status) || !money(row.knownGold)) throw unavailable();
  return {characterName,serverName:row.serverName,itemLevel:row.itemLevel,role:row.role,
    targetKey:row.targetKey,status:row.status,knownGold:row.knownGold,...(optional?{unpriced:unpriced(row.unpriced)}:{})};
}
function input(row) {
  if(!row || typeof row!=='object' || Array.isArray(row) || Object.keys(row).length!==INPUT_FIELDS.length ||
      Object.keys(row).some(key=>!INPUT_FIELDS.includes(key))) throw unavailable();
  const characterName=normalizeCharacter(row.characterName);
  if(!characterName || typeof row.targetKey!=='string' || !HASH.test(row.targetKey) ||
      row.inputs===null || typeof row.inputs!=='object' || Array.isArray(row.inputs)) throw unavailable();
  return {characterName,nameKey:characterName.toLowerCase(),targetKey:row.targetKey,inputs:row.inputs};
}
function recordCandidate(id,value,timestamp) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==RECORD_FIELDS.length ||
      Object.keys(value).some(key=>!RECORD_FIELDS.includes(key)) ||
      typeof value.serverName!=='string' || !SERVER_NAME.test(value.serverName) ||
      !stamp(value.recordedAt) || !stamp(timestamp) || value.recordedAt>timestamp || !money(value.recordGold) ||
      !Array.isArray(value.members) || !value.members.length || value.members.length>RECORD_MEMBER_LIMIT ||
      !Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length>RECORD_MEMBER_LIMIT) throw unavailable();
  const members=value.members.map(member),inputs=value.inputs.map(input);
  const keys=members.map(row=>row.characterName.toLowerCase());
  if(new Set(keys).size!==keys.length) throw unavailable();
  const inputKeys=inputs.map(row=>row.nameKey);
  if(new Set(inputKeys).size!==inputKeys.length) throw unavailable();
  // A record is only useful when every member it counted can be priced again, so the two lists must match.
  if(inputKeys.length!==keys.length || keys.some(key=>!inputKeys.includes(key))) throw unavailable();
  return {anchorName:id.characterName,serverName:value.serverName,recordedAt:value.recordedAt,
    recordGold:value.recordGold,members,inputs};
}
function storageError(error) {
  return error?.code==='roster_value_capacity' || error?.errcode===13 ? capacity() : unavailable();
}

export function createRosterRecordStore(path,{now=Date.now,maxRecords=100000,maxFileBytes=FILE_LIMIT}={}) {
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
    const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()
      .sort((a,b)=>a.name.localeCompare(b.name));
    const fresh=version===0 && app===0 && objects.length===0;
    if(!fresh && !(version===1 && app===ROSTER_RECORD_APPLICATION_ID && objects.length===2 &&
        objects[0].type==='table' && objects[0].name==='roster_value_record_inputs' && objects[0].sql===ROSTER_RECORD_INPUT_TABLE_SQL &&
        objects[1].type==='table' && objects[1].name==='roster_value_records' && objects[1].sql===ROSTER_RECORD_TABLE_SQL)) throw unavailable();
    // Inspect provenance before altering permissions, schema, or journal settings.
    chmodSync(path,0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF;');
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(maxFileBytes/pageSize)};`);
    if(fresh){db.exec('BEGIN IMMEDIATE');try{db.exec(`${ROSTER_RECORD_TABLE_SQL}; ${ROSTER_RECORD_INPUT_TABLE_SQL}; PRAGMA application_id=${ROSTER_RECORD_APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);}catch(error){db.exec('ROLLBACK');throw error;}}
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw unavailable();
  } catch(error) {try{db?.close();}catch{}throw storageError(error);}

  let closed=false;
  const readRecord=db.prepare('SELECT * FROM roster_value_records WHERE anchor_key=?');
  const countRecords=db.prepare('SELECT COUNT(*) AS n FROM roster_value_records');
  const upsertRecord=db.prepare(`INSERT INTO roster_value_records VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(anchor_key) DO UPDATE SET anchor_name=excluded.anchor_name,server_name=excluded.server_name,
    recorded_at=excluded.recorded_at,record_gold=excluded.record_gold,repriced_gold=excluded.repriced_gold,
    repriced_at=excluded.repriced_at,members_json=excluded.members_json,checked_at=excluded.checked_at,
    record_sha256=excluded.record_sha256`);
  const repriceRecord=db.prepare('UPDATE roster_value_records SET repriced_gold=?,repriced_at=?,checked_at=?,record_sha256=? WHERE anchor_key=?');
  const readInputs=db.prepare('SELECT * FROM roster_value_record_inputs WHERE anchor_key=? ORDER BY name_key');
  const clearInputs=db.prepare('DELETE FROM roster_value_record_inputs WHERE anchor_key=?');
  const insertInput=db.prepare('INSERT INTO roster_value_record_inputs VALUES (?,?,?,?,?)');

  // The hash covers the stored text of the member list, so a row rewritten by hand cannot pass as computed.
  const fingerprint = (data,membersJson) => digest({anchorName:data.anchorName,serverName:data.serverName,
    recordedAt:data.recordedAt,recordGold:data.recordGold,repricedGold:data.repricedGold,repricedAt:data.repricedAt,
    members:membersJson});
  function decodeRecord(row,id) {
    if(!row)return null;
    const storedId=identity(row.anchor_name);
    if(row.anchor_key!==id.nameKey || storedId.nameKey!==id.nameKey)throw unavailable();
    let members;
    try{members=JSON.parse(row.members_json);}catch{throw unavailable();}
    if(!Array.isArray(members) || !members.length || members.length>RECORD_MEMBER_LIMIT)throw unavailable();
    const decoded=members.map(member);
    const data={anchorName:storedId.characterName,serverName:row.server_name,recordedAt:row.recorded_at,
      recordGold:row.record_gold,repricedGold:row.repriced_gold,repricedAt:row.repriced_at,members:decoded};
    if(typeof data.serverName!=='string' || !SERVER_NAME.test(data.serverName) || !stamp(data.recordedAt) || !money(data.recordGold) ||
        (data.repricedGold!==null && !money(data.repricedGold)) || (data.repricedAt!==null && !stamp(data.repricedAt)) ||
        (data.repricedGold===null)!==(data.repricedAt===null) || !stamp(row.checked_at))throw unavailable();
    if(row.record_sha256!==fingerprint(data,row.members_json))throw unavailable();
    return {...data,checkedAt:row.checked_at};
  }
  function getRecord(name) {
    try{if(closed)throw unavailable();const id=identity(name);return decodeRecord(readRecord.get(id.nameKey),id);}
    catch(error){throw storageError(error);}
  }
  // The per-character valuation inputs the record was measured with, ready to be priced again today.
  function getInputs(name) {
    try {
      if(closed)throw unavailable();
      const id=identity(name);
      const rows=readInputs.all(id.nameKey);
      const result=new Map();
      for(const row of rows) {
        const storedId=identity(row.character_name);
        if(row.anchor_key!==id.nameKey || row.name_key!==storedId.nameKey || typeof row.target_key!=='string' || !HASH.test(row.target_key))throw unavailable();
        let inputs;
        try{inputs=JSON.parse(row.inputs_json);}catch{throw unavailable();}
        if(inputs===null || typeof inputs!=='object' || Array.isArray(inputs))throw unavailable();
        result.set(storedId.nameKey,{characterName:storedId.characterName,targetKey:row.target_key,inputs});
      }
      return result;
    } catch(error){throw storageError(error);}
  }
  // A new record replaces the old one whole: the row and every input sheet of that anchor in one transaction,
  // so a record can never be read next to the inputs of the record it replaced.
  function putRecord(name,value) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name),timestamp=now(),data=recordCandidate(id,value,timestamp);
      const membersJson=encodeJson(data.members,MEMBERS_LIMIT);
      const inputsJson=data.inputs.map(row=>encodeJson(row.inputs,INPUTS_LIMIT));
      const stored={...data,repricedGold:null,repricedAt:null};
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decodeRecord(readRecord.get(id.nameKey),id);
      if(!previous && countRecords.get().n>=maxRecords)throw capacity();
      upsertRecord.run(id.nameKey,id.characterName,data.serverName,data.recordedAt,data.recordGold,null,null,
        membersJson,timestamp,fingerprint(stored,membersJson));
      clearInputs.run(id.nameKey);
      data.inputs.forEach((row,index)=>insertInput.run(id.nameKey,row.nameKey,row.characterName,row.targetKey,inputsJson[index]));
      const saved=decodeRecord(readRecord.get(id.nameKey),id);
      db.exec('COMMIT');transaction=false;return saved;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  // Today's price for the equipment the record froze. The record itself — its date, members and inputs — never moves.
  function updateRepriced(name,value) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name),timestamp=now();
      if(!value || typeof value!=='object' || Array.isArray(value) || !money(value.repricedGold) ||
          !stamp(value.repricedAt) || !stamp(timestamp) || value.repricedAt>timestamp)throw unavailable();
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decodeRecord(readRecord.get(id.nameKey),id);
      if(!previous){db.exec('COMMIT');transaction=false;return null;}
      const row=readRecord.get(id.nameKey);
      const next={...previous,repricedGold:value.repricedGold,repricedAt:value.repricedAt};
      repriceRecord.run(value.repricedGold,value.repricedAt,timestamp,fingerprint(next,row.members_json),id.nameKey);
      const saved=decodeRecord(readRecord.get(id.nameKey),id);
      db.exec('COMMIT');transaction=false;return saved;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  return {getRecord,getInputs,putRecord,updateRepriced,close(){if(closed)return;closed=true;db.close();}};
}
