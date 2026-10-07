import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  if(['.git','node_modules','.venv','__pycache__'].includes(entry.name))return [];
  return entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)];
});}
let checked=0,failed=0;
for(const file of walk(root).filter(file=>/\.[cm]?js$/.test(file))){
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:20000});
  checked++;
  if(result.status!==0){failed++;console.error(path.relative(root,file)+': syntax check failed');console.error(result.stderr||result.error?.message||'Unknown failure');}
}
console.log(`${checked} JavaScript files checked; ${failed} failed.`);
process.exitCode=failed?1:0;
