import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './json-store.js';

export const MEAL_HISTORY_PATH = fileURLToPath(new URL('../meal-daily.json', import.meta.url));
export const menuKey = (menu) => menu.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const validMenu = (menu) => typeof menu === 'string' && menu.trim().length > 0 && menu.length <= 80
  && !/[\r\n<>@*#`\[\]{}—]|https?:\/\//i.test(menu);
const unique = (menus) => [...new Map(menus.map((menu) => [menuKey(menu), menu])).values()];

export function createMealHistory({ storePath = MEAL_HISTORY_PATH, log = console.error } = {}) {
  let cached = { date: null, menus: [] };
  let lastError = null;
  const warn = (reason) => {
    if (lastError !== reason) log(`[메뉴 추천] ${reason} — 당일 목록은 메모리에 보관합니다.`);
    lastError = reason;
  };
  function read(date) {
    let stored = null;
    let writable = true;
    try {
      const missing = Symbol('missing');
      stored = readJson(storePath, missing);
      if (stored === missing) stored = null;
      else if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || typeof stored.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(stored.date)
        || new Date(`${stored.date}T00:00:00Z`).toISOString().slice(0, 10) !== stored.date
        || !Array.isArray(stored.menus) || !stored.menus.every(validMenu)) {
        throw new Error('잘못된 메뉴 목록');
      }
      if (stored?.date > date) writable = false;
    } catch {
      stored = null;
      writable = false;
      warn('저장 목록을 읽지 못했습니다');
    }
    if (cached.date === null || cached.date < date) cached = { date, menus: [] };
    if (stored?.date > cached.date) cached = { date: stored.date, menus: [] };
    if (stored?.date === cached.date) cached.menus = unique([...stored.menus, ...cached.menus]);
    return writable;
  }
  return {
    get(date) {
      read(date);
      return cached.date === date ? [...cached.menus] : [];
    },
    add(date, menu) {
      if (!validMenu(menu)) throw new Error('잘못된 메뉴명');
      const writable = read(date);
      if (cached.date !== date) return;
      cached.menus = unique([...cached.menus, menu.trim()]);
      if (writable) {
        try {
          writeJsonAtomic(storePath, cached, { pretty: false });
          lastError = null;
        } catch {
          warn('추천 목록을 저장하지 못했습니다');
        }
      }
    },
  };
}
