import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { GEM_PROCESSING_OUTCOMES, GEM_PROCESSING_MODEL, GEM_PROCESSING_STARTS, GEM_PROCESSING_SUBTYPES } from './data/arkgrid-gem-processing.js';
import precomputedTable from './data/gem-expectation-table.json' with { type: 'json' };

export const GEM_EXPECTATION_POLICY='at-least-target-one-refresh-v2';
export const GEM_EXPECTATION_MODEL=`${GEM_PROCESSING_MODEL.version}/${GEM_EXPECTATION_POLICY}`;
const ASSUMPTIONS=Object.freeze([
  '현재와 같은 효과 2종을 유지하면서 각 효과 레벨·의지력 효율·코어 포인트가 모두 현재 수치 이상인 결과를 목표로 합니다. 효과 행 순서는 구분하지 않습니다.',
  '각 시작 젬을 새로 구매하며 첫 가공은 항상 진행합니다. 이후 목표에 도달하면 즉시 완료하고, 남은 횟수로 도달할 수 없으면 포기합니다.',
  '첫 가공 이후 제시된 네 항목 중 목표까지의 평균 거리를 줄이는 항목이 없으면, 남은 무료 다른 항목 보기를 한 번 사용하고 다시 나온 항목으로 가공합니다.',
  '공식 표에서 효과 변경과 레벨 증감이 별도 항목이라는 정의에 따라, 효과 변경은 이름만 바꾸고 해당 칸의 레벨을 유지하는 모형 해석을 적용합니다.',
  '공개된 고정 가공 정책의 기댓값이며 최적 비용 또는 실제 지출 내역이 아닙니다.',
  '초기화·융합·재판매 회수는 사용하지 않으며 페온의 골드 환산은 제외합니다. 같은 개당 구매가로 반복 구매할 수 있다고 가정합니다.',
]);
const unavailable=reason=>({status:'unavailable',reason,totalExpectedGold:null});
const STARTING_GRADES=Object.freeze(['희귀','영웅']);

const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const groupedMemo=new Map();
function groupedDraw(totalWeight,counts){
  const groups=[...counts].sort((a,b)=>a[0]-b[0]);
  const key=`${totalWeight}|${groups.map(row=>row.join(':')).join(',')}`;
  if(groupedMemo.has(key))return groupedMemo.get(key);
  const selected=new Uint8Array(groups.length), applied=new Float64Array(groups.length);let probability=0;
  function visit(depth,weight,p){
    if(depth===4){probability+=p;for(let i=0;i<groups.length;i++)applied[i]+=p*selected[i]/(4*groups[i][1]);return;}
    for(let i=0;i<groups.length;i++){
      const [w,count]=groups[i],remaining=count-selected[i];if(!remaining)continue;
      selected[i]++;visit(depth+1,weight+w,p*remaining*w/(totalWeight-weight));selected[i]--;
    }
  }
  if(groups.reduce((sum,row)=>sum+row[1],0)>=4)visit(0,0,1);
  const result={probability,byWeight:new Map(groups.map((row,index)=>[row[0],applied[index]]))};
  if(groupedMemo.size>=20000)groupedMemo.clear();groupedMemo.set(key,result);return result;
}

// Exact weighted-without-replacement offers, then uniform choice of one of four.
// A rejected offer has no favorable outcome. Its joint marginals retain the
// original full-pool denominator, rather than renormalizing the rejected pool.
export function calculateGemOfferKernel(candidates,favorableIds=[]){
  if(!Array.isArray(candidates)||candidates.length<4||candidates.length>27||
    Array.from(candidates).some(row=>!row||typeof row.id!=='string'||!row.id||!integer(row.weight,1,10000))||
    new Set(candidates.map(row=>row.id)).size!==candidates.length||!Array.isArray(favorableIds)||
    favorableIds.some(id=>!candidates.some(row=>row.id===id)))throw new RangeError('Invalid offer');
  const favorable=new Set(favorableIds),all=new Map(),bad=new Map();let total=0;
  for(const row of candidates){total+=row.weight;all.set(row.weight,(all.get(row.weight)||0)+1);
    if(!favorable.has(row.id))bad.set(row.weight,(bad.get(row.weight)||0)+1);}
  const base=groupedDraw(total,all),rejected=groupedDraw(total,bad);
  return {rejectedProbability:rejected.probability,outcomes:candidates.map(row=>({id:row.id,
    probability:base.byWeight.get(row.weight),rejectedJointProbability:favorable.has(row.id)?0:(rejected.byWeight.get(row.weight)||0)}))};
}

