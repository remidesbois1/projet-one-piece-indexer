import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MangaRouteError from './error';

describe('MangaRouteError', () => {
    it('renders a visible fallback and delegates recovery to Next.js', () => {
        const reset = vi.fn();

        const error = new Error('Détail interne à ne pas exposer');
        error.digest = 'route-123';
        render(<MangaRouteError error={error} reset={reset} />);

        expect(screen.getByRole('alert')).toHaveTextContent('Une erreur inattendue');
        expect(screen.getByRole('alert')).toHaveTextContent('route-123');
        expect(screen.getByRole('alert')).not.toHaveTextContent('Détail interne');
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
        expect(reset).toHaveBeenCalledTimes(1);
    });
});
