import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STATUS, useAuth } from '@/context/AuthContext';
import { useRouter } from 'next/navigation';
import AuthenticatedLayout from './layout';

vi.mock('@/context/AuthContext', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, useAuth: vi.fn() };
});
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

describe('AuthenticatedLayout', () => {
    let push;

    beforeEach(() => {
        vi.clearAllMocks();
        push = vi.fn();
        useRouter.mockReturnValue({ push });
    });

    it('renders a loading state while authentication initializes', () => {
        useAuth.mockReturnValue({
            authStatus: AUTH_STATUS.LOADING,
            loading: true,
            error: null,
            retry: vi.fn(),
        });

        const { container } = render(
            <AuthenticatedLayout><div>Private</div></AuthenticatedLayout>
        );

        expect(container.querySelector('.animate-spin')).toBeInTheDocument();
        expect(screen.queryByText('Private')).not.toBeInTheDocument();
        expect(push).not.toHaveBeenCalled();
    });

    it('shows a recoverable error without redirecting', () => {
        const retry = vi.fn();
        useAuth.mockReturnValue({
            authStatus: AUTH_STATUS.ERROR,
            loading: false,
            error: new Error('Réseau indisponible'),
            retry,
        });

        render(<AuthenticatedLayout><div>Private</div></AuthenticatedLayout>);
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(screen.getByRole('alert')).toHaveTextContent('Réseau indisponible');
        expect(retry).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalled();
    });

    it('redirects only after authentication resolves as unauthenticated', () => {
        useAuth.mockReturnValue({
            authStatus: AUTH_STATUS.UNAUTHENTICATED,
            loading: false,
            error: null,
            retry: vi.fn(),
        });

        render(<AuthenticatedLayout><div>Private</div></AuthenticatedLayout>);

        expect(screen.queryByText('Private')).not.toBeInTheDocument();
        expect(push).toHaveBeenCalledWith('/login?next=%2F');
    });

    it.each([AUTH_STATUS.AUTHENTICATED, AUTH_STATUS.GUEST])(
        'renders children for %s access',
        (authStatus) => {
            useAuth.mockReturnValue({
                authStatus,
                loading: false,
                error: null,
                retry: vi.fn(),
            });

            render(<AuthenticatedLayout><div>Private</div></AuthenticatedLayout>);

            expect(screen.getByText('Private')).toBeInTheDocument();
            expect(push).not.toHaveBeenCalled();
        }
    );
});