const PAIRS=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
const pairIndex=(a,b)=>PAIRS.findIndex(pair=>pair[0]===a&&pair[1]===b);
const encodePoints=points=>points.reduce((sum,value,index)=>sum+(value-1)*5**index,0);
const decodePoints=code=>[0,1,2,3].map(index=>Math.floor(code/5**index)%5+1);
const encodeBase=(points,pair,cost)=>(encodePoints(points)*6+pair)*3+cost+1;
const BASE_COUNT=625*6*3;
function minimumSteps(points,effects,target){
  const delta=(current,goal)=>Number(current<goal);
  const head=delta(points[0],target[0])+delta(points[1],target[1]);
  return head+Math.min(delta(points[2],target[2])+delta(points[3],target[3])+Number(effects[0]!==0)+Number(effects[1]!==1),
    delta(points[2],target[3])+delta(points[3],target[2])+Number(effects[0]!==1)+Number(effects[1]!==0));
}
function targetDistance(points,effects,target){
  const deficit=(current,goal)=>Math.max(0,goal-current);
  const head=deficit(points[0],target[0])+deficit(points[1],target[1]);
  return head+Math.min(deficit(points[2],target[2])+deficit(points[3],target[3])+Number(effects[0]!==0)+Number(effects[1]!==1),
    deficit(points[2],target[3])+deficit(points[3],target[2])+Number(effects[0]!==1)+Number(effects[1]!==0));
}

// Dimensionless finite-horizon kernel. The public worker wrapper supplies only
// verified start facts. The explicit level rule prevents an unverified effect
// transition from silently becoming a completed cost calculation.
export function solveGemExpectationKernel({target,attempts,rerolls,effectLevelRule}){
  if(!Array.isArray(target)||target.length!==4||Array.from(target).some(value=>!integer(value,1,5))||
    !integer(attempts,1,9)||!integer(rerolls,0,2)||effectLevelRule!=='preserve')throw new RangeError('Unverified processing model');
  target=[target[0],target[1],...target.slice(2).sort((a,b)=>a-b)];
  const width=rerolls+2*attempts+1,size=BASE_COUNT*width;
  let current=new Float64Array(size),next=new Float64Array(size);
  for(let pair=0;pair<6;pair++)current[encodeBase([1,1,1,1],pair,0)*width+rerolls]=1/6;
  const geometry=new Array(BASE_COUNT),kernels=[new Array(BASE_COUNT),new Array(BASE_COUNT)];
  let successProbability=0,processingGoldUnits=0,processingCount=0,rerollCount=0,failedProbability=0,visitedStates=0;
  const getGeometry=base=>{
    if(geometry[base])return geometry[base];
    const cost=base%3-1,pair=Math.floor(base/3)%6,points=decodePoints(Math.floor(base/18)),effects=PAIRS[pair];
    return geometry[base]={cost,pair,points,effects,distance:targetDistance(points,effects,target),minimum:minimumSteps(points,effects,target)};
  };
  function transitions(base,last){
    const memo=kernels[Number(last)];if(memo[base])return memo[base];
    const state=getGeometry(base),candidates=[],branches=[],favorable=[];
    for(const outcome of GEM_PROCESSING_OUTCOMES){
      if(outcome.kind==='axis'&&(state.points[outcome.axis]+outcome.delta<1||state.points[outcome.axis]+outcome.delta>5))continue;
      if(outcome.kind==='cost'&&(last||state.cost===outcome.delta))continue;
      if(outcome.kind==='reroll'&&last)continue;
      const options=[];
      if(outcome.kind==='effect'){
        for(let effect=0;effect<4;effect++)if(!state.effects.includes(effect)){
          const points=[...state.points],effects=[...state.effects];effects[outcome.effectIndex]=effect;
          if(effects[0]>effects[1]){effects.reverse();[points[2],points[3]]=[points[3],points[2]];}
          options.push({base:encodeBase(points,pairIndex(...effects),state.cost),probability:.5,extraRerolls:0,
            distance:targetDistance(points,effects,target)});
        }
      }else{
        const points=[...state.points];if(outcome.kind==='axis')points[outcome.axis]+=outcome.delta;
        const cost=state.cost+(outcome.kind==='cost'?outcome.delta:0);
        options.push({base:encodeBase(points,state.pair,cost),probability:1,extraRerolls:outcome.kind==='reroll'?outcome.delta:0,
          distance:targetDistance(points,state.effects,target)});
      }
      candidates.push(outcome);branches.push(options);
      if(options.reduce((sum,row)=>sum+row.distance*row.probability,0)<state.distance)favorable.push(outcome.id);
    }
    const offer=calculateGemOfferKernel(candidates,favorable),rows=[];
    offer.outcomes.forEach((outcome,index)=>{for(const branch of branches[index])rows.push({base:branch.base,extraRerolls:branch.extraRerolls,
      probability:outcome.probability*branch.probability,
      acceptedProbability:(outcome.probability-outcome.rejectedJointProbability)*branch.probability});});
    return memo[base]={rows,rejectedProbability:offer.rejectedProbability};
  }
  for(let processed=0;processed<=attempts;processed++){
    const remaining=attempts-processed;next.fill(0);
    for(let base=0;base<BASE_COUNT;base++){
      let state,kernel;
      for(let r=0;r<width;r++){
        const mass=current[base*width+r];if(mass===0)continue;visitedStates++;state??=getGeometry(base);
        if(processed>0&&state.distance===0){successProbability+=mass;continue;}
        if(remaining===0||(processed>0&&state.minimum>remaining)){failedProbability+=mass;continue;}
        processingGoldUnits+=mass*(1+state.cost);processingCount+=mass;
        kernel??=transitions(base,remaining===1);
        const refresh=processed>0&&r>0;
        if(refresh)rerollCount+=mass*kernel.rejectedProbability;
        for(const row of kernel.rows){
          if(refresh){
            next[row.base*width+r+row.extraRerolls]+=mass*row.acceptedProbability;
            next[row.base*width+r-1+row.extraRerolls]+=mass*kernel.rejectedProbability*row.probability;
          }else next[row.base*width+r+row.extraRerolls]+=mass*row.probability;
        }
      }
    }
    [current,next]=[next,current];
  }
  return {successProbability,processingGoldUnits,processingCount,rerollCount,failedProbability,visitedStates};
}

