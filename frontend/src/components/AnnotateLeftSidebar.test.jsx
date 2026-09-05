import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AnnotateLeftSidebar, { formatPageStatus } from './AnnotateLeftSidebar';

const editorProps = {
    mangaSlug: 'one-piece',
    page: { numero_page: 3, statut: 'in_progress', chapitres: { numero: 1 } },
    chapterPages: [1, 2, 3],
    navContext: { prev: null, next: null },
    role: 'Admin',
    selectedOcrModelKeys: [],
    detectionStatus: 'ready',
};

describe('AnnotateLeftSidebar', () => {
    it('renders the public reader when private workflow metadata is absent', () => {
        render(
            <AnnotateLeftSidebar
                mangaSlug="one-piece"
                page={{ id: 42, numero_page: 3 }}
                chapterPages={[]}
                navContext={{ prev: null, next: null }}
                isGuest
                role="Guest"
            />
        );

        expect(screen.getByText('lecture publique')).toBeInTheDocument();
    });

    it('keeps formatting authenticated workflow statuses', () => {
        expect(formatPageStatus('pending_review')).toBe('En revue');
    });

    it('runs only the chosen full-page engine', async () => {
        // jsdom does not implement the scrolling used by the Radix select.
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        HTMLElement.prototype.scrollIntoView = vi.fn();
        const poneglyph = vi.fn();
        const gemini = vi.fn();
        try {
            render(
                <AnnotateLeftSidebar
                    {...editorProps}
                    handleOneShotPoneglyph={poneglyph}
                    handleOneShot={gemini}
                />
            );
            fireEvent.keyDown(
                screen.getByRole('combobox', {
                    name: 'Moteur pour la page entière',
                }),
                { key: 'Enter' }
            );
            fireEvent.click(
                await screen.findByRole('option', { name: 'Gemini' })
            );
            fireEvent.click(
                screen.getByRole('button', { name: 'Lire la page entière' })
            );
            expect(gemini).toHaveBeenCalledOnce();
            expect(poneglyph).not.toHaveBeenCalled();
        } finally {
            if (originalScrollIntoView)
                HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
            else delete HTMLElement.prototype.scrollIntoView;
        }
    });

    it('takes a local engine from download to load to execution', () => {
        const download = vi.fn();
        const load = vi.fn();
        const run = vi.fn();
        const props = {
            ...editorProps,
            isTauri: true,
            handleOneShotLocalPoneglyph: run,
            downloadLocalModel: download,
            loadLocalModel: load,
        };
        const { rerender } = render(
            <AnnotateLeftSidebar
                {...props}
                localModelStatus={{ installed: false }}
            />
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Télécharger le modèle' })
        );
        expect(download).toHaveBeenCalledOnce();
        expect(run).not.toHaveBeenCalled();

        rerender(
            <AnnotateLeftSidebar
                {...props}
                localModelStatus={{ installed: true }}
            />
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Charger le modèle' })
        );
        expect(load).toHaveBeenCalledOnce();

        rerender(
            <AnnotateLeftSidebar
                {...props}
                localModelStatus={{ installed: true, ready: true }}
                canRunLocalOcr
            />
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Lire la page entière' })
        );
        expect(run).toHaveBeenCalledOnce();
    });

    it('shows download progress and prevents execution until the engine is ready', () => {
        render(
            <AnnotateLeftSidebar
                {...editorProps}
                isTauri
                handleOneShotLocalSuryaBbox={vi.fn()}
                isDownloadingLocalSuryaBBoxModel
                localSuryaBBoxDownloadProgress={42}
            />
        );
        expect(
            screen.getByRole('button', { name: 'Préparation en cours…' })
        ).toBeDisabled();
        expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42');
    });

    it('blocks local execution while the server is offline', () => {
        render(
            <AnnotateLeftSidebar
                {...editorProps}
                isTauri
                handleOneShotLocalPoneglyph={vi.fn()}
                canRunLocalOcr
                localModelStatus={{ installed: true, ready: true }}
                localConnectionState={{ status: 'offline' }}
            />
        );
        expect(
            screen.getByRole('button', { name: 'Lire la page entière' })
        ).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent(
            'Serveur local indisponible.'
        );
    });

    it('prevents competing actions during full-page OCR', () => {
        render(
            <AnnotateLeftSidebar
                {...editorProps}
                handleOneShot={vi.fn()}
                isOneShotLoading
            />
        );
        expect(
            screen.getByRole('combobox', {
                name: 'Moteur pour la page entière',
            })
        ).toBeDisabled();
        expect(
            screen.getByRole('button', { name: 'Lecture en cours…' })
        ).toBeDisabled();
        expect(
            screen.getByRole('button', { name: 'Détecter les bulles' })
        ).toBeDisabled();
        expect(
            screen.getByRole('button', { name: 'Envoyer en validation' })
        ).toBeDisabled();
    });
});
