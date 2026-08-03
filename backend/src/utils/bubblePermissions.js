const EDITABLE_PAGE_STATUSES = new Set(['not_started', 'in_progress']);
const REVIEWABLE_PAGE_STATUSES = new Set([...EDITABLE_PAGE_STATUSES, 'pending_review']);
const STAFF_ROLES = new Set(['Admin', 'Modo']);
const UNMODERATED_BUBBLE_STATUS = 'Proposé';

function isStaff(user) {
  return STAFF_ROLES.has(user?.role);
}

function canCreateBubble(user, page) {
  return Boolean(user?.id && EDITABLE_PAGE_STATUSES.has(page?.statut));
}

function canEditBubble(user, bubble, page) {
  if (!user?.id || !bubble || bubble.statut !== UNMODERATED_BUBBLE_STATUS) return false;
  if (isStaff(user)) return REVIEWABLE_PAGE_STATUSES.has(page?.statut);
  return bubble.id_user_createur === user.id && EDITABLE_PAGE_STATUSES.has(page?.statut);
}

function canDeleteBubble(user, bubble, page) {
  if (user?.role === 'Admin') return Boolean(user.id && bubble);
  return canEditBubble(user, bubble, page) && bubble.id_user_createur === user?.id;
}

function canSubmitPage(user, page, bubbleCount) {
  return isStaff(user)
    && EDITABLE_PAGE_STATUSES.has(page?.statut)
    && Number.isSafeInteger(bubbleCount)
    && bubbleCount > 0;
}

function mapBubbleMutationError(error, fallbackMessage) {
  const code = error?.code;
  if (code === 'P0002' || code === 'PGRST116') {
    return { status: 404, message: error?.message || 'Ressource introuvable.' };
  }
  if (code === '42501') {
    return { status: 403, message: error?.message || 'Action refusée.' };
  }
  if (code === '55000' || code === '40001' || code === '23505') {
    return { status: 409, message: error?.message || 'La ressource a changé.' };
  }
  if (['22003', '22023', '22P02', '23502', '23514'].includes(code)) {
    return { status: 400, message: error?.message || 'Données invalides.' };
  }
  return { status: 500, message: fallbackMessage };
}

module.exports = {
  EDITABLE_PAGE_STATUSES,
  REVIEWABLE_PAGE_STATUSES,
  UNMODERATED_BUBBLE_STATUS,
  canCreateBubble,
  canDeleteBubble,
  canEditBubble,
  canSubmitPage,
  isStaff,
  mapBubbleMutationError,
};