function normalizeTarget(target){
  if(!target||typeof target!=='object'||Array.isArray(target)||target.status!=='ok'||target.completed!==true||
    target.source!=='official-arkgrid-gem-tooltip'||typeof target.subtype!=='string'||!Object.hasOwn(GEM_PROCESSING_SUBTYPES,target.subtype))return null;
  const rule=GEM_PROCESSING_SUBTYPES[target.subtype];
  if(target.typeName!==rule.family||target.type!==(rule.family==='질서'?'order':'chaos')||
    target.name!==`${rule.family}의 젬 : ${target.subtype}`||target.baseWillpower!==rule.baseWillpower||
    !integer(target.willpowerEfficiency,1,5)||!integer(target.corePoints,1,5)||
    target.willpower!==rule.baseWillpower-target.willpowerEfficiency||!Array.isArray(target.options)||target.options.length!==2||
    Array.from(target.options).some(row=>!row||!rule.effects.includes(row.name)||!integer(row.level,1,5))||
    target.options[0].name===target.options[1].name)return null;
  const points=[target.willpowerEfficiency,target.corePoints,...target.options.map(row=>row.level).sort((a,b)=>a-b)];
  const total=points.reduce((a,b)=>a+b,0),grade=total>=19?'고대':total>=16?'유물':'전설';
  return target.points===total&&target.grade===grade?points:null;
}

function safeResult(result){
  return result&&['successProbability','processingGoldUnits','processingCount','rerollCount','failedProbability','visitedStates']
    .every(key=>typeof result[key]==='number'&&Number.isFinite(result[key])&&result[key]>=0)&&
    result.successProbability>0&&result.successProbability<=1&&Math.abs(result.successProbability+result.failedProbability-1)<1e-8;
}

