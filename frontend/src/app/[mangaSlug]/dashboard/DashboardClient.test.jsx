import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useManga } from '@/context/MangaContext';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useRouter } from 'next/navigation';
import { getTomes, getChapitres, getPages } from '@/lib/api';
import DashboardClient from './DashboardClient';

vi.mock('@/context/MangaContext', () => ({ useManga: vi.fn() }));
vi.mock('@/context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/useUserProfile', () => ({ useUserProfile: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('@/lib/api', () => ({
    getTomes: vi.fn(),
    getChapitres: vi.fn(),
    getPages: vi.fn(),
    deleteBubblesForChapter: vi.fn(),
    deleteBubblesForPage: vi.fn(),
}));
vi.mock('@/components/CoverThumbnailImage', () => ({
    default: ({ alt }) => <div aria-label={alt} />,
}));
vi.mock('@/components/ui/sheet', () => ({
    Sheet: ({ children }) => <div>{children}</div>,
    SheetContent: ({ children }) => <div>{children}</div>,
    SheetHeader: ({ children }) => <div>{children}</div>,
    SheetTitle: ({ children }) => <h2>{children}</h2>,
    SheetDescription: ({ children }) => <p>{children}</p>,
}));
vi.mock('@/components/ui/scroll-area', () => ({ ScrollArea: ({ children }) => <div>{children}</div> }));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const volumes = [
    { id: 1, numero: 1, titre: 'Premier volume', cover_url: null },
    { id: 2, numero: 2, titre: 'Second volume', cover_url: null },
];

describe('DashboardClient async states', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useManga.mockReturnValue({ mangaSlug: 'one-piece', currentManga: { titre: 'One Piece' } });
        useAuth.mockReturnValue({ session: null });
        useUserProfile.mockReturnValue({ profile: null, loading: true });
        useRouter.mockReturnValue({ push: vi.fn() });
        getChapitres.mockResolvedValue({ data: [] });
        getPages.mockResolvedValue({ data: [] });
    });

    it('renders a catalogue skeleton instead of a blank page while loading', () => {
        getTomes.mockReturnValue(new Promise(() => {}));

        const { container } = render(<DashboardClient />);

        expect(screen.getByRole('heading', { name: /Bibliothèque One Piece/i })).toBeInTheDocument();
        expect(container.querySelectorAll('.animate-pulse')).toHaveLength(5);
    });

    it('distinguishes a failed catalogue from an empty catalogue and retries', async () => {
        getTomes
            .mockRejectedValueOnce(new Error('Catalogue indisponible'))
            .mockResolvedValueOnce({ data: [] });

        render(<DashboardClient />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Catalogue indisponible');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(await screen.findByText('Aucun volume disponible')).toBeInTheDocument();
        expect(getTomes).toHaveBeenCalledTimes(2);
    });

    it('ignores an older chapter response after another volume is selected', async () => {
        const firstRequest = deferred();
        getTomes.mockResolvedValue({ data: volumes });
        getChapitres
            .mockReturnValueOnce(firstRequest.promise)
            .mockResolvedValueOnce({ data: [{ id: 22, numero: 22, titre: 'Chapitre récent', global_status: 'empty' }] });

        render(<DashboardClient />);
        fireEvent.click((await screen.findByText('Premier volume')).closest('article'));
        fireEvent.click(screen.getByText('Second volume').closest('article'));

        expect(await screen.findByText('Chapitre 22')).toBeInTheDocument();
        firstRequest.resolve({ data: [{ id: 11, numero: 11, titre: 'Chapitre obsolète', global_status: 'empty' }] });

        await waitFor(() => expect(screen.queryByText('Chapitre 11')).not.toBeInTheDocument());
        expect(screen.getByText('Chapitre 22')).toBeInTheDocument();
    });

    it('does not expose chapters from the previous volume when the next request fails', async () => {
        getTomes.mockResolvedValue({ data: volumes });
        getChapitres
            .mockResolvedValueOnce({ data: [{ id: 11, numero: 11, titre: 'Ancien chapitre', global_status: 'empty' }] })
            .mockRejectedValueOnce(new Error('Chapitres indisponibles'));

        render(<DashboardClient />);
        fireEvent.click((await screen.findByText('Premier volume')).closest('article'));
        expect(await screen.findByText('Chapitre 11')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Second volume').closest('article'));

        expect(await screen.findByRole('alert')).toHaveTextContent('Chapitres indisponibles');
        expect(screen.queryByText('Chapitre 11')).not.toBeInTheDocument();
    });

    it('shows a recoverable page error in the drawer and retries the selected chapter', async () => {
        getTomes.mockResolvedValue({ data: [volumes[0]] });
        getChapitres.mockResolvedValue({
            data: [{ id: 11, numero: 11, titre: 'Chapitre test', global_status: 'empty' }],
        });
        getPages
            .mockRejectedValueOnce(new Error('Pages indisponibles'))
            .mockResolvedValueOnce({ data: [{ id: 101, numero_page: 1, statut: 'not_started' }] });

        render(<DashboardClient />);
        fireEvent.click((await screen.findByText('Premier volume')).closest('article'));
        fireEvent.click(await screen.findByText('Chapitre 11'));

        expect(await screen.findByRole('alert')).toHaveTextContent('Pages indisponibles');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(await screen.findByTitle('Page 1 - not_started')).toBeInTheDocument();
        expect(getPages).toHaveBeenCalledTimes(2);
    });
});
