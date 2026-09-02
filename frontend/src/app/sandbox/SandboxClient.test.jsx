import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import SandboxClient from './SandboxClient';

vi.mock('@/context/TauriLocalOcrContext', () => ({ useTauriLocalOcrContext: () => ({}) }));
vi.mock('@/hooks/useAiModelConfig', () => ({ useAiModelConfig: () => ({}) }));
vi.mock('@/hooks/useAnnotationInteractions', () => ({ useAnnotationInteractions: vi.fn(() => ({})) }));
vi.mock('@/hooks/useAnnotationOCR', () => ({ useAnnotationOCR: () => ({}) }));
vi.mock('@/hooks/useAnnotationDetection', () => ({ useAnnotationDetection: () => ({}) }));
vi.mock('@/hooks/useAnnotationMetadata', () => ({ useAnnotationMetadata: () => ({}) }));
vi.mock('@/lib/chatGptDesktop', () => ({ getChatGptStatus: async () => ({ available: false }), runChatGptPageOcr: vi.fn() }));
vi.mock('@/components/AnnotateLeftSidebar', () => ({ default: () => null }));
vi.mock('@/components/AnnotateCanvas', () => ({ default: () => null }));
vi.mock('@/components/AnnotateMetadataModal', () => ({ default: () => null }));
vi.mock('@/components/LocalOcrStatusIndicator', () => ({ default: () => null }));
vi.mock('@/components/AiAccessDialog', () => ({ default: () => null }));
vi.mock('@/components/AnnotateEditorDialog', () => ({
    default: ({ handleSuccess, isOpen, pendingAnnotation }) => (
        <>
            <button onClick={() => handleSuccess({
                id: 'local-bubble', texte_propose: 'Une annotation locale',
                statut: 'Proposé', id_user_createur: 'sandbox-user',
            })}>Ajouter le résultat OCR</button>
            {isOpen && <p>Édition : {pendingAnnotation.texte_propose}</p>}
        </>
    ),
}));

describe('Sandbox annotation permissions', () => {
    beforeEach(() => {
        localStorage.setItem('poneglyph-sandbox-guide-seen', 'true');
        vi.clearAllMocks();
    });

    afterEach(() => {
        localStorage.removeItem('poneglyph-sandbox-guide-seen');
        vi.restoreAllMocks();
    });

    it('renders, edits and deletes a local annotation with reordering enabled', async () => {
        render(<SandboxClient />);
        fireEvent.click(screen.getByRole('button', { name: 'Choisir l’extrait 1 de démonstration' }));
        fireEvent.click(screen.getByRole('button', { name: 'Ajouter le résultat OCR' }));

        const item = await screen.findByRole('listitem');
        expect(within(item).getByText('Une annotation locale')).toBeInTheDocument();
        expect(within(item).getByRole('button', { name: '' })).toHaveAttribute('aria-disabled', 'false');
        fireEvent.click(within(item).getByTitle('Modifier'));
        expect(screen.getByText('Édition : Une annotation locale')).toBeInTheDocument();

        vi.spyOn(window, 'confirm').mockReturnValue(true);
        fireEvent.click(within(item).getByTitle('Supprimer'));
        expect(screen.getByText('Aucune annotation')).toBeInTheDocument();
    });

    it('allows geometry edits for local bubbles', () => {
        render(<SandboxClient />);
        const options = useAnnotationInteractions.mock.lastCall[0];
        expect(options.canEditBubble({ id: 'local-bubble' })).toBe(true);
    });
});
