import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useManga } from '@/context/MangaContext';
import { getCovers, uploadCover } from '@/lib/api';
import CoverManager from './CoverManager';

vi.mock('@/context/MangaContext', () => ({ useManga: vi.fn() }));
vi.mock('@/lib/api', () => ({ getCovers: vi.fn(), uploadCover: vi.fn() }));

describe('CoverManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useManga.mockReturnValue({ mangaSlug: 'one-piece' });
        uploadCover.mockResolvedValue({ data: {} });
    });

    it('shows a recoverable error instead of disappearing and retries the request', async () => {
        getCovers
            .mockRejectedValueOnce(new Error('Stockage indisponible'))
            .mockResolvedValueOnce({
                data: {
                    manga: { id: 1, titre: 'One Piece', cover_url: null },
                    tomes: [],
                },
            });

        render(<CoverManager />);

        expect(await screen.findByRole('alert')).toHaveTextContent('Stockage indisponible');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(await screen.findByText('Identité Visuelle')).toBeInTheDocument();
        expect(getCovers).toHaveBeenCalledTimes(2);
    });

    it('ignores a response from the previous manga after the slug changes', async () => {
        let resolveFirstRequest;
        getCovers
            .mockImplementationOnce(() => new Promise(resolve => { resolveFirstRequest = resolve; }))
            .mockResolvedValueOnce({
                data: {
                    manga: { id: 2, titre: 'Naruto', cover_url: null },
                    tomes: [],
                },
            });

        const { rerender } = render(<CoverManager />);
        useManga.mockReturnValue({ mangaSlug: 'naruto' });
        rerender(<CoverManager />);

        expect(await screen.findByText('Naruto')).toBeInTheDocument();
        resolveFirstRequest({
            data: {
                manga: { id: 1, titre: 'One Piece', cover_url: null },
                tomes: [],
            },
        });

        await waitFor(() => expect(screen.queryByText('One Piece')).not.toBeInTheDocument());
        expect(screen.getByText('Naruto')).toBeInTheDocument();
    });
});