// A single reusable CPU worker per service. Queue and cache keys contain only
// normalized public target axes; names of equivalent effects/subtypes are
// exchangeable under the official equal effect probabilities.
// Every reachable key is also precomputed in data/gem-expectation-table.json
// (scripts/build-gem-expectation-table.mjs); the worker only runs for keys the
// table lacks, so a first valuation no longer waits on the CPU-limited service.
export function createGemExpectationSolver({timeoutMs=12000,maxQueued=64,maxCached=128,precomputed=precomputedTable}={}){
  if(!integer(timeoutMs,1,30000)||!integer(maxQueued,1,128)||!integer(maxCached,1,512))throw new RangeError('Invalid solver limits');
  const table=precomputed&&typeof precomputed==='object'&&precomputed.model===GEM_EXPECTATION_MODEL&&
    precomputed.entries&&typeof precomputed.entries==='object'&&!Array.isArray(precomputed.entries)?precomputed.entries:null;
  let worker=null,active=null,closed=false,sequence=0;
  const queue=[],inflight=new Map(),cache=new Map();
  function stopWorker(){const current=worker;worker=null;if(current){current.removeAllListeners();void current.terminate();}}
  function finish(job,result){
    if(!inflight.has(job.key))return;
    clearTimeout(job.timer);inflight.delete(job.key);
    if(active===job)active=null;
    else {const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);}
    if(result.status==='ok'){cache.delete(job.key);cache.set(job.key,result);while(cache.size>maxCached)cache.delete(cache.keys().next().value);}
    job.resolve(result);dispatch();
  }
  function dispatch(){
    if(closed||active)return;
    const job=queue.shift();if(!job){worker?.unref();return;}
    active=job;
    if(!worker){
      try{
        worker=new Worker(new URL(import.meta.url),{workerData:{role:'gem-expectation'},env:{},execArgv:[],
          resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
        worker.on('message',message=>{
          const current=active;if(!current||message?.id!==current.id)return;
          finish(current,safeResult(message.result)?{status:'ok',...message.result}:unavailable('calculation_failed'));
        });
        const lost=()=>{const current=active;stopWorker();if(current)finish(current,unavailable('calculation_failed'));};
        worker.on('error',lost);worker.on('exit',lost);
      }catch{stopWorker();finish(job,unavailable('calculation_failed'));return;}
    }
    worker.ref();worker.postMessage({id:job.id,input:job.input});
  }
  function run(key,input){
    if(cache.has(key)){const value=cache.get(key);cache.delete(key);cache.set(key,value);return Promise.resolve(value);}
    const stored=table?.[key.slice(GEM_EXPECTATION_MODEL.length+1)];
    if(stored&&safeResult(stored))return Promise.resolve({status:'ok',...stored});
    if(inflight.has(key))return inflight.get(key).promise;
    if(inflight.size>=maxQueued+1)return Promise.resolve(unavailable('calculation_busy'));
    let resolve;const promise=new Promise(done=>resolve=done),job={id:++sequence,key,input,promise,resolve};
    job.timer=setTimeout(()=>{if(active===job)stopWorker();finish(job,unavailable('calculation_timeout'));},timeoutMs);
    inflight.set(key,job);queue.push(job);dispatch();return promise;
  }
  function observe(promise,signal){
    if(!signal)return promise;
    if(signal.aborted)return Promise.resolve(unavailable('calculation_cancelled'));
    return new Promise(resolve=>{
      const abort=()=>{signal.removeEventListener('abort',abort);resolve(unavailable('calculation_cancelled'));};
      signal.addEventListener('abort',abort,{once:true});
      promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value);});
    });
  }
  async function getExpectedGemCost(target,{grade='영웅',purchaseGold,signal}={}){
    if(closed)return unavailable('solver_closed');
    if(signal!==undefined&&!(signal instanceof AbortSignal))return unavailable('invalid_request');
    if(signal?.aborted)return unavailable('calculation_cancelled');
    const points=normalizeTarget(target);
    if(!points||typeof purchaseGold!=='number'||!Number.isFinite(purchaseGold)||purchaseGold<=0||purchaseGold>1e12)return unavailable('invalid_request');
    if(!['영웅','희귀'].includes(grade))return unavailable('starting_grade_unavailable');
    const start=GEM_PROCESSING_STARTS[grade];
    if(!integer(start.attempts,1,9)||!integer(start.rerolls,0,2)||!integer(start.baseGold,1,1000000))return unavailable('starting_grade_unavailable');
    const key=`${GEM_EXPECTATION_MODEL}|${grade}|${points.join(',')}`;
    const result=await observe(run(key,{target:points,attempts:start.attempts,rerolls:start.rerolls,effectLevelRule:'preserve'}),signal);
    if(closed)return unavailable('solver_closed');
    if(result.status!=='ok')return result;
    const count=1/result.successProbability,purchase=purchaseGold*count,processing=start.baseGold*result.processingGoldUnits*count;
    return {status:'ok',modelVersion:GEM_EXPECTATION_MODEL,policyVersion:GEM_EXPECTATION_POLICY,comparison:'at-least',
      startingGrade:grade,purchaseGold,baseProcessingGold:start.baseGold,successProbability:result.successProbability,
      expectedStartingGems:count,expectedProcessingCount:result.processingCount*count,expectedRerolls:result.rerollCount*count,
      purchaseExpectedGold:purchase,processingExpectedGold:processing,totalExpectedGold:purchase+processing,
      assumptions:[...ASSUMPTIONS]};
  }
  async function getBestExpectedGemCost(target,{purchaseGoldByGrade,signal}={}){
    if(closed)return unavailable('solver_closed');
    if(signal!==undefined&&!(signal instanceof AbortSignal))return unavailable('invalid_request');
    if(signal?.aborted)return unavailable('calculation_cancelled');
    if(!normalizeTarget(target)||!purchaseGoldByGrade||typeof purchaseGoldByGrade!=='object'||Array.isArray(purchaseGoldByGrade)||
      Object.keys(purchaseGoldByGrade).some(grade=>!STARTING_GRADES.includes(grade))||
      STARTING_GRADES.some(grade=>Object.hasOwn(purchaseGoldByGrade,grade)&&purchaseGoldByGrade[grade]!=null&&
        (typeof purchaseGoldByGrade[grade]!=='number'||!Number.isFinite(purchaseGoldByGrade[grade])||purchaseGoldByGrade[grade]<=0||purchaseGoldByGrade[grade]>1e12)))return unavailable('invalid_request');
    const alternatives=await Promise.all(STARTING_GRADES.map(async grade=>{
      const price=Object.hasOwn(purchaseGoldByGrade,grade)?purchaseGoldByGrade[grade]:null;
      if(price==null)return {...unavailable('missing_quote'),startingGrade:grade};
      return {...await getExpectedGemCost(target,{grade,purchaseGold:price,signal}),startingGrade:grade};
    }));
    if(closed)return unavailable('solver_closed');
    if(signal?.aborted)return unavailable('calculation_cancelled');
    const available=alternatives.filter(result=>result.status==='ok');
    const selected=available.reduce((best,result)=>!best||result.totalExpectedGold<best.totalExpectedGold?result:best,null);
    const comparison={modelVersion:GEM_EXPECTATION_MODEL,policyVersion:GEM_EXPECTATION_POLICY,comparison:'at-least',
      selection:'minimum-of-available-starting-grades',comparisonComplete:available.length===STARTING_GRADES.length,
      availableGrades:available.map(result=>result.startingGrade),alternatives,selected};
    return selected?{status:'ok',...comparison,totalExpectedGold:selected.totalExpectedGold}
      :{...unavailable(alternatives.every(result=>result.reason==='missing_quote')?'starting_prices_unavailable':'grade_comparison_unavailable'),...comparison};
  }
  return {getExpectedGemCost,getBestExpectedGemCost,close(){
    if(closed)return;closed=true;stopWorker();
    for(const job of inflight.values()){clearTimeout(job.timer);job.resolve(unavailable('solver_closed'));}
    inflight.clear();queue.length=0;cache.clear();active=null;
  }};
}

export function createGemExpectationService(options){
  const solver=createGemExpectationSolver(options);
  return {get:solver.getExpectedGemCost,getBest:solver.getBestExpectedGemCost,close:solver.close};
}

let defaultSolver;
export function getExpectedGemCost(target,options){defaultSolver??=createGemExpectationSolver();return defaultSolver.getExpectedGemCost(target,options);}
export function getBestExpectedGemCost(target,options){defaultSolver??=createGemExpectationSolver();return defaultSolver.getBestExpectedGemCost(target,options);}
export function closeGemExpectationSolver(){defaultSolver?.close();defaultSolver=undefined;}

if(!isMainThread&&workerData?.role==='gem-expectation'){
  parentPort.on('message',({id,input})=>{
    try{parentPort.postMessage({id,result:solveGemExpectationKernel(input)});}
    catch{parentPort.postMessage({id,result:null});}
  });
}
