import { describe, expect, it } from 'vitest';

import {
    canCreateBubble,
    canDeleteBubble,
    canEditBubble,
    canReorderBubbles,
} from './bubblePermissions';

const editablePage = { id: 1, statut: 'in_progress' };
const user = { id: 'user-1' };
const ownProposed = { id: 1, id_user_createur: 'user-1', statut: 'Proposé' };

describe('bubble reorder permissions', () => {
    it('allows staff only while the page is editable', () => {
        expect(canReorderBubbles({ page: editablePage, user, role: 'Admin', isGuest: false, bubbles: [ownProposed] })).toBe(true);
        expect(canReorderBubbles({ page: editablePage, user, role: 'Modo', isGuest: false, bubbles: [ownProposed] })).toBe(true);
        expect(canReorderBubbles({
            page: { ...editablePage, statut: 'pending_review' }, user, role: 'Admin', isGuest: false, bubbles: [ownProposed],
        })).toBe(false);
        expect(canReorderBubbles({
            page: editablePage, user, role: 'Admin', isGuest: false, bubbles: [{ ...ownProposed, statut: 'Validé' }],
        })).toBe(false);
    });

    it('allows a creator only for a complete set of own proposed bubbles', () => {
        expect(canReorderBubbles({
            page: editablePage,
            user,
            role: 'User',
            isGuest: false,
            bubbles: [ownProposed, { ...ownProposed, id: 2 }],
        })).toBe(true);
        expect(canReorderBubbles({
            page: editablePage,
            user,
            role: 'User',
            isGuest: false,
            bubbles: [ownProposed, { ...ownProposed, id: 2, id_user_createur: 'other' }],
        })).toBe(false);
        expect(canReorderBubbles({
            page: editablePage,
            user,
            role: 'User',
            isGuest: false,
            bubbles: [{ ...ownProposed, statut: 'Validé' }],
        })).toBe(false);
    });

    it('rejects guests, missing users and empty creator lists', () => {
        expect(canReorderBubbles({ page: editablePage, user, role: 'User', isGuest: true, bubbles: [ownProposed] })).toBe(false);
        expect(canReorderBubbles({ page: editablePage, user: null, role: 'User', isGuest: false, bubbles: [ownProposed] })).toBe(false);
        expect(canReorderBubbles({ page: editablePage, user, role: 'User', isGuest: false, bubbles: [] })).toBe(false);
    });
});

describe('bubble mutation permissions', () => {
    it('only exposes page creation controls to staff on editable pages', () => {
        expect(canCreateBubble({ page: editablePage, user, role: 'Admin', isGuest: false })).toBe(true);
        expect(canCreateBubble({ page: editablePage, user, role: 'Modo', isGuest: false })).toBe(true);
        expect(canCreateBubble({ page: editablePage, user, role: 'User', isGuest: false })).toBe(false);
        expect(canCreateBubble({ page: { ...editablePage, statut: 'completed' }, user, role: 'Admin', isGuest: false })).toBe(false);
    });

    it('never offers generic editing for moderated bubbles', () => {
        const context = { page: editablePage, user, role: 'Admin', isGuest: false };
        expect(canEditBubble({ ...context, bubble: ownProposed })).toBe(true);
        expect(canEditBubble({ ...context, bubble: { ...ownProposed, statut: 'Validé' } })).toBe(false);
        expect(canEditBubble({ ...context, bubble: { ...ownProposed, statut: 'Rejeté' } })).toBe(false);
        expect(canEditBubble({
            ...context,
            page: { ...editablePage, statut: 'pending_review' },
            role: 'Modo',
            bubble: { ...ownProposed, id_user_createur: 'other' },
        })).toBe(true);
    });

    it('keeps terminal deletion as an explicit admin override', () => {
        expect(canDeleteBubble({
            page: { ...editablePage, statut: 'completed' }, user, role: 'Admin', isGuest: false,
            bubble: { ...ownProposed, statut: 'Validé' },
        })).toBe(true);
        expect(canDeleteBubble({
            page: editablePage, user, role: 'User', isGuest: false,
            bubble: { ...ownProposed, statut: 'Validé' },
        })).toBe(false);
    });
});
