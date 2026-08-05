const { normalizeText } = require('../utils/ocrPageSearch');

const MAX_TERMS = 48;
const MAX_CHARACTERS = 32;

class OcrSearchBudgetError extends Error {
  constructor(message = 'OCR search budget exceeded.') {
    super(message);
    this.name = 'OcrSearchBudgetError';
    this.code = 'OCR_SEARCH_BUDGET_EXCEEDED';
    this.statusCode = 504;
  }
}

function canonicalizeTerms(input) {
  const terms = new Map();
  for (const candidate of Array.isArray(input) ? input : []) {
    const rawTerm = typeof candidate === 'string' ? candidate : candidate?.term;
    const term = normalizeText(rawTerm).replace(/\s+/g, ' ').trim();
    const rawWeight = typeof candidate === 'string' ? Math.max(1, term.length / 5) : Number(candidate?.weight);
    if (term.length < 3 || term.length > 80 || !Number.isFinite(rawWeight) || rawWeight <= 0) continue;
    const weight = Number(Math.min(10, Math.max(0.05, rawWeight)).toFixed(4));
    terms.set(term, Math.max(terms.get(term) || 0, weight));
  }

  return Array.from(terms.entries())
    .map(([term, weight]) => ({ term, weight }))
    .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term))
    .slice(0, MAX_TERMS)
    .sort((left, right) => left.term.localeCompare(right.term));
}

function canonicalizeFilters(filters = {}) {
  const characters = Array.from(new Set(
    (Array.isArray(filters.characters) ? filters.characters : [])
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  )).sort().slice(0, MAX_CHARACTERS);
  const tome = Number.isInteger(Number(filters.tome)) && Number(filters.tome) > 0 ? Number(filters.tome) : null;
  return {
    manga: String(filters.manga || '').trim().toLowerCase() || null,
    tome,
    characters,
    arc: String(filters.arc || '').trim().toLowerCase() || null,
  };
}

function buildCacheKey(terms, filters) {
  return JSON.stringify({ terms, filters });
}

function cloneRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({ ...row }));
}

function createOcrCandidateSearch({
  client,
  cacheSize = 128,
  cacheTtlMs = 15_000,
  rpcTimeoutMs = 1_200,
  now = () => Date.now(),
} = {}) {
  if (!client?.rpc) throw new TypeError('A Supabase client is required.');

  const cache = new Map();
  const pending = new Map();

  function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return cloneRows(entry.rows);
  }

  function setCached(key, rows) {
    cache.delete(key);
    cache.set(key, { rows: cloneRows(rows), expiresAt: now() + cacheTtlMs });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  }

  function waitForShared(entry, signal) {
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let completed = false;
      const finish = (callback, value) => {
        if (completed) return;
        completed = true;
        signal?.removeEventListener('abort', onAbort);
        entry.waiters -= 1;
        if (!entry.settled && entry.waiters === 0) entry.controller.abort();
        callback(value);
      };
      const onAbort = () => {
        const error = new Error('OCR candidate lookup aborted.');
        error.name = 'AbortError';
        finish(reject, error);
      };

      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        result => finish(resolve, result),
        error => finish(reject, error)
      );
    });
  }

  async function getCandidates({ terms: inputTerms, filters: inputFilters, signal } = {}) {
    const terms = canonicalizeTerms(inputTerms);
    if (!terms.length) return { rows: [], termsCount: 0, cacheHit: false, coalesced: false, rpcDurationMs: 0 };
    const filters = canonicalizeFilters(inputFilters);
    const key = buildCacheKey(terms, filters);
    const cached = getCached(key);
    if (cached) return { rows: cached, termsCount: terms.length, cacheHit: true, coalesced: false, rpcDurationMs: 0 };

    let entry = pending.get(key);
    const coalesced = Boolean(entry);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, waiters: 0, settled: false, timedOut: false, promise: null };
      const timeout = setTimeout(() => {
        entry.timedOut = true;
        controller.abort();
      }, rpcTimeoutMs);

      entry.promise = (async () => {
        const startedAt = now();
        try {
          const builder = client.rpc('search_ocr_page_candidates', {
            p_terms: terms,
            p_manga_slug: filters.manga,
            p_tome_numero: filters.tome,
            p_characters: filters.characters.length ? filters.characters : null,
            p_arc: filters.arc,
            p_per_term_limit: 160,
            p_global_limit: 600,
          });
          const { data, error } = await builder.abortSignal(controller.signal);
          if (error) throw error;
          const rows = cloneRows(data);
          setCached(key, rows);
          return { rows, termsCount: terms.length, cacheHit: false, coalesced: false, rpcDurationMs: Math.max(0, now() - startedAt) };
        } catch (error) {
          if (entry.timedOut) throw new OcrSearchBudgetError('OCR candidate RPC exceeded its time budget.');
          throw error;
        } finally {
          clearTimeout(timeout);
          entry.settled = true;
          pending.delete(key);
        }
      })();
      pending.set(key, entry);
    }

    const result = await waitForShared(entry, signal);
    return {
      ...result,
      rows: cloneRows(result.rows),
      cacheHit: result.cacheHit || coalesced,
      coalesced,
      rpcDurationMs: coalesced ? 0 : result.rpcDurationMs,
    };
  }

  return {
    getCandidates,
    clear() {
      cache.clear();
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    },
    _cacheKeys: () => Array.from(cache.keys()),
  };
}

module.exports = {
  MAX_TERMS,
  OcrSearchBudgetError,
  buildCacheKey,
  canonicalizeFilters,
  canonicalizeTerms,
  createOcrCandidateSearch,
};
