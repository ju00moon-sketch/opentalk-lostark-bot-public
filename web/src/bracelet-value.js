import { createHash } from 'node:crypto';
import { GuildError } from './guild-store.js';
import { normalizeCharacter } from './character-profile.js';
import { buildBaseBraceletSearchPlan, normalizeBaseBraceletAuction, estimateBaseBraceletPrice } from '../../src/bracelet-base-price.js';
import { buildBraceletReplacementPlan, normalizeBraceletReplacementAuction, BRACELET_REPLACEMENT_MODEL } from '../../src/bracelet-replacement-search.js';
import { SPECIAL_MAX } from '../../src/bracelet-search.js';
import { BRACELET_VALUE_RECORD_POLICY,BRACELET_T3_VALUE_RECORD_POLICY } from './bracelet-value-record-store.js';

const API = 'https://developer-lostark.game.onstove.com/auctions/items';
const MAX_BYTES = 512 * 1024;
const unavailable = () => new GuildError(502, 'bracelet_value_unavailable');
const limited = () => new GuildError(429, 'bracelet_value_rate_limited');
const closedError = () => new GuildError(503, 'bracelet_value_unavailable');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const RELAXATIONS = ['none', 'stats-only', 'stats-only-main-any'];
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const sameNumber = (a,b) => typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b) && Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b));

function validSearchRule(rule, grade) {
  if (!rule || ![rule.value, rule.min, rule.max, rule.tolerance].every(value => typeof value === 'number' && Number.isFinite(value))) return false;
  if (rule.unverifiedSpecial === true) return rule.id?.startsWith('special.') && rule.operator === 'presence' && rule.min === 0 && rule.max === SPECIAL_MAX && rule.tolerance === 0;
  if (rule.operator === 'any') {
    const range = rule.allowedRange;
    return rule.id === 'base.mainStat' && Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger) && range[0] < range[1] &&
      rule.min === range[0] && rule.max === range[1] && rule.tolerance === 0 && Number.isSafeInteger(rule.value) && rule.value >= range[0] && rule.value <= range[1];
  }
  if (!rule.id?.startsWith('combat.')) return rule.operator === '=' && rule.min === rule.value && rule.max === rule.value && rule.tolerance === 0;
  const range = rule.allowedRange, ceiling = grade === '고대' ? 120 : grade === '유물' ? 100 : null;
  if (!ceiling || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[1] !== ceiling ||
      !Number.isSafeInteger(rule.value) || rule.value < range[0] || rule.value > ceiling) return false;
  const tolerance = Math.min(5, ceiling - rule.value);
  return rule.tolerance === tolerance && rule.min === Math.max(range[0], rule.value - tolerance) &&
    rule.max === rule.value + tolerance && rule.operator === (tolerance ? 'range' : '=');
}

function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof GuildError ? signal.reason : unavailable());
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

