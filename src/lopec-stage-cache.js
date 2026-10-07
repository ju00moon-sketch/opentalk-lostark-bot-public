import { createHash } from 'node:crypto';

// 원본 계산기와 현재 호출부를 검토한 묶음에만 적용한다. 외부 코드가 바뀌면 원본 계산으로 돌아간다.
const VERIFIED_RUNTIME_SHA256 = new Set([
  'c3f2b870a99967411d4adddc7668af280b6aacc0731491223523eb1e091b3994',
  'd497946a5889554bd73b3ae02ef7299e62af9509a1e7c4a71302ec93c3cb111c',
]);

// 이 함수는 격리된 계산기에 소스로 전달된다. 같은 평가의 단계 비용만 보관하며 외부 상태를 사용하지 않는다.
export function createStageCostMemo() {
  let costs = new Map();
  function keyFor(input) {
    const seen = new Set();
    let visited = 0;
    function encode(value, depth) {
      if (++visited > 5000 || depth > 20) throw new Error('Unsupported input');
      if (value === null) return 'null';
      const type = typeof value;
      if (type === 'string' || type === 'boolean') return JSON.stringify(value);
      if (type === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return String(value);
      if (type !== 'object' || seen.has(value)) throw new Error('Unsupported input');
      const array = Array.isArray(value);
      const proto = Object.getPrototypeOf(value);
      if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('Unsupported input');
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) throw new Error('Unsupported input');
      if (array && (keys.length !== value.length + 1 || keys.some((key, index) => key !== (index === value.length ? 'length' : String(index))))) {
        throw new Error('Unsupported input');
      }
      seen.add(value);
      const parts = [];
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Unsupported input');
        parts.push(JSON.stringify(key) + ':' + encode(descriptor.value, depth + 1));
      }
      seen.delete(value);
      return (array ? 'array' : proto === null ? 'null-object' : 'object') + '{' + parts.join(',') + '}';
    }
    try {
      const key = encode(input, 0);
      return key.length <= 131072 ? key : null;
    } catch { return null; }
  }
  return {
    reset() { costs = new Map(); },
    run(solve, input) {
      const key = keyFor(input);
      if (key !== null && costs.has(key)) return { expectedCost: costs.get(key) };
      const result = solve(input);
      const cost = result?.expectedCost;
      // 검토한 호출부는 동결된 비용만 읽는다. 큰 상태 탐색 기록이나 가변 반환 객체는 공유하지 않는다.
      if (key !== null && costs.size < 512 && cost && typeof cost === 'object'
        && Object.isFrozen(cost) && cost.materials && Object.isFrozen(cost.materials)) costs.set(key, cost);
      return result;
    },
  };
}

export function withStageCostCache(script) {
  if (!VERIFIED_RUNTIME_SHA256.has(createHash('sha256').update(script).digest('hex'))) return script;
  const replacements = [
    ['const MODULES=', `const __stageCosts=(${createStageCostMemo.toString()})();\nconst MODULES=`],
    ['let f=(0,i.Pi)({tier:t,equipmentType:a,currentStage:l,', 'let f=__stageCosts.run(i.Pi,{tier:t,equipmentType:a,currentStage:l,'],
    ['const evaluate=(rawCandidates)=>{', 'const evaluate=(rawCandidates)=>{ __stageCosts.reset();'],
  ];
  if (replacements.some(([from]) => script.split(from).length !== 2)) return script;
  for (const [from, to] of replacements) script = script.replace(from, to);
  return script;
}
