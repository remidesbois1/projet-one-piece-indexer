const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { mapBubbleReorderError } = require('../src/utils/bubbleReorder');

test('reorder RPC errors map to stable client responses', () => {
  assert.deepEqual(mapBubbleReorderError({ code: 'P0002' }), {
    status: 404,
    message: 'Page introuvable.',
  });
  assert.deepEqual(mapBubbleReorderError({ code: '42501', message: 'Page verrouillée.' }), {
    status: 403,
    message: 'Page verrouillée.',
  });
  assert.equal(mapBubbleReorderError({ code: '22023' }).status, 400);
  assert.equal(mapBubbleReorderError({ code: '22003' }).status, 400);
  assert.equal(mapBubbleReorderError({ code: '40001' }).status, 409);
  assert.equal(mapBubbleReorderError({ code: '55000' }).status, 409);
  assert.deepEqual(mapBubbleReorderError({ code: 'XX000', message: 'secret' }), {
    status: 500,
    message: "Erreur lors de la mise à jour de l'ordre.",
  });
});

test('reorder migration revokes client execution and validates atomically', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'sql', '2026-08-01_secure_bubble_reordering.sql'),
    'utf8'
  );

  assert.match(sql, /revoke all on function public\.reorder_bubbles\(jsonb\) from anon/i);
  assert.match(sql, /revoke all on function public\.reorder_bubbles\(jsonb\) from authenticated/i);
  assert.match(sql, /create or replace function public\.reorder_page_bubbles/i);
  assert.match(sql, /security definer\s+set search_path = pg_catalog, public/i);
  assert.match(sql, /from public\.pages[\s\S]*for update/i);
  assert.match(sql, /from public\.bulles[\s\S]*for update/i);
  assert.match(sql, /v_page_status not in \('not_started'.*'in_progress'/i);
  assert.match(sql, /v_page_count <> v_input_count/i);
  assert.match(sql, /bubble\.id_page = p_page_id/i);
  assert.match(sql, /id_user_createur <> p_actor_id/i);
  assert.match(sql, /statut <> 'Proposé'/i);
  assert.match(sql, /update public\.bulles as bubble[\s\S]*from input/i);
  assert.match(sql, /revoke all on function public\.reorder_page_bubbles.*from anon/i);
  assert.match(sql, /revoke all on function public\.reorder_page_bubbles.*from authenticated/i);
  assert.match(sql, /grant execute on function public\.reorder_page_bubbles.*to service_role/i);
});

test('bubble route calls only the authorized page-scoped RPC', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'bulleRoutes.js'),
    'utf8'
  );
  assert.match(source, /rpc\('reorder_page_bubbles'/);
  assert.match(source, /p_page_id: pageId/);
  assert.match(source, /p_actor_id: req\.user\.id/);
  assert.doesNotMatch(source, /rpc\('reorder_bubbles'/);
});
