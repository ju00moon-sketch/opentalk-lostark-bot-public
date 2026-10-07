import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeCharacter} from './character-profile.js';

// Durable 원정대 환산 가치 per character and per roster, so `/체급` can read a number instead of starting a
// calculation that takes tens of minutes. Rows are replaced by the newest calculation and never expire on
// their own; storage trouble is reported as unavailable so a caller can tell it apart from a computed zero.
export const ROSTER_VALUE_APPLICATION_ID = 0x4f545256;
export const ROSTER_VALUE_CHARACTER_TABLE_SQL = `CREATE TABLE roster_value_characters (
  name_key TEXT NOT NULL PRIMARY KEY, character_name TEXT NOT NULL, server_name TEXT NOT NULL,
  item_level REAL NOT NULL CHECK(item_level>=0), role TEXT CHECK(role IN ('dealer','support')),
  target_key TEXT NOT NULL CHECK(length(target_key)=64),
  equipment_updated_at INTEGER NOT NULL CHECK(equipment_updated_at>=0),
  status TEXT NOT NULL CHECK(status IN ('ok','partial','unavailable')),
  known_gold REAL NOT NULL CHECK(known_gold>=0), known_market_gold REAL NOT NULL CHECK(known_market_gold>=0),
  known_expected_gold REAL NOT NULL CHECK(known_expected_gold>=0), complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  unknown_items INTEGER NOT NULL CHECK(unknown_items>=0), aggregate_json TEXT NOT NULL,
  computed_at INTEGER NOT NULL CHECK(computed_at>=0), checked_at INTEGER NOT NULL CHECK(checked_at>=0),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64)
) STRICT`;
export const ROSTER_VALUE_ROSTER_TABLE_SQL = `CREATE TABLE roster_value_rosters (
  anchor_key TEXT NOT NULL PRIMARY KEY, anchor_name TEXT NOT NULL, server_name TEXT NOT NULL,
  members_json TEXT NOT NULL, checked_at INTEGER NOT NULL CHECK(checked_at>=0),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64)
) STRICT`;
const FILE_LIMIT = 64 * 1024 * 1024;
export const AGGREGATE_LIMIT = 64 * 1024;
export const ROSTER_MEMBER_LIMIT = 100;
const CHARACTER_FIELDS = ['serverName','itemLevel','role','targetKey','equipmentUpdatedAt','status','knownGold',
  'knownMarketGold','knownExpectedGold','complete','unknownItems','aggregate','computedAt'];
const ROSTER_FIELDS = ['serverName','members'];
const STATUSES = ['ok','partial','unavailable'];
const ROLES = ['dealer','support'];
const SERVER_NAME = /^[가-힣A-Za-z0-9]{1,30}$/;
const unavailable = () => Object.assign(new Error('Roster value storage is unavailable'),{code:'roster_value_unavailable'});
const capacity = () => Object.assign(new Error('Roster value capacity reached'),{code:'roster_value_capacity'});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER;
const level = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=10000;
function identity(name) {
  const characterName=normalizeCharacter(name);
  if(!characterName) throw unavailable();
  return {characterName,nameKey:characterName.toLowerCase()};
}
// The stored projection is replayed through aggregateRosterValuations, so it has to survive a round trip
// through JSON unchanged and stay inside the size the column accepts.
function encodeJson(value) {
  if(value===null || typeof value!=='object') throw unavailable();
  let text;
  try{text=JSON.stringify(value);}catch{throw unavailable();}
  if(typeof text!=='string' || Buffer.byteLength(text)>AGGREGATE_LIMIT) throw capacity();
  let parsed;
  try{parsed=JSON.parse(text);}catch{throw unavailable();}
  if(JSON.stringify(parsed)!==text) throw unavailable();
  return text;
}
function member(row) {
  if(!row || typeof row!=='object' || Array.isArray(row)) throw unavailable();
  const characterName=normalizeCharacter(row.characterName);
  if(!characterName || typeof row.serverName!=='string' || !SERVER_NAME.test(row.serverName) || !level(row.itemLevel)) throw unavailable();
  return {characterName,serverName:row.serverName,itemLevel:row.itemLevel};
}
function characterCandidate(id,value,timestamp) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==CHARACTER_FIELDS.length ||
      Object.keys(value).some(key=>!CHARACTER_FIELDS.includes(key)) ||
      typeof value.serverName!=='string' || !SERVER_NAME.test(value.serverName) || !level(value.itemLevel) ||
      (value.role!==null && !ROLES.includes(value.role)) ||
      typeof value.targetKey!=='string' || !/^[a-f0-9]{64}$/.test(value.targetKey) ||
      !Number.isSafeInteger(value.equipmentUpdatedAt) || value.equipmentUpdatedAt<0 ||
      !STATUSES.includes(value.status) || !money(value.knownGold) || !money(value.knownMarketGold) || !money(value.knownExpectedGold) ||
      typeof value.complete!=='boolean' || !Number.isSafeInteger(value.unknownItems) || value.unknownItems<0 || value.unknownItems>10000 ||
      value.aggregate===null || typeof value.aggregate!=='object' || Array.isArray(value.aggregate) ||
      !Number.isSafeInteger(timestamp) || timestamp<0 ||
      !Number.isSafeInteger(value.computedAt) || value.computedAt<0 || value.computedAt>timestamp) throw unavailable();
  return {characterName:id.characterName,serverName:value.serverName,itemLevel:value.itemLevel,role:value.role,
    targetKey:value.targetKey,equipmentUpdatedAt:value.equipmentUpdatedAt,status:value.status,knownGold:value.knownGold,
    knownMarketGold:value.knownMarketGold,knownExpectedGold:value.knownExpectedGold,complete:value.complete,
    unknownItems:value.unknownItems,aggregate:value.aggregate,computedAt:value.computedAt};
}
function rosterCandidate(id,value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==ROSTER_FIELDS.length ||
      Object.keys(value).some(key=>!ROSTER_FIELDS.includes(key)) ||
      typeof value.serverName!=='string' || !SERVER_NAME.test(value.serverName) ||
      !Array.isArray(value.members) || !value.members.length || value.members.length>ROSTER_MEMBER_LIMIT) throw unavailable();
  const members=value.members.map(member);
  const keys=members.map(row=>row.characterName.toLowerCase());
  if(new Set(keys).size!==keys.length || !keys.includes(id.nameKey)) throw unavailable();
  return {anchorName:id.characterName,serverName:value.serverName,members};
}
function storageError(error) {
  return error?.code==='roster_value_capacity' || error?.errcode===13 ? capacity() : unavailable();
}

