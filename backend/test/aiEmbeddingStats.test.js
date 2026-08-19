const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('embedding stats use a private lightweight RPC instead of transferring vectors', () => {
  const root = path.resolve(__dirname, '..', '..');
  const sql = fs.readFileSync(path.join(root, 'backend/sql/2026-08-19_optimize_ai_embedding_stats.sql'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'backend/src/routes/adminRoutes.js'), 'utf8');
  const routeBlock = route.slice(
    route.indexOf("router.get('/ai-models/embedding-stats'"),
    route.indexOf("router.post('/ai-models/save-page-data'")
  );

  assert.match(sql, /create or replace function public\.get_ai_embedding_stats/i);
  assert.match(sql, /p\.embedding_voyage is not null/i);
  assert.match(sql, /p\.embedding_gemini is not null/i);
  assert.match(sql, /p\.embedding_f2llm is not null/i);
  assert.match(sql, /revoke all on function public\.get_ai_embedding_stats\(text\) from public, anon, authenticated/i);
  assert.match(routeBlock, /supabaseAdmin\.rpc\('get_ai_embedding_stats'/);
  assert.doesNotMatch(routeBlock, /\.select\([\s\S]*embedding_/);
});
