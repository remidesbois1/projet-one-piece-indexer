const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  canCreateBubble,
  canDeleteBubble,
  canEditBubble,
  canSubmitPage,
  mapBubbleMutationError,
} = require('../src/utils/bubblePermissions');

const admin = { id: 'admin-1', role: 'Admin' };
const moderator = { id: 'modo-1', role: 'Modo' };
const user = { id: 'user-1', role: 'User' };
const editablePage = { id: 10, statut: 'in_progress' };
const ownProposed = { id: 20, id_user_createur: user.id, statut: 'Proposé' };

test('central bubble edit policy keeps moderated content immutable', () => {
  assert.equal(canCreateBubble(user, editablePage), true);
  assert.equal(canCreateBubble(user, { ...editablePage, statut: 'pending_review' }), false);
  assert.equal(canEditBubble(user, ownProposed, editablePage), true);
  assert.equal(canEditBubble(user, { ...ownProposed, id_user_createur: 'other' }, editablePage), false);
  assert.equal(canEditBubble(user, { ...ownProposed, statut: 'Validé' }, editablePage), false);
  assert.equal(canEditBubble(admin, ownProposed, { ...editablePage, statut: 'pending_review' }), true);
  assert.equal(canEditBubble(moderator, { ...ownProposed, id_user_createur: 'other' }, { ...editablePage, statut: 'pending_review' }), true);
  assert.equal(canEditBubble(admin, { ...ownProposed, statut: 'Rejeté' }, editablePage), false);
  assert.equal(canEditBubble(admin, ownProposed, { ...editablePage, statut: 'completed' }), false);
});

test('delete and submit keep their explicit administrative boundaries', () => {
  assert.equal(canDeleteBubble(admin, { ...ownProposed, statut: 'Validé' }, { ...editablePage, statut: 'completed' }), true);
  assert.equal(canDeleteBubble(moderator, { ...ownProposed, id_user_createur: moderator.id }, editablePage), true);
  assert.equal(canDeleteBubble(moderator, ownProposed, editablePage), false);
  assert.equal(canDeleteBubble(user, { ...ownProposed, statut: 'Validé' }, editablePage), false);
  assert.equal(canSubmitPage(admin, editablePage, 1), true);
  assert.equal(canSubmitPage(moderator, editablePage, 2), true);
  assert.equal(canSubmitPage(user, editablePage, 1), false);
  assert.equal(canSubmitPage(admin, editablePage, 0), false);
  assert.equal(canSubmitPage(admin, { ...editablePage, statut: 'pending_review' }, 1), false);
});

test('mutation errors expose stable status codes without leaking unknown failures', () => {
  assert.equal(mapBubbleMutationError({ code: 'P0002' }, 'fallback').status, 404);
  assert.equal(mapBubbleMutationError({ code: '42501' }, 'fallback').status, 403);
  assert.equal(mapBubbleMutationError({ code: '55000' }, 'fallback').status, 409);
  assert.equal(mapBubbleMutationError({ code: '22023' }, 'fallback').status, 400);
  assert.deepEqual(mapBubbleMutationError({ code: 'XX000', message: 'database secret' }, 'fallback'), {
    status: 500,
    message: 'fallback',
  });
});

test('database migration serializes mutations and closes direct-client bypasses', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'sql', '2026-08-01_lock_moderated_bubble_mutations.sql'),
    'utf8'
  );
  assert.match(sql, /create or replace function public\.can_edit_bubble/i);
  assert.match(sql, /create trigger guard_bubble_content_mutations/i);
  assert.match(sql, /for key share/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /old\.statut in[\s\S]*'Validé'[\s\S]*'Rejeté'/i);
  assert.match(sql, /create or replace function public\.create_editable_bubble/i);
  assert.match(sql, /create or replace function public\.update_editable_bubble/i);
  assert.match(sql, /create or replace function public\.delete_editable_bubble/i);
  assert.match(sql, /create or replace function public\.moderate_proposed_bubble/i);
  assert.match(sql, /create or replace function public\.submit_page_for_review/i);
  assert.match(sql, /revoke all on function public\.update_editable_bubble.*from public, anon, authenticated/i);
  assert.match(sql, /pages\.statut in[\s\S]*'not_started'[\s\S]*'in_progress'/i);
});

test('HTTP mutations delegate permission decisions to the transactional RPCs', () => {
  const bubbleRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'bulleRoutes.js'), 'utf8');
  const pageRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'pageRoutes.js'), 'utf8');
  const moderationRoutes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'moderationRoutes.js'), 'utf8');

  for (const rpc of [
    'create_editable_bubble',
    'update_editable_bubble',
    'delete_editable_bubble',
    'moderate_proposed_bubble',
  ]) {
    assert.match(bubbleRoutes, new RegExp(`rpc\\('${rpc}'`));
  }
  assert.match(pageRoutes, /rpc\('submit_page_for_review'/);
  assert.match(moderationRoutes, /\.eq\('statut', 'pending_review'\)/);
});
