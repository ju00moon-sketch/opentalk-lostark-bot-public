import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeCharacter} from './character-profile.js';

export const BRACELET_VALUE_RECORD_POLICY = 'bracelet-three-reconversion-v2:bounded-combat-v1:log2sd-v1';
export const BRACELET_T3_VALUE_RECORD_POLICY = 'bracelet-t3-no-reconversion-v1:bounded-combat-v1:log2sd-v1';
const APPLICATION_ID = 0x4f544256;
const FILE_LIMIT = 64 * 1024 * 1024;
const FIELDS = ['costExpectedGold','recordedAt','basePriceGold','expectedStartingBracelets',
  'successProbability','expectedReconversionTicketsUntilSuccess'];
const TABLE_SQL = `CREATE TABLE bracelet_value_records (
  name_key TEXT NOT NULL, target_key TEXT NOT NULL, policy_version TEXT NOT NULL,
  character_name TEXT NOT NULL, cost_expected_gold REAL NOT NULL CHECK(cost_expected_gold>0),
  recorded_at INTEGER NOT NULL CHECK(recorded_at>=0), base_price_gold REAL NOT NULL CHECK(base_price_gold>0),
  expected_starting_bracelets REAL NOT NULL CHECK(expected_starting_bracelets>=1),
  success_probability REAL NOT NULL CHECK(success_probability>0 AND success_probability<=1),
  expected_reconversion_tickets REAL NOT NULL CHECK(expected_reconversion_tickets>=0),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64),
  PRIMARY KEY(name_key,target_key,policy_version)
) STRICT`;
const unavailable = () => Object.assign(new Error('Bracelet record storage is unavailable'),{code:'bracelet_record_unavailable'});
const capacity = () => Object.assign(new Error('Bracelet record capacity reached'),{code:'bracelet_record_capacity'});
const finite = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER;
const equal = (a,b) => Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function identity(name,targetKey,policyVersion) {
  const characterName=normalizeCharacter(name);
  if(!characterName || typeof targetKey!=='string' || !/^[a-f0-9]{64}$/.test(targetKey) ||
      typeof policyVersion!=='string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(policyVersion)) throw unavailable();
  return {characterName,nameKey:characterName.toLowerCase(),targetKey,policyVersion};
}
function candidate(id,value,timestamp) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==FIELDS.length ||
      Object.keys(value).some(key=>!FIELDS.includes(key)) || !FIELDS.every(key=>finite(value[key])) ||
      !Number.isSafeInteger(timestamp) || timestamp<0 || !Number.isSafeInteger(value.recordedAt) || value.recordedAt>timestamp ||
      value.costExpectedGold<=0 || value.basePriceGold<=0 || value.expectedStartingBracelets<1 ||
      value.successProbability<=0 || value.successProbability>1 ||
      !equal(value.successProbability*value.expectedStartingBracelets,1) ||
      !equal(value.costExpectedGold,value.basePriceGold*value.expectedStartingBracelets) ||
      value.expectedReconversionTicketsUntilSuccess>value.expectedStartingBracelets*3) throw unavailable();
  return {characterName:id.characterName,targetKey:id.targetKey,policyVersion:id.policyVersion,
    ...Object.fromEntries(FIELDS.map(key=>[key,value[key]]))};
}
function storageError(error) {
  return error?.code==='bracelet_record_capacity' || error?.errcode===13 ? capacity() : unavailable();
}

/** Durable maxima, separate from both membership state and disposable display snapshots. */
export function createBraceletValueRecordStore(path,{now=Date.now,maxRecords=100000,maxFileBytes=FILE_LIMIT}={}) {
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
    if(!fresh && !(version===1 && app===APPLICATION_ID && objects.length===1 &&
        objects[0].type==='table' && objects[0].name==='bracelet_value_records' && objects[0].sql===TABLE_SQL)) throw unavailable();
    // Inspect provenance before altering permissions, schema, or journal settings.
    chmodSync(path,0o600);
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(maxFileBytes/pageSize)};`);
    if(fresh){db.exec('BEGIN IMMEDIATE');try{db.exec(`${TABLE_SQL}; PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);}catch(error){db.exec('ROLLBACK');throw error;}}
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw unavailable();
  } catch(error) {try{db?.close();}catch{}throw storageError(error);}

  let closed=false;
  const read=db.prepare('SELECT * FROM bracelet_value_records WHERE name_key=? AND target_key=? AND policy_version=?');
  const count=db.prepare('SELECT COUNT(*) AS n FROM bracelet_value_records');
  const upsert=db.prepare(`INSERT INTO bracelet_value_records VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(name_key,target_key,policy_version) DO UPDATE SET
    character_name=excluded.character_name,cost_expected_gold=excluded.cost_expected_gold,
    recorded_at=excluded.recorded_at,base_price_gold=excluded.base_price_gold,
    expected_starting_bracelets=excluded.expected_starting_bracelets,success_probability=excluded.success_probability,
    expected_reconversion_tickets=excluded.expected_reconversion_tickets,record_sha256=excluded.record_sha256
    WHERE excluded.cost_expected_gold>bracelet_value_records.cost_expected_gold`);
  function decode(row,id,timestamp) {
    if(!row)return null;
    const storedId=identity(row.character_name,row.target_key,row.policy_version);
    if(row.name_key!==id.nameKey || storedId.nameKey!==id.nameKey || storedId.targetKey!==id.targetKey || storedId.policyVersion!==id.policyVersion)throw unavailable();
    const data=candidate(storedId,{costExpectedGold:row.cost_expected_gold,recordedAt:row.recorded_at,
      basePriceGold:row.base_price_gold,expectedStartingBracelets:row.expected_starting_bracelets,
      successProbability:row.success_probability,expectedReconversionTicketsUntilSuccess:row.expected_reconversion_tickets},timestamp);
    if(row.record_sha256!==digest(data))throw unavailable();
    return data;
  }
  function get(name,targetKey,policyVersion) {
    try{if(closed)throw unavailable();const id=identity(name,targetKey,policyVersion);return decode(read.get(id.nameKey,id.targetKey,id.policyVersion),id,now());}
    catch(error){throw storageError(error);}
  }
  function record(name,targetKey,policyVersion,value) {
    let transaction=false;
    try {
      if(closed)throw unavailable();
      const id=identity(name,targetKey,policyVersion),timestamp=now(),data=candidate(id,value,timestamp);
      db.exec('BEGIN IMMEDIATE');transaction=true;
      const previous=decode(read.get(id.nameKey,id.targetKey,id.policyVersion),id,timestamp);
      if(!previous && count.get().n>=maxRecords)throw capacity();
      upsert.run(id.nameKey,id.targetKey,id.policyVersion,id.characterName,data.costExpectedGold,data.recordedAt,
        data.basePriceGold,data.expectedStartingBracelets,data.successProbability,data.expectedReconversionTicketsUntilSuccess,digest(data));
      const maximum=decode(read.get(id.nameKey,id.targetKey,id.policyVersion),id,timestamp);
      db.exec('COMMIT');transaction=false;return maximum;
    } catch(error){if(transaction)try{db.exec('ROLLBACK');}catch{}throw storageError(error);}
  }
  return {get,record,close(){if(closed)return;closed=true;db.close();}};
}
