import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdminLayout from './layout';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useAuth } from '@/context/AuthContext';
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
        useAuth.mockReturnValue({ isGuest: false });
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
        useAuth.mockReturnValue({ isGuest: false });
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
        useAuth.mockReturnValue({ isGuest: false });
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
        useAuth.mockReturnValue({ isGuest: true });
        useUserProfile.mockReturnValue({ profile: null, loading: false });

        render(
            <AdminLayout>
                <div data-testid="admin-content">Admin Content</div>
            </AdminLayout>
        );

        expect(screen.queryByTestId('admin-content')).not.toBeInTheDocument();
        expect(mockPush).toHaveBeenCalledWith('/test-manga/dashboard');
    });

    it('shows loading spinner while loading profile', () => {
        useAuth.mockReturnValue({ isGuest: false });
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
});