export function createRosterValueRecordStore(path,{now=Date.now,maxCharacters=100000,maxRosters=100000,maxFileBytes=FILE_LIMIT}={}) {
  let db;
  try {
    if(typeof path!=='string' || !isAbsolute(path) || typeof now!=='function' ||
        !Number.isSafeInteger(maxCharacters) || maxCharacters<1 || maxCharacters>100000 ||
        !Number.isSafeInteger(maxRosters) || maxRosters<1 || maxRosters>100000 ||
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
    if(!fresh && !(version===1 && app===ROSTER_VALUE_APPLICATION_ID && objects.length===2 &&
        objects[0].type==='table' && objects[0].name==='roster_value_characters' && objects[0].sql===ROSTER_VALUE_CHARACTER_TABLE_SQL &&
        objects[1].type==='table' && objects[1].name==='roster_value_rosters' && objects[1].sql===ROSTER_VALUE_ROSTER_TABLE_SQL)) throw unavailable();
    // Inspect provenance before altering permissions, schema, or journal settings.
    chmodSync(path,0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(maxFileBytes/pageSize)};`);
    if(fresh){db.exec('BEGIN IMMEDIATE');try{db.exec(`${ROSTER_VALUE_CHARACTER_TABLE_SQL}; ${ROSTER_VALUE_ROSTER_TABLE_SQL}; PRAGMA application_id=${ROSTER_VALUE_APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);}catch(error){db.exec('ROLLBACK');throw error;}}
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw unavailable();
  } catch(error) {try{db?.close();}catch{}throw storageError(error);}

  let closed=false;
  const readCharacter=db.prepare('SELECT * FROM roster_value_characters WHERE name_key=?');
  const countCharacters=db.prepare('SELECT COUNT(*) AS n FROM roster_value_characters');
  const upsertCharacter=db.prepare(`INSERT INTO roster_value_characters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name_key) DO UPDATE SET
    character_name=excluded.character_name,server_name=excluded.server_name,item_level=excluded.item_level,
    role=excluded.role,target_key=excluded.target_key,equipment_updated_at=excluded.equipment_updated_at,
    status=excluded.status,known_gold=excluded.known_gold,known_market_gold=excluded.known_market_gold,
    known_expected_gold=excluded.known_expected_gold,complete=excluded.complete,unknown_items=excluded.unknown_items,
    aggregate_json=excluded.aggregate_json,computed_at=excluded.computed_at,checked_at=excluded.checked_at,
    record_sha256=excluded.record_sha256`);
  const touchCharacter=db.prepare('UPDATE roster_value_characters SET checked_at=? WHERE name_key=?');
  const readRoster=db.prepare('SELECT * FROM roster_value_rosters WHERE anchor_key=?');
  const countRosters=db.prepare('SELECT COUNT(*) AS n FROM roster_value_rosters');
  const upsertRoster=db.prepare(`INSERT INTO roster_value_rosters VALUES (?,?,?,?,?,?)
    ON CONFLICT(anchor_key) DO UPDATE SET anchor_name=excluded.anchor_name,server_name=excluded.server_name,
    members_json=excluded.members_json,checked_at=excluded.checked_at,record_sha256=excluded.record_sha256`);

  function decodeCharacter(row,id,timestamp) {
    if(!row)return null;
    const storedId=identity(row.character_name);
    if(row.name_key!==id.nameKey || storedId.nameKey!==id.nameKey)throw unavailable();
    let aggregate;
    try{aggregate=JSON.parse(row.aggregate_json);}catch{throw unavailable();}
    const data=characterCandidate(storedId,{serverName:row.server_name,itemLevel:row.item_level,role:row.role,
      targetKey:row.target_key,equipmentUpdatedAt:row.equipment_updated_at,status:row.status,knownGold:row.known_gold,
      knownMarketGold:row.known_market_gold,knownExpectedGold:row.known_expected_gold,complete:row.complete===1,
      unknownItems:row.unknown_items,aggregate,computedAt:row.computed_at},timestamp);
    if(row.record_sha256!==digest({...data,aggregate:row.aggregate_json}))throw unavailable();
    if(!Number.isSafeInteger(row.checked_at) || row.checked_at<0)throw unavailable();
    return {...data,checkedAt:row.checked_at};
  }
  function decodeRoster(row,id) {
    if(!row)return null;
    const storedId=identity(row.anchor_name);
    if(row.anchor_key!==id.nameKey || storedId.nameKey!==id.nameKey)throw unavailable();
    let members;
    try{members=JSON.parse(row.members_json);}catch{throw unavailable();}
    const data=rosterCandidate(storedId,{serverName:row.server_name,members});
    if(row.record_sha256!==digest({...data,members:row.members_json}))throw unavailable();
    if(!Number.isSafeInteger(row.checked_at) || row.checked_at<0)throw unavailable();
    return {...data,checkedAt:row.checked_at};
  }
  function getCharacter(name) {
    try{if(closed)throw unavailable();const id=identity(name);return decodeCharacter(readCharacter.get(id.nameKey),id,now());}
    catch(error){throw storageError(error);}
  }
  function recordCharacter(name,value) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name),timestamp=now(),data=characterCandidate(id,value,timestamp);
      const aggregateJson=encodeJson(data.aggregate);
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decodeCharacter(readCharacter.get(id.nameKey),id,timestamp);
      if(!previous && countCharacters.get().n>=maxCharacters)throw capacity();
      upsertCharacter.run(id.nameKey,id.characterName,data.serverName,data.itemLevel,data.role,data.targetKey,
        data.equipmentUpdatedAt,data.status,data.knownGold,data.knownMarketGold,data.knownExpectedGold,
        data.complete?1:0,data.unknownItems,aggregateJson,data.computedAt,timestamp,digest({...data,aggregate:aggregateJson}));
      const stored=decodeCharacter(readCharacter.get(id.nameKey),id,timestamp);
      db.exec('COMMIT');transaction=false;return stored;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  // A recalculation that would produce the same numbers only moves the freshness stamp.
  function touch(name) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name),timestamp=now();
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decodeCharacter(readCharacter.get(id.nameKey),id,timestamp);
      if(previous)touchCharacter.run(timestamp,id.nameKey);
      const stored=previous?decodeCharacter(readCharacter.get(id.nameKey),id,timestamp):null;
      db.exec('COMMIT');transaction=false;return stored;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  function getRoster(name) {
    try{if(closed)throw unavailable();const id=identity(name);return decodeRoster(readRoster.get(id.nameKey),id);}
    catch(error){throw storageError(error);}
  }
  function recordRoster(name,value) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name),timestamp=now(),data=rosterCandidate(id,value);
      if(!Number.isSafeInteger(timestamp) || timestamp<0)throw unavailable();
      const membersJson=encodeJson(data.members);
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decodeRoster(readRoster.get(id.nameKey),id);
      if(!previous && countRosters.get().n>=maxRosters)throw capacity();
      upsertRoster.run(id.nameKey,id.characterName,data.serverName,membersJson,timestamp,digest({...data,members:membersJson}));
      const stored=decodeRoster(readRoster.get(id.nameKey),id);
      db.exec('COMMIT');transaction=false;return stored;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  return {getCharacter,recordCharacter,touch,getRoster,recordRoster,close(){if(closed)return;closed=true;db.close();}};
}
