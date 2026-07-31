import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdminLayout from './layout';
import { useUserProfile } from '@/hooks/useUserProfile';
import { AUTH_STATUS, useAuth } from '@/context/AuthContext';
import { useRouter, useParams } from 'next/navigation';


vi.mock('@/hooks/useUserProfile');
vi.mock('@/context/AuthContext');
vi.mock('next/navigation', () => ({
    useRouter: vi.fn(),
    useParams: vi.fn(),
}));

describe('AdminLayout Access', () => {
    let mockPush;

    beforeEach(() => {
        vi.clearAllMocks();
        mockPush = vi.fn();
        useRouter.mockReturnValue({ push: mockPush });
        useParams.mockReturnValue({ mangaSlug: 'test-manga' });
    });

    it('renders children when user is Admin', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'Admin' }, loading: false });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(screen.getByTestId('admin-content')).toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('redirects to dashboard when user is Modo', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'Modo' }, loading: false });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
        expect(mockPush).toHaveBeenCalledWith('/test-manga/dashboard');
    });

    it('redirects to dashboard when user is regular user', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'User' }, loading: false });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
        expect(mockPush).toHaveBeenCalledWith('/test-manga/dashboard');
    });

    it('redirects to dashboard when user is guest', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.GUEST, isGuest: true });
        useUserProfile.mockReturnValue({ profile: null, loading: false });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
        expect(mockPush).toHaveBeenCalledWith('/test-manga/dashboard');
    });

    it('waits for a late role without redirecting', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: null, loading: true });

        const { container } = render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(container.querySelector('.animate-spin')).toBeInTheDocument();
        expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('shows a retry action instead of redirecting when role loading fails', () => {
        const retry = vi.fn();
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({
            profile: null,
            loading: false,
            error: new Error('Permissions indisponibles'),
            retry,
        });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );
        fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

        expect(screen.getByRole('alert')).toHaveTextContent('Permissions indisponibles');
        expect(retry).toHaveBeenCalledTimes(1);
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('lets the parent layout handle unauthenticated redirects', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.UNAUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: null, loading: false });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
    });
});
