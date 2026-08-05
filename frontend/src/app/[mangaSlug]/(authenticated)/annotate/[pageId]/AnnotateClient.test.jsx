import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useManga } from '@/context/MangaContext';
import { useTauriLocalOcrContext } from '@/context/TauriLocalOcrContext';
import { useAnnotationInteractions } from '@/hooks/useAnnotationInteractions';
import { useAnnotationOCR } from '@/hooks/useAnnotationOCR';
import { useAnnotationDetection } from '@/hooks/useAnnotationDetection';
import { useAnnotationMetadata } from '@/hooks/useAnnotationMetadata';
import { fetchOriginalPageImage } from '@/lib/pageImageClient';
import {
    getPageById,
    getBubblesForPage,
    getPages,
    updatePageStatus,
} from '@/lib/api';
import AnnotateClient from './AnnotateClient';

vi.mock('next/navigation', () => ({ useParams: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('@/context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/context/MangaContext', () => ({ useManga: vi.fn() }));
vi.mock('@/context/TauriLocalOcrContext', () => ({ useTauriLocalOcrContext: vi.fn() }));
vi.mock('@/hooks/useAnnotationInteractions', () => ({ useAnnotationInteractions: vi.fn() }));
vi.mock('@/hooks/useAnnotationOCR', () => ({ useAnnotationOCR: vi.fn() }));
vi.mock('@/hooks/useAnnotationDetection', () => ({ useAnnotationDetection: vi.fn() }));
vi.mock('@/hooks/useAnnotationMetadata', () => ({ useAnnotationMetadata: vi.fn() }));
vi.mock('@/lib/pageImageClient', () => ({ fetchOriginalPageImage: vi.fn() }));
vi.mock('@/lib/bubblePermissions', () => ({
    canCreateBubble: vi.fn(() => true),
    canEditBubble: vi.fn(() => true),
    canReorderBubbles: vi.fn(() => true),
}));
vi.mock('@/lib/api', () => ({
    getPageById: vi.fn(),
    getBubblesForPage: vi.fn(),
    getPages: vi.fn(),
    updatePageStatus: vi.fn(),
    deleteBubble: vi.fn(),
    submitPageForReview: vi.fn(),
    reorderBubbles: vi.fn(),
    savePageDescription: vi.fn(),
    getMetadataSuggestions: vi.fn(),
}));
vi.mock('@/lib/geminiClient', () => ({
    analyzeBubble: vi.fn(),
    generatePageDescription: vi.fn(),
    generateGeminiEmbedding: vi.fn(),
    generateOneShotBubbles: vi.fn(),
}));
vi.mock('@/lib/ocrProxyClient', () => ({ postOcrImage: vi.fn() }));
vi.mock('@/components/ApiKeyForm', () => ({ default: () => null }));
vi.mock('@/components/AnnotateLeftSidebar', () => ({
    default: ({ page, navContext, goToNext, handlePageStatusChange, canEdit }) => (
        <aside>
            <span>{`editor-page-${page.id}-${page.statut}`}</span>
            <span>{`sidebar-edit-${String(canEdit)}`}</span>
            <button type="button" onClick={() => handlePageStatusChange('completed')}>Valider la page</button>
            <button type="button" onClick={goToNext} disabled={!navContext.next}>Page suivante</button>
        </aside>
    ),
}));
vi.mock('@/components/AnnotateCanvas', () => {
    function MockAnnotateCanvas({ canEdit, imageKey, onImageLoad }) {
        useEffect(() => { onImageLoad?.(); }, [imageKey, onImageLoad]);
        return <div data-testid="annotation-canvas" data-can-edit={String(canEdit)} />;
    }
    return { default: MockAnnotateCanvas };
});
vi.mock('@/components/AnnotateAnnotationSidebar', () => ({ default: () => <div data-testid="annotation-sidebar" /> }));
vi.mock('@/components/AnnotateEditorDialog', () => ({ default: () => null }));
vi.mock('@/components/AnnotateMetadataModal', () => ({ default: () => null }));
vi.mock('@/components/ui/dialog', () => ({
    Dialog: ({ children }) => <div>{children}</div>,
    DialogContent: ({ children }) => <div>{children}</div>,
    DialogHeader: ({ children }) => <div>{children}</div>,
    DialogTitle: ({ children }) => <h2>{children}</h2>,
    DialogDescription: ({ children }) => <p>{children}</p>,
}));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const pageOne = {
    id: 1,
    id_chapitre: 10,
    numero_page: 1,
    statut: 'in_progress',
    url_image: 'pages/1.jpg',
    chapitres: { numero: 1, tomes: { numero: 1 } },
};
const pageTwo = {
    ...pageOne,
    id: 2,
    numero_page: 2,
    statut: 'not_started',
    url_image: 'pages/2.jpg',
};

describe('AnnotateClient async states', () => {
    beforeAll(() => {
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:page-image') });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    });

    beforeEach(() => {
        vi.clearAllMocks();
        window.history.replaceState({}, '', '/one-piece/annotate/1');
        useParams.mockReturnValue({ pageId: '1' });
        useRouter.mockReturnValue({ prefetch: vi.fn() });
        useSearchParams.mockReturnValue({ get: vi.fn(() => null) });
        useAuth.mockReturnValue({
            user: { id: 'admin-id' },
            session: { access_token: 'token' },
            isGuest: false,
            role: 'Admin',
        });
        useManga.mockReturnValue({ mangaSlug: 'one-piece', currentManga: { titre: 'One Piece' } });
        useTauriLocalOcrContext.mockReturnValue({});
        useAnnotationInteractions.mockReturnValue({
            isDrawing: false,
            startPoint: null,
            endPoint: null,
            mousePos: null,
            isShiftPressed: false,
            hoveredBubble: null,
            setHoveredBubble: vi.fn(),
            handleMouseDown: vi.fn(),
            handleMouseMove: vi.fn(),
            handleMouseUp: vi.fn(),
            handleInteractionStart: vi.fn(),
        });
        useAnnotationOCR.mockReturnValue({
            preferLocalOCR: false,
            toggleOcrPreference: vi.fn(),
            geminiKey: 'key',
            activeModelKey: 'test',
            modelStatus: 'ready',
            loadModel: vi.fn(),
            switchModel: vi.fn(),
            downloadProgress: 100,
            runLocalOcr: vi.fn(),
            runBackgroundOcr: vi.fn(),
            ocrResults: [],
            handleRetryWithCloud: vi.fn(),
            selectedOcrModelKeys: [],
            toggleOcrModel: vi.fn(),
        });
        useAnnotationDetection.mockReturnValue({
            isAutoDetecting: false,
            setIsAutoDetecting: vi.fn(),
            queueLength: 0,
            detectionStatus: 'ready',
            loadDetectionModel: vi.fn(),
            detectionProgress: 100,
            downloadStats: null,
            handleExecuteDetection: vi.fn(),
            processNextBubble: vi.fn(),
            detectBubbles: vi.fn(),
        });
        useAnnotationMetadata.mockReturnValue({
            formData: {},
            setFormData: vi.fn(),
            suggestions: [],
            charInput: '',
            setCharInput: vi.fn(),
            isSavingDesc: false,
            isGeneratingAI: false,
            tabMode: 'form',
            setTabMode: vi.fn(),
            jsonInput: '',
            jsonError: null,
            handleJsonChange: vi.fn(),
            handleSaveDescription: vi.fn(),
            handleGenerateAI: vi.fn(),
            addCharacter: vi.fn(),
            removeCharacter: vi.fn(),
        });
        fetchOriginalPageImage.mockResolvedValue(new Blob(['image'], { type: 'image/jpeg' }));
        getPageById.mockImplementation(id => Promise.resolve({ data: String(id) === '2' ? pageTwo : pageOne }));
        getBubblesForPage.mockResolvedValue({ data: [] });
        getPages.mockResolvedValue({ data: [pageOne, pageTwo] });
    });

    it('renders a skeleton instead of an empty document while metadata loads', () => {
        getPageById.mockReturnValue(new Promise(() => {}));
        getBubblesForPage.mockReturnValue(new Promise(() => {}));
        fetchOriginalPageImage.mockReturnValue(new Promise(() => {}));

        render(<AnnotateClient />);

        expect(screen.getByRole('status')).toHaveTextContent('Chargement des métadonnées');
        expect(screen.queryByTestId('annotation-canvas')).not.toBeInTheDocument();
    });

    it('shows a recoverable metadata error and reaches the editor after retry', async () => {
        getPageById
            .mockRejectedValueOnce(new Error('Métadonnées indisponibles'))
            .mockResolvedValueOnce({ data: pageOne });

        render(<AnnotateClient />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Métadonnées indisponibles');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(await screen.findByText('editor-page-1-in_progress')).toBeInTheDocument();
    });

    it('retries a failed secure image without reloading the route', async () => {
        fetchOriginalPageImage
            .mockRejectedValueOnce(new Error('Image sécurisée indisponible'))
            .mockResolvedValueOnce(new Blob(['image'], { type: 'image/jpeg' }));

        render(<AnnotateClient />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Image sécurisée indisponible');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(await screen.findByText('editor-page-1-in_progress')).toBeInTheDocument();
        expect(fetchOriginalPageImage.mock.calls.filter(([requestedPageId]) => String(requestedPageId) === '1')).toHaveLength(2);
    });

    it('keeps annotation editing disabled after a bubble load failure and recovers on retry', async () => {
        getBubblesForPage
            .mockRejectedValueOnce(new Error('Bulles indisponibles'))
            .mockResolvedValueOnce({ data: [] });

        render(<AnnotateClient />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Bulles indisponibles');
        expect(screen.getByTestId('annotation-canvas')).toHaveAttribute('data-can-edit', 'false');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        await waitFor(() => expect(screen.getByTestId('annotation-canvas')).toHaveAttribute('data-can-edit', 'true'));
    });

    it('updates only the targeted page when a status response arrives after navigation', async () => {
        const statusRequest = deferred();
        updatePageStatus.mockReturnValue(statusRequest.promise);

        render(<AnnotateClient />);
        expect(await screen.findByText('editor-page-1-in_progress')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Valider la page' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Page suivante' })).toBeEnabled());
        fireEvent.click(screen.getByRole('button', { name: 'Page suivante' }));
        expect(await screen.findByText('editor-page-2-not_started')).toBeInTheDocument();

        statusRequest.resolve({ data: { ...pageOne, statut: 'completed' } });

        await waitFor(() => expect(screen.getByText('editor-page-2-not_started')).toBeInTheDocument());
        expect(screen.queryByText('editor-page-1-completed')).not.toBeInTheDocument();
        expect(updatePageStatus).toHaveBeenCalledWith('1', 'completed');
    });
});
