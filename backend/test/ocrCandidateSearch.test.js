const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  OcrSearchBudgetError,
  buildCacheKey,
  canonicalizeFilters,
  canonicalizeTerms,
  createOcrCandidateSearch,
} = require('../src/services/ocrCandidateSearch');
const { rankOcrPageCandidatesWithBudget } = require('../src/utils/ocrPageSearch');

function createFakeClient(handler) {
  const calls = [];
  return {
    calls,
    rpc(name, params) {
      return {
        abortSignal(signal) {
          calls.push({ name, params, signal });
          return handler({ name, params, signal, callIndex: calls.length - 1 });
        },
      };
    },
  };
}

test('candidate terms and filters have a deterministic bounded cache key', () => {
  const terms = canonicalizeTerms([
    { term: ' Équipage ', weight: 1.23456 },
    { term: 'equipage', weight: 2 },
    { term: 'COEUR', weight: 0.5 },
    { term: 'x', weight: 10 },
    { term: 'invalid', weight: Number.NaN },
  ]);
  assert.deepEqual(terms, [
    { term: 'coeur', weight: 0.5 },
    { term: 'equipage', weight: 2 },
  ]);

  const leftFilters = canonicalizeFilters({ manga: ' One-Piece ', tome: '2', characters: ['Zoro', 'luffy', 'Zoro'], arc: ' East Blue ' });
  const rightFilters = canonicalizeFilters({ manga: 'one-piece', tome: 2, characters: ['luffy', 'zoro'], arc: 'east blue' });
  assert.deepEqual(leftFilters, rightFilters);
  assert.equal(buildCacheKey(terms, leftFilters), buildCacheKey([...terms], rightFilters));
});

