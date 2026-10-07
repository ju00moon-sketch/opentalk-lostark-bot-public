import {parseTooltip,stripTags} from './tooltip.js';
import {BRACELET_T3_DATA as DATA,BRACELET_T3_EFFECTS as EFFECTS} from './bracelet-t3-data.js';

const statIds={힘:'base.mainStat',민첩:'base.mainStat',지능:'base.mainStat',체력:'base.vitality',치명:'combat.crit',특화:'combat.specialization',제압:'combat.domination',신속:'combat.swiftness',인내:'combat.endurance',숙련:'combat.expertise'};
const canonical=text=>text.normalize('NFC').replace(/\s+/g,'');
const tail=' (60레벨 초과 몬스터에게는 효과 감소)';
// Complete tooltip observations from the official armory. Unobserved variants remain unsupported.
// A probability row's color and the armory's label color identify the same low/middle/high grade.
const known=[
  {rarity:'ancient',id:'special.t3Precision',tier:2,color:'#CE43FC',text:'[정밀] 몬스터에게 공격 적중 시 치명타 적중이 4% 증가한다.'+tail},
  {rarity:'ancient',id:'special.t3Reversal',tier:1,color:'#00B5FF',text:'[반전] 생명력이 15% 이하일 경우 몬스터에게 피격 시 10초 후 체력 반전이 일어난다. (재사용 대기 시간 900초)'+tail},
  {rarity:'ancient',id:'special.t3Cycle',tier:1,color:'#00B5FF',text:"[순환] 몬스터에게 공격 적중 시 30초 동안 '순환' 효과를 획득한다. 해당 효과는 갱신되지 않는다. 순환 : 10초 간격으로 스킬 피해 3% 증가, 치명타 적중률 5% 증가, 치명타 피해 8% 증가 효과가 순차적으로 적용된다."+tail},
  {rarity:'ancient',id:'special.t3Superiority',tier:1,color:'#00B5FF',text:'[우월] 몬스터에게 공격 적중 시 주는 피해가 2% 증가한다.'+tail},
].map(row=>({...row,key:canonical(row.text)}));
const byId=new Map(EFFECTS.map(row=>[row.id,row]));
const unavailable=reason=>({status:'unavailable',reason});

export function readBraceletT3Input(item){
  if(!item||item.Type!=='팔찌'||typeof item.Tooltip!=='string'||item.Tooltip.length>131072)return unavailable('팔찌 정보가 없습니다.');
  const rarity=item.Grade==='고대'?'ancient':item.Grade==='유물'?'relic':null;
  const tooltip=parseTooltip(item.Tooltip);
  if(!rarity||!tooltip||typeof tooltip!=='object'||Array.isArray(tooltip))return unavailable('3티어 유물·고대 팔찌 정보를 확인할 수 없습니다.');
  const titles=Object.values(tooltip).filter(row=>row?.type==='ItemTitle');
  if(titles.length!==1||!/(?:^|\s|\()티어\s*3(?:\s|\)|$)/.test(stripTags(titles[0]?.value?.leftStr2)))return unavailable('3티어 유물·고대 팔찌를 지원합니다.');
  const parts=Object.values(tooltip).filter(row=>row?.type==='ItemPartBox'&&stripTags(row.value?.Element_000)==='팔찌 효과');
  const html=parts.length===1?parts[0]?.value?.Element_001:null;
  if(typeof html!=='string'||html.length>16000)return unavailable('팔찌 효과를 확인할 수 없습니다.');
  const markers=[...html.matchAll(/<img\b[^>]*\bemoticon_tooltip_bracelet_(locked|changeable)\b[^>]*>(?:<\/img>)?/gi)];
  if(!markers.length||markers.length>5||stripTags(html.slice(0,markers[0].index)))return unavailable('고정·부여 옵션을 구분할 수 없습니다.');
  const input={itemTier:3,rarity,fixed:[],granted:[],startingBraceletGold:null,reconversionTickets:0},target=[];
  for(let index=0;index<markers.length;index++){
    const marker=markers[index],fragment=html.slice(marker.index+marker[0].length,markers[index+1]?.index??html.length);
    const text=stripTags(fragment).replace(/\s+/g,' ').trim(),fixed=marker[1].toLowerCase()==='locked';
    if(!text||text.length>1000)return unavailable('팔찌 효과 문구가 올바르지 않습니다.');
    const match=/^(힘|민첩|지능|체력|치명|특화|제압|신속|인내|숙련)\s*\+((?:\d+|\d{1,3}(?:,\d{3})+))$/.exec(text);
    let entry,labelColor;
    if(match){
      entry={id:statIds[match[1]],value:Number(match[2].replaceAll(',',''))};
      const ranges=byId.get(entry.id).ranges[rarity];
      if(!Number.isSafeInteger(entry.value)||entry.value<ranges[0].min||entry.value>ranges.at(-1).max)return unavailable(`공식 3티어 수치 범위와 다른 옵션: ${text}`);
    }else{
      const row=known.find(row=>row.rarity===rarity&&row.key===canonical(text));
      const label=/^\s*\[\s*<FONT\b[^>]*\bCOLOR\s*=\s*['"](#[\da-f]{6})['"][^>]*>([^<]+)<\/FONT>\s*\]/i.exec(fragment);
      if(!row||!label||label[1].toUpperCase()!==row.color||label[2].trim()!==byId.get(row.id).label||(fixed&&!byId.get(row.id).fixedAllowed))return unavailable(`확인되지 않은 3티어 옵션 문구: ${text}`);
      entry={id:row.id,tier:row.tier};
      labelColor=row.color;
    }
    input[fixed?'fixed':'granted'].push(entry);target.push({fixed,text,...entry,...(labelColor?{labelColor}:{})});
  }
  if(![1,2].includes(input.fixed.length)||!DATA.grantedCounts[rarity].some(row=>row.count===input.granted.length))return unavailable('3티어 고정·부여 옵션 개수가 올바르지 않습니다.');
  const all=[...input.fixed,...input.granted];
  if(new Set(all.map(row=>row.id)).size!==all.length||Object.entries(DATA.categoryLimits).some(([category,limit])=>all.filter(row=>byId.get(row.id).category===category).length>limit))return unavailable('3티어 옵션 중복 또는 종류별 제한을 확인해 주세요.');
  return {status:'ok',itemTier:3,input,target};
}