export function createBraceletValueService({ config, fetchImpl = fetch, readDetails, recordStore, now = Date.now,
  requestTimeoutMs = 8000, operationTimeoutMs = 25000, cacheMs = 15 * 60000, upstreamPerMinute = 20 } = {}) {
  const attempts = new Map(), cache = new Map(), pending = new Map(), controllers = new Set(), starts = [];
  let closed = false, blockedUntil = 0;
  function semaphore() {
    let active = 0; const queue = [];
    function drain() {
      while (active < 2 && queue.length) {
        const row = queue.shift(); row.signal.removeEventListener('abort', row.abort);
        if (row.signal.aborted || closed) { row.reject(closed ? closedError() : unavailable()); continue; }
        active++; let released = false;
        row.resolve(() => { if (!released) { released = true; active--; drain(); } });
      }
    }
    return signal => new Promise((resolve, reject) => {
      if (closed || signal.aborted) return reject(closed ? closedError() : unavailable());
      if (queue.length >= 8) return reject(limited());
      const row = { signal, resolve, reject };
      row.abort = () => { const index = queue.indexOf(row); if (index >= 0) queue.splice(index, 1); reject(closed ? closedError() : unavailable()); };
      signal.addEventListener('abort', row.abort, { once: true }); queue.push(row); drain();
    });
  }
  const acquireOperation = semaphore(), acquireTransport = semaphore();
  function allow(ip) {
    if (closed) return false;
    const timestamp = now();
    for (const [key, row] of attempts) if (row.until <= timestamp) attempts.delete(key);
    let row = attempts.get(ip);
    if (!row) { if (attempts.size >= 10000) return false; row = { count: 0, until: timestamp + 60000 }; attempts.set(ip, row); }
    return ++row.count <= 10;
  }
  async function request(body, parentSignal) {
    if (closed) throw closedError();
    const controller = new AbortController(); controllers.add(controller);
    const { signal } = controller, timer = setTimeout(() => controller.abort(unavailable()), requestTimeoutMs);
    const parentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', parentAbort, { once: true });
    if (parentSignal.aborted) parentAbort();
    let release, reader, response;
    const physical = (async () => {
      try {
        release = await acquireTransport(signal); signal.throwIfAborted();
        const timestamp = now();
        while (starts.length && starts[0] <= timestamp - 60000) starts.shift();
        if (starts.length >= upstreamPerMinute || blockedUntil > timestamp) throw limited();
        starts.push(timestamp);
        response = await fetchImpl(API, { method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `bearer ${config.automaticApproval.lostArkApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        signal.throwIfAborted();
        const reset = response.headers.get('x-ratelimit-reset'), remaining = response.headers.get('x-ratelimit-remaining');
        const candidate = /^\d{10}$/.test(reset || '') ? Number(reset) * 1000 : timestamp + 60000;
        if (response.status === 429 || (/^\d+$/.test(remaining || '') && Number(remaining) <= 15)) blockedUntil = candidate > timestamp && candidate <= timestamp + 120000 ? candidate : timestamp + 60000;
        if (response.status === 429) throw limited();
        if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
            Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw unavailable();
        reader = response.body.getReader(); let size = 0; const chunks = [];
        while (true) {
          const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
          size += value.byteLength; if (size > MAX_BYTES) throw unavailable(); chunks.push(Buffer.from(value));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (error) { if (error?.status === 429) throw limited(); if (error instanceof GuildError) throw error; throw unavailable(); }
      finally {
        clearTimeout(timer); controllers.delete(controller); parentSignal.removeEventListener('abort', parentAbort);
        if (reader) void reader.cancel().catch(() => {}); else void response?.body?.cancel().catch(() => {});
        // A transport that ignores abort remains charged until its actual work ends.
        release?.();
      }
    })();
    return waitFor(physical, signal);
  }
  async function collect(plan, signal) {
    // Each stage reads one page first. An empty stage, or a stage whose sampled
    // pages yield no usable listing, hands over to the next, more relaxed stage;
    // the last stage's outcome is returned as it is.
    for (let index = 0; index < plan.stages.length; index++) {
      const search = plan.stages[index];
      const firstRaw = await request({ ...search.body, PageNo: 1 }, signal);
      const first = normalizeBaseBraceletAuction(firstRaw, search, { now: now(), requestedPageNo: 1 });
      if (search.availabilityOnly === true && first.status === 'unavailable' && first.reason === 'fixed_special_value_unverified') {
        return {status:'unavailable',reason:first.reason,meanGold:null,availabilityOnly:true,relaxation:search.relaxation,coreMismatchExcludedCount:0,
          totalCount:first.totalCount,source:'official-auction-api',checkedAt:now(),conditionFingerprint:search.fingerprint};
      }
      if (!['ok', 'no_listings'].includes(first?.status) || !Number.isSafeInteger(first.totalCount) || first.totalCount < 0 ||
          !Number.isInteger(first.pageSize) || first.pageSize < 1 || first.pageSize > 10 || first.pageNo !== 1 ||
          !Number.isSafeInteger(first.coreMismatchCount) || first.coreMismatchCount < 0) throw unavailable();
      const result = await sampleStage(search, first, firstRaw, signal);
      if (result.status === 'ok' || index === plan.stages.length - 1) return result;
    }
    throw unavailable();
  }
  async function sampleStage(search, first, firstRaw, signal) {
    const totalPages = Math.max(1, Math.ceil(first.totalCount / first.pageSize));
    const lastFullPage = Math.max(1, Math.floor(first.totalCount / first.pageSize));
    // Partial last pages otherwise underweight the top-price stratum. Small
    // markets are read in full; larger markets use five equal-size pages.
    const pages = totalPages <= 5 ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : [...new Set([0, .25, .5, .75, 1].map(fraction => Math.round(1 + (lastFullPage - 1) * fraction)))];
    const omittedTailCount = totalPages > 5 ? first.totalCount % first.pageSize : 0;
    const samples = [...first.samples], signatures = new Set([hash(firstRaw.Items)]);
    let checked = first.checkedCount, filtered = first.excludedCount, coreMismatch = first.coreMismatchCount;
    let precedingMax = first.samples.length ? Math.max(...first.samples.map(row => row.price)) : null;
    const rest = await Promise.all(pages.slice(1).map(async page => ({ page, raw: await request({ ...search.body, PageNo: page }, signal) })));
    for (const { page, raw } of rest) {
      const row = normalizeBaseBraceletAuction(raw, search, { now: now(), requestedPageNo: page });
      const signature = hash(raw.Items);
      // Page snapshots cannot be mixed after listings move or the API repeats a page.
      if (!['ok', 'no_listings'].includes(row?.status) || row.pageNo !== page || row.totalCount !== first.totalCount || row.pageSize !== first.pageSize || signatures.has(signature) ||
          !Number.isSafeInteger(row.coreMismatchCount) || row.coreMismatchCount < 0) throw unavailable();
      if (row.samples.length) {
        const prices = row.samples.map(sample => sample.price);
        if (precedingMax !== null && Math.min(...prices) < precedingMax) throw unavailable();
        precedingMax = Math.max(...prices);
      }
      signatures.add(signature); samples.push(...row.samples); checked += row.checkedCount; filtered += row.excludedCount; coreMismatch += row.coreMismatchCount;
    }
    if (closed || signal.aborted || samples.length > 50) throw unavailable();
    const estimate = estimateBaseBraceletPrice(samples);
    if (!['ok', 'no_listings'].includes(estimate?.status) || (estimate.status === 'ok' && !positive(estimate.price))) throw unavailable();
    return { status: estimate.status, meanGold: estimate.status === 'ok' ? estimate.price : null,
      sampleCount: estimate.sampleCount, usedCount: estimate.used, excludedCount: estimate.excluded, filteredCount: filtered, coreMismatchExcludedCount: coreMismatch,
      checkedCount: checked, totalCount: first.totalCount, pages, pageSize: first.pageSize, stddevLog: estimate.stddevLog,
      lowSample: estimate.lowSample, spread: estimate.spread, method: 'log-price-2sd-trimmed-arithmetic-mean',
      samplingMethod: totalPages <= 5 ? 'all-listings' : 'five-full-rank-pages', omittedTailCount,
      omittedTailPage: omittedTailCount ? totalPages : null,
      basisVersion: 'bounded-combat-v2', relaxation: search.relaxation,
      comparison: search.availabilityOnly ? 'availability-only' : search.rules.every(rule => rule.min === rule.max) ? 'exact' : 'nearby',
      ...(search.availabilityOnly ? {availabilityOnly:true} : {}),
      conditions: { tier: search.tier, grade: search.grade, fixedCount: search.fixedCount, grantedCount: search.grantedCount,
        fixed: search.conditions.map(({ name, operator, value, min, max, tolerance, used }) => ({ name, operator, value, min, max, tolerance, used })) },
      source: 'official-auction-api', checkedAt: now(), conditionFingerprint: search.fingerprint };
  }
  // Replacement ladder for a bracelet the conversion model cannot price: the same tier and grade, first with the
  // bracelet's own combat/main stat lines, then with fewer, then with none at all.
  async function collectReplacement(plan, signal) {
    for (let index = 0; index < plan.stages.length; index++) {
      const search = plan.stages[index];
      const firstRaw = await request({ ...search.body, PageNo: 1 }, signal);
      const first = normalizeBraceletReplacementAuction(firstRaw, search, { now: now(), requestedPageNo: 1 });
      if (!['ok', 'no_listings'].includes(first.status)) throw unavailable();
      const result = await sampleReplacement(search, first, firstRaw, signal);
      if (result.status === 'ok' || index === plan.stages.length - 1) return { ...result, modelVersion: plan.modelVersion, targetKey: plan.targetKey };
    }
    throw unavailable();
  }
  async function sampleReplacement(search, first, firstRaw, signal) {
    const totalPages = Math.max(1, Math.ceil(first.totalCount / first.pageSize));
    const lastFullPage = Math.max(1, Math.floor(first.totalCount / first.pageSize));
    // A grade holds far more listings than one page, and the cheapest page alone is not the grade's price.
    const pages = totalPages <= 5 ? Array.from({ length: totalPages }, (_, index) => index + 1)
      : [...new Set([0, .25, .5, .75, 1].map(fraction => Math.round(1 + (lastFullPage - 1) * fraction)))];
    const samples = [...first.samples], signatures = new Set([hash(firstRaw.Items)]);
    let checked = first.checkedCount, excluded = first.excludedCount;
    let precedingMax = first.samples.length ? Math.max(...first.samples.map(row => row.price)) : null;
    const rest = await Promise.all(pages.slice(1).map(async page => ({ page, raw: await request({ ...search.body, PageNo: page }, signal) })));
    for (const { page, raw } of rest) {
      const row = normalizeBraceletReplacementAuction(raw, search, { now: now(), requestedPageNo: page });
      const signature = hash(raw.Items);
      if (row.status !== 'ok' || row.pageNo !== page || row.totalCount !== first.totalCount || row.pageSize !== first.pageSize || signatures.has(signature)) throw unavailable();
      if (row.samples.length) {
        const prices = row.samples.map(sample => sample.price);
        if (precedingMax !== null && Math.min(...prices) < precedingMax) throw unavailable();
        precedingMax = Math.max(...prices);
      }
      signatures.add(signature); samples.push(...row.samples); checked += row.checkedCount; excluded += row.excludedCount;
    }
    if (closed || signal.aborted || samples.length > 50) throw unavailable();
    const estimate = estimateBaseBraceletPrice(samples);
    if (!['ok', 'no_listings'].includes(estimate?.status) || (estimate.status === 'ok' && !positive(estimate.price))) throw unavailable();
    return { status: estimate.status, meanGold: estimate.status === 'ok' ? estimate.price : null, basis: search.basis,
      sampleCount: estimate.sampleCount, usedCount: estimate.used, excludedCount: estimate.excluded, filteredCount: excluded,
      checkedCount: checked, totalCount: first.totalCount, pages, pageSize: first.pageSize, stddevLog: estimate.stddevLog,
      lowSample: estimate.lowSample, spread: estimate.spread, method: 'log-price-2sd-trimmed-arithmetic-mean',
      samplingMethod: totalPages <= 5 ? 'all-listings' : 'five-full-rank-pages',
      conditions: { tier: search.tier, grade: search.grade, fixed: search.conditions },
      source: 'official-auction-api', checkedAt: now(), conditionFingerprint: search.fingerprint };
  }
  // The replacement value of one equipped bracelet. Nothing here is character specific, so the whole ladder is
  // shared through the same fifteen minute cache and one roster pays for it once per tier, grade and stat pair.
  async function replacement(input) {
    if (closed || !config?.automaticApproval?.lostArkApiKey) throw closedError();
    const plan = buildBraceletReplacementPlan(input);
    if (plan.status !== 'ok' || plan.modelVersion !== BRACELET_REPLACEMENT_MODEL || !plan.stages.length || plan.stages.length > 3) {
      return { status: 'unavailable', reason: plan.reason || 'bracelet_replacement_unsupported', meanGold: null, basis: null };
    }
    const controller = new AbortController(); controllers.add(controller);
    const { signal } = controller, timer = setTimeout(() => controller.abort(unavailable()), operationTimeoutMs);
    let release;
    try {
      release = await acquireOperation(signal);
      const value = await cachedCollect(hash(plan.stages.map(stage => stage.fingerprint)), inner => collectReplacement(plan, inner), signal);
      signal.throwIfAborted(); if (closed) throw closedError();
      return structuredClone(value);
    } catch (error) {
      if (closed || error?.status === 503) throw closedError();
      if (error?.status === 429) throw limited();
      if (error instanceof GuildError) throw error;
      throw unavailable();
    } finally { clearTimeout(timer); controllers.delete(controller); controller.abort(); release?.(); }
  }
  function priceFor(plan, signal) {
    return cachedCollect(hash(plan.stages.map(stage => stage.fingerprint)), inner => collect(plan, inner), signal);
  }
  function cachedCollect(key, run, signal) {
    if (closed) return Promise.reject(closedError());
    // One cache and one in-flight entry per stage list, so a repeat lookup of
    // the same bracelet never walks the relaxation stages again.
    const hit = cache.get(key);
    if (hit?.until > now()) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.value); }
    cache.delete(key);
    let entry = pending.get(key);
    if (!entry) {
      if (pending.size >= 10) return Promise.reject(limited());
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(unavailable()), operationTimeoutMs);
      entry = { controller, consumers: 0, settled: false };
      entry.promise = run(controller.signal).then(value => {
        if (closed || controller.signal.aborted) throw closed ? closedError() : unavailable();
        cache.set(key, { value, until: now() + cacheMs });
        while (cache.size > 128) cache.delete(cache.keys().next().value);
        return value;
      }).catch(error => { controller.abort(error); throw error; }).finally(() => {
        entry.settled = true; clearTimeout(timer); controllers.delete(controller);
        if (pending.get(key) === entry) pending.delete(key);
      });
      pending.set(key, entry);
    }
    entry.consumers++;
    return waitFor(entry.promise, signal).finally(() => {
      entry.consumers--;
      if (!entry.consumers && !entry.settled) entry.controller.abort(unavailable());
    });
  }
  async function get(value) {
    const name = normalizeCharacter(value);
    if (!name) throw new GuildError(400, 'invalid_request');
    if (closed || typeof readDetails !== 'function' || !config?.automaticApproval?.lostArkApiKey) throw closedError();
    const controller = new AbortController(); controllers.add(controller);
    const { signal } = controller, timer = setTimeout(() => controller.abort(unavailable()), operationTimeoutMs);
    let release, currentRecord = null, recordStatus = recordStore === null ? 'unavailable' : 'none', resultContext = null,recordPolicy=BRACELET_VALUE_RECORD_POLICY;
    const withRecord = result => ({...result,record:currentRecord ? structuredClone(currentRecord) : null,recordStatus});
    function verifiedRecord(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !resultContext ||
          normalizeCharacter(value.characterName)?.toLowerCase() !== name.toLowerCase() || value.targetKey !== resultContext.targetKey || value.policyVersion !== recordPolicy ||
          !positive(value.costExpectedGold) || !positive(value.basePriceGold) || !Number.isSafeInteger(value.recordedAt) || value.recordedAt <= 0 || value.recordedAt > now() ||
          !positive(value.expectedStartingBracelets) || !positive(value.successProbability) || value.successProbability > 1 ||
          typeof value.expectedReconversionTicketsUntilSuccess !== 'number' || value.expectedReconversionTicketsUntilSuccess < 0 ||
          !sameNumber(value.expectedStartingBracelets,resultContext.expectedStartingBracelets) || !sameNumber(value.successProbability,resultContext.successProbability) ||
          !sameNumber(value.expectedReconversionTicketsUntilSuccess,resultContext.expectedReconversionTicketsUntilSuccess) ||
          !sameNumber(value.costExpectedGold,value.basePriceGold*value.expectedStartingBracelets)) throw unavailable();
      return {characterName:value.characterName,targetKey:value.targetKey,policyVersion:value.policyVersion,costExpectedGold:value.costExpectedGold,
        recordedAt:value.recordedAt,basePriceGold:value.basePriceGold,expectedStartingBracelets:value.expectedStartingBracelets,
        successProbability:value.successProbability,expectedReconversionTicketsUntilSuccess:value.expectedReconversionTicketsUntilSuccess};
    }
    try {
      release = await acquireOperation(signal);
      const details = await waitFor(Promise.resolve().then(() => readDetails(name)), signal);
      signal.throwIfAborted();
      const efficiency = details?.efficiency, expectation = efficiency?.braceletExpectation;
      const targetKey = hash({ rarity: expectation?.rarity, target: expectation?.target });
      if (efficiency?.source !== 'official-api' || normalizeCharacter(efficiency.characterName)?.toLowerCase() !== name.toLowerCase()) throw unavailable();
      const tier=expectation?.tier===undefined?4:expectation.tier;
      if(![3,4].includes(tier))throw unavailable();
      const ticketCount=tier===3?0:3,totalRolls=4+ticketCount;
      recordPolicy=tier===3?BRACELET_T3_VALUE_RECORD_POLICY:BRACELET_VALUE_RECORD_POLICY;
      if (expectation?.status === 'unavailable' && typeof expectation.reason === 'string' && expectation.reason.trim() && expectation.reason.length <= 2000) {
        return withRecord({ status: 'unavailable', reason: expectation.reason, characterName: efficiency.characterName,
          targetKey: null, price: null, costExpectedGold: null, expectedStartingBracelets: null, successProbability: null,tier,reconversionTickets:ticketCount,
          totalRolls,expectedReconversionTicketsPerBracelet:null,expectedReconversionTicketsUntilSuccess:null,
          reconversionTicketUnitGold:null,reconversionTicketCostGold:null });
      }
      if (expectation?.status !== 'ok' || expectation.targetKey !== targetKey) throw unavailable();
      const scenarios = Array.isArray(expectation.scenarios) ? expectation.scenarios.filter(row => row?.reconversionTickets === ticketCount) : [];
      const selected=scenarios[0];
      if (scenarios.length !== 1 || !positive(selected.expectedStartingBracelets) || !positive(selected.successProbability) || selected.successProbability > 1 || selected.totalRolls !== totalRolls ||
          typeof selected.expectedReconversionTicketsPerBracelet !== 'number' || !Number.isFinite(selected.expectedReconversionTicketsPerBracelet) || selected.expectedReconversionTicketsPerBracelet < 0 || selected.expectedReconversionTicketsPerBracelet > ticketCount ||
          typeof selected.expectedReconversionTicketsUntilSuccess !== 'number' || !Number.isFinite(selected.expectedReconversionTicketsUntilSuccess) || selected.expectedReconversionTicketsUntilSuccess < 0 ||
          Math.abs(selected.expectedReconversionTicketsUntilSuccess-selected.expectedReconversionTicketsPerBracelet*selected.expectedStartingBracelets)>1e-10*Math.max(1,selected.expectedReconversionTicketsUntilSuccess)) throw unavailable();
      const plan = buildBaseBraceletSearchPlan(expectation, {checkAvailability:true});
      if (plan?.status !== 'ok' || !Array.isArray(plan.stages) || !plan.stages.length || plan.stages.length > 3 ||
          new Set(plan.stages.map(stage => stage?.fingerprint)).size !== plan.stages.length ||
          plan.stages.some(search => search?.status !== 'ok' || !/^[a-f0-9]{64}$/.test(search.fingerprint || '') || !RELAXATIONS.includes(search.relaxation) ||
            !Array.isArray(search.rules) || !search.rules.length || search.rules.some(rule => !validSearchRule(rule, search.grade)) ||
            !Array.isArray(search.conditions) || search.conditions.length !== search.fixedCount)) throw unavailable();
      resultContext={characterName:efficiency.characterName,targetKey,expectedStartingBracelets:selected.expectedStartingBracelets,
        successProbability:selected.successProbability,tier,reconversionTickets:ticketCount,totalRolls,
        expectedReconversionTicketsPerBracelet:selected.expectedReconversionTicketsPerBracelet,
        expectedReconversionTicketsUntilSuccess:selected.expectedReconversionTicketsUntilSuccess,
        reconversionTicketUnitGold:null,reconversionTicketCostGold:null};
      if (recordStore) {
        try {
          const saved=recordStore.get(name,targetKey,recordPolicy);
          currentRecord=saved===null ? null : verifiedRecord(saved);recordStatus=currentRecord?'saved':'none';
        } catch { recordStatus='unavailable'; }
      }
      const price = await priceFor(plan, signal); signal.throwIfAborted();
      if (closed) throw closedError();
      const expectedStartingBracelets = selected.expectedStartingBracelets;
      const costExpectedGold = price.meanGold === null ? null : expectedStartingBracelets * price.meanGold;
      if (costExpectedGold !== null && !Number.isFinite(costExpectedGold)) throw unavailable();
      if (recordStore && price.status === 'ok' && positive(costExpectedGold)) {
        // The synchronous store call follows the final liveness check. A late
        // quote after timeout/close cannot reach this durable write.
        signal.throwIfAborted();if(closed)throw closedError();
        try {
          const saved=verifiedRecord(recordStore.record(name,targetKey,recordPolicy,{costExpectedGold,recordedAt:price.checkedAt,
            basePriceGold:price.meanGold,expectedStartingBracelets,successProbability:selected.successProbability,
            expectedReconversionTicketsUntilSuccess:selected.expectedReconversionTicketsUntilSuccess}));
          if(saved.costExpectedGold<costExpectedGold && !sameNumber(saved.costExpectedGold,costExpectedGold) ||
            currentRecord && saved.costExpectedGold<currentRecord.costExpectedGold && !sameNumber(saved.costExpectedGold,currentRecord.costExpectedGold)) throw unavailable();
          currentRecord=saved;recordStatus='saved';
        } catch { recordStatus='unavailable'; }
      }
      return withRecord({ ...resultContext,status: price.status, ...(price.status === 'no_listings' ? { reason: '조건에 맞는 즉시 구매가 매물을 확인하지 못했습니다.' }
        : price.reason === 'fixed_special_value_unverified' ? {reason:'같은 종류의 고정 특수 옵션 매물은 있지만, 공식 경매장 API가 효과 수치를 제공하지 않아 현재 옵션과 정확히 대조할 수 없습니다.'} : {}), price: structuredClone(price),costExpectedGold });
    } catch (error) {
      if (closed || error?.status === 503) throw closedError();
      if (resultContext && currentRecord) return withRecord({...resultContext,status:'unavailable',price:null,costExpectedGold:null,
        reason:error?.status===429?'공식 경매장 요청 한도에 도달하여 현재 시세를 읽지 못했습니다.':'공식 경매장 현재 시세를 확인하지 못했습니다.',
        currentErrorCode:error?.status===429?'bracelet_value_rate_limited':'bracelet_value_unavailable'});
      if (error?.status === 429) throw limited(); if (error instanceof GuildError) throw error; throw unavailable();
    }
    finally { clearTimeout(timer); controllers.delete(controller); controller.abort(); release?.(); }
  }
  return { get, replacement, allow, close() { if (closed) return; closed = true; for (const controller of controllers) controller.abort(closedError()); attempts.clear(); cache.clear(); } };
}