test('one weighted RPC replaces every sequential token lookup', async () => {
  const client = createFakeClient(async () => ({ data: [{ page_id: 7, candidate_score: 3.5 }], error: null }));
  const search = createOcrCandidateSearch({ client });
  const inputTerms = Array.from({ length: 56 }, (_, index) => ({ term: `token${index}`, weight: index + 1 }));

  const result = await search.getCandidates({
    terms: inputTerms,
    filters: { manga: 'one-piece', tome: 3, characters: ['Luffy'], arc: 'Skypiea' },
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, 'search_ocr_page_candidates');
  assert.equal(client.calls[0].params.p_terms.length, 48);
  assert.deepEqual(client.calls[0].params.p_characters, ['luffy']);
  assert.equal(client.calls[0].params.p_global_limit, 600);
  assert.ok(client.calls[0].signal instanceof AbortSignal);
  assert.deepEqual(result.rows, [{ page_id: 7, candidate_score: 3.5 }]);
});

test('empty results are cached and returned as defensive copies', async () => {
  const client = createFakeClient(async () => ({ data: [], error: null }));
  const search = createOcrCandidateSearch({ client });
  const first = await search.getCandidates({ terms: [{ term: 'equipage', weight: 1 }] });
  first.rows.push({ page_id: 999 });
  const second = await search.getCandidates({ terms: [{ term: 'equipage', weight: 1 }] });

  assert.equal(client.calls.length, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.rows, []);
});

test('manga, volume, arc and character filters isolate cache entries', async () => {
  const client = createFakeClient(async ({ callIndex }) => ({ data: [{ page_id: callIndex + 1 }], error: null }));
  const search = createOcrCandidateSearch({ client });
  const terms = [{ term: 'pirate', weight: 1 }];

  await search.getCandidates({ terms, filters: { manga: 'one-piece', tome: 1, arc: 'east blue', characters: ['luffy'] } });
  await search.getCandidates({ terms, filters: { manga: 'one-piece', tome: 2, arc: 'east blue', characters: ['luffy'] } });
  await search.getCandidates({ terms, filters: { manga: 'other', tome: 1, arc: 'east blue', characters: ['luffy'] } });
  await search.getCandidates({ terms, filters: { manga: 'one-piece', tome: 1, arc: 'alabasta', characters: ['luffy'] } });
  await search.getCandidates({ terms, filters: { manga: 'one-piece', tome: 1, arc: 'east blue', characters: ['zoro'] } });

  assert.equal(client.calls.length, 5);
});

test('concurrent identical lookups are coalesced into one RPC', async () => {
  let resolveRpc;
  const client = createFakeClient(() => new Promise(resolve => { resolveRpc = resolve; }));
  const search = createOcrCandidateSearch({ client });
  const request = { terms: [{ term: 'chapeau', weight: 1 }] };
  const firstPromise = search.getCandidates(request);
  const secondPromise = search.getCandidates(request);

  assert.equal(client.calls.length, 1);
  resolveRpc({ data: [{ page_id: 42 }], error: null });
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
  assert.equal(second.cacheHit, true, 'coalesced waiters must not be counted as database misses');
  assert.equal(second.rpcDurationMs, 0);
  assert.deepEqual(first.rows, second.rows);
});

test('RPC errors and timeouts are never cached', async () => {
  let shouldFail = true;
  const client = createFakeClient(async () => shouldFail
    ? { data: null, error: new Error('database unavailable') }
    : { data: [{ page_id: 5 }], error: null });
  const search = createOcrCandidateSearch({ client });
  const request = { terms: [{ term: 'marine', weight: 1 }] };

  await assert.rejects(search.getCandidates(request), /database unavailable/);
  shouldFail = false;
  assert.deepEqual((await search.getCandidates(request)).rows, [{ page_id: 5 }]);
  assert.equal(client.calls.length, 2);

  const timeoutClient = createFakeClient(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const timeoutSearch = createOcrCandidateSearch({ client: timeoutClient, rpcTimeoutMs: 5 });
  await assert.rejects(
    timeoutSearch.getCandidates({ terms: [{ term: 'grandline', weight: 1 }] }),
    error => error instanceof OcrSearchBudgetError && error.code === 'OCR_SEARCH_BUDGET_EXCEEDED'
  );
});

test('an abandoned lookup aborts the in-flight RPC and late results cannot populate cache', async () => {
  let rpcSignal;
  const client = createFakeClient(({ signal }) => {
    rpcSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  });
  const search = createOcrCandidateSearch({ client, rpcTimeoutMs: 1_000 });
  const controller = new AbortController();
  const promise = search.getCandidates({ terms: [{ term: 'nakama', weight: 1 }], signal: controller.signal });
  controller.abort();

  await assert.rejects(promise, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rpcSignal.aborted, true);
  assert.equal(search._cacheKeys().length, 0);
});

test('cache expiry and LRU eviction are bounded', async () => {
  let clock = 0;
  const client = createFakeClient(async ({ callIndex }) => ({ data: [{ page_id: callIndex }], error: null }));
  const search = createOcrCandidateSearch({ client, cacheSize: 2, cacheTtlMs: 10, now: () => clock });

  await search.getCandidates({ terms: [{ term: 'alpha', weight: 1 }] });
  await search.getCandidates({ terms: [{ term: 'bravo', weight: 1 }] });
  await search.getCandidates({ terms: [{ term: 'alpha', weight: 1 }] });
  await search.getCandidates({ terms: [{ term: 'charlie', weight: 1 }] });
  await search.getCandidates({ terms: [{ term: 'bravo', weight: 1 }] });
  assert.equal(client.calls.length, 4, 'bravo must be evicted after alpha is refreshed');

  clock = 11;
  await search.getCandidates({ terms: [{ term: 'alpha', weight: 1 }] });
  assert.equal(client.calls.length, 5, 'expired values must be fetched again');
});

test('CPU ranking checks its deadline between page candidates', () => {
  let tick = 0;
  const query = [{ content: 'chapeau de paille', bbox: [0, 0, 20, 20] }];
  const pages = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    bulles: [{ id: index + 10, id_page: index + 1, texte_propose: 'chapeau de paille', x: 0, y: 0, w: 20, h: 20 }],
  }));
  const ranked = rankOcrPageCandidatesWithBudget(query, pages, { limit: 10, deadline: 2, now: () => tick++ });

  assert.equal(ranked.processedCount, 2);
  assert.equal(ranked.budgetExceeded, true);
  assert.equal(ranked.results.length, 2);
});

test('migration defines indexed adaptive search, bounded telemetry and private RPCs', () => {
  const root = path.resolve(__dirname, '..', '..');
  const sql = fs.readFileSync(path.join(root, 'backend/sql/2026-08-01_optimize_ocr_candidate_search.sql'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'backend/src/routes/searchRoutes.js'), 'utf8');

  assert.match(sql, /create extension if not exists pg_trgm/i);
  assert.match(sql, /using gin \(texte_recherche extensions\.gin_trgm_ops\)/i);
  assert.match(sql, /create or replace function public\.search_ocr_page_candidates/i);
  assert.match(sql, /strict_word_similarity[\s\S]*>= 0\.72/i);
  assert.match(sql, /strict_word_similarity[\s\S]*>= 0\.58/i);
  assert.match(sql, /char_length\(t\.term\) between 3 and 4/i);
  assert.match(sql, /p_manga_slug is null or m\.slug = p_manga_slug/i);
  assert.match(sql, /p_tome_numero is null or v\.numero = p_tome_numero/i);
  assert.match(sql, /percentile_cont\(0\.50\)[\s\S]*percentile_cont\(0\.95\)[\s\S]*percentile_cont\(0\.99\)/i);
  assert.match(sql, /revoke all on function public\.search_ocr_page_candidates[\s\S]*from public, anon, authenticated/i);
  assert.doesNotMatch(route, /\.ilike\('texte_propose'/i);
  assert.match(route, /ocrCandidateSearch\.getCandidates/);
  assert.match(route, /OCR_SEARCH_BUDGET_EXCEEDED/);
});
