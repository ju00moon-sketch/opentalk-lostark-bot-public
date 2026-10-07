import coreFacts from './data/gem-model-facts.json' with { type: 'json' };
import braceletTables from './data/bracelet-model.json' with { type: 'json' };

// Official ArkGrid slot names occasionally carry trailing or doubled spaces ("질서의 달 코어 : 불릿 무빙 ").
// Every table lookup uses the canonical single-spaced, trimmed name; the input object is never mutated.
export const normalizeCoreName = name => typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : name;

// Every core name the dealer model knows: the shared chaos cores, every class's order cores and the cores with
// speed or critical effect rows. The support score uses the same set to recognize a dealer core equipped on a
// supporter as a known core without a buff effect (2026-09-18).
export const DEALER_CORE_NAMES = new Set([...Object.keys(coreFacts.coreFinal), ...Object.values(coreFacts.classCores).flatMap(c => [...c.mainCore, ...c.starCore]),
  ...['coreSpeed', 'coreCritRate', 'coreCritDamage', 'coreCritFinal'].flatMap(k => Object.keys(braceletTables[k]))]);

// The official API reports an unequipped grid as `ArkGrid: null` or `{ Slots: null, Effects: null }`, and cores
// without any gem effect as `Effects: null`. Each explicit null is an empty collection (2026-09-18); a grid key
// that is missing altogether, or a collection that is neither null nor an array, is left as it is for the callers'
// own fail-closed checks. The returned copy also carries the normalized core names.
export function withNormalizedCores(raw) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(raw, 'ArkGrid')) return raw;
  const grid = raw.ArkGrid;
  if (grid !== null && (typeof grid !== 'object' || Array.isArray(grid))) return raw;
  const slots = grid === null || grid.Slots === null ? [] : grid.Slots;
  const effects = grid === null || grid.Effects === null ? [] : grid.Effects;
  const renamed = Array.isArray(slots) && slots.some(slot => typeof slot?.Name === 'string' && slot.Name !== normalizeCoreName(slot.Name));
  if (grid !== null && slots === grid.Slots && effects === grid.Effects && !renamed) return raw;
  const normalizedSlots = renamed ? slots.map(slot => slot && typeof slot === 'object' && typeof slot.Name === 'string' ? { ...slot, Name: normalizeCoreName(slot.Name) } : slot) : slots;
  return { ...raw, ArkGrid: { ...(grid ?? {}), Slots: normalizedSlots, Effects: effects } };
}
