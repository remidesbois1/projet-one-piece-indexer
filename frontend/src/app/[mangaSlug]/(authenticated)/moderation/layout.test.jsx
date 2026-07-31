import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ModerationLayout from './layout';
import { useUserProfile } from '@/hooks/useUserProfile';
import { AUTH_STATUS, useAuth } from '@/context/AuthContext';
import { useRouter, useParams } from 'next/navigation';


vi.mock('@/hooks/useUserProfile');
vi.mock('@/context/AuthContext');
vi.mock('next/navigation', () => ({
    useRouter: vi.fn(),
    useParams: vi.fn(),
}));

describe('ModerationLayout Access', () => {
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
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
        );

        expect(screen.getByTestId('modo-content')).toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('renders children when user is Modo', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'Modo' }, loading: false });

        render(
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
        );

        expect(screen.getByTestId('modo-content')).toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('redirects to dashboard when user is regular user', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'User' }, loading: false });

        render(
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
        );

        expect(screen.queryByTestId('modo-content')).not.toBeInTheDocument();
        expect(mockPush).toHaveBeenCalledWith('/test-manga/dashboard');
    });

    it('redirects to dashboard when user is guest', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.GUEST, isGuest: true });
        useUserProfile.mockReturnValue({ profile: null, loading: false });

        render(
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
        );

        expect(screen.queryByTestId('modo-content')).not.toBeInTheDocument();
        expect(mockPush).toHaveBeenCalledWith('/test-manga/dashboard');
    });

    it('waits for a late role without redirecting', () => {
        useAuth.mockReturnValue({ authStatus: AUTH_STATUS.AUTHENTICATED, isGuest: false });
        useUserProfile.mockReturnValue({ profile: null, loading: true });

        const { container } = render(
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
        );

        expect(container.querySelector('.animate-spin')).toBeInTheDocument();
        expect(screen.queryByTestId('modo-content')).not.toBeInTheDocument();
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
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
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
            <ModerationLayout>
                <div data-testid="modo-content">Moderation Content</div>
            </ModerationLayout>
        );

        expect(screen.queryByTestId('modo-content')).not.toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
    });
});
