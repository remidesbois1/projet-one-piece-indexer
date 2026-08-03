const EDITABLE_PAGE_STATUSES = new Set(['not_started', 'in_progress']);
const REVIEWABLE_PAGE_STATUSES = new Set([...EDITABLE_PAGE_STATUSES, 'pending_review']);
const STAFF_ROLES = new Set(['Admin', 'Modo']);
const UNMODERATED_BUBBLE_STATUS = 'Proposé';

export function canCreateBubble({ page, user, role, isGuest }) {
    return Boolean(
        page && user && !isGuest && STAFF_ROLES.has(role) && EDITABLE_PAGE_STATUSES.has(page.statut)
    );
}

export function canEditBubble({ page, user, role, isGuest, bubble }) {
    if (!page || !user || isGuest || !bubble || bubble.statut !== UNMODERATED_BUBBLE_STATUS) return false;
    if (STAFF_ROLES.has(role)) return REVIEWABLE_PAGE_STATUSES.has(page.statut);
    return bubble.id_user_createur === user.id && EDITABLE_PAGE_STATUSES.has(page.statut);
}

export function canDeleteBubble(context) {
    if (context?.role === 'Admin') return Boolean(context?.user && context?.bubble);
    return canEditBubble(context) && context.bubble.id_user_createur === context.user.id;
}

export function canReorderBubbles({ page, user, role, isGuest, bubbles }) {
    if (!page || isGuest || !user || !EDITABLE_PAGE_STATUSES.has(page.statut)) return false;
    if (!Array.isArray(bubbles) || bubbles.length === 0) return false;
    if (bubbles.some((bubble) => bubble.statut !== UNMODERATED_BUBBLE_STATUS)) return false;
    if (STAFF_ROLES.has(role)) return true;
    return bubbles.every((bubble) => (
        bubble.id_user_createur === user.id
    ));
}
