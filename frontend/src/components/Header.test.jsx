import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Header from './Header';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useManga } from '@/context/MangaContext';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

// Mock the hooks
vi.mock('@/context/AuthContext');
vi.mock('@/hooks/useUserProfile');
vi.mock('@/context/MangaContext');
vi.mock('next/navigation', () => ({
    usePathname: vi.fn(),
    useRouter: vi.fn(),
    useSearchParams: vi.fn(),
}));

// Mock ResizeObserver (needed by some Radix UI components)
global.ResizeObserver = class {
    observe() { }
    unobserve() { }
    disconnect() { }
};

describe('Header Links Access Roles', () => {
    beforeEach(() => {
        vi.clearAllMocks();

        // Default mocks that apply to all test cases
        useManga.mockReturnValue({ mangaSlug: 'test-manga' });
        usePathname.mockReturnValue('/test-manga/dashboard');

        // Mock useSearchParams to return something realistic
        const mockSearchParams = new URLSearchParams();
        useSearchParams.mockReturnValue(mockSearchParams);
        useRouter.mockReturnValue({ push: vi.fn() });
    });

    it('shows public links only for Guest users', () => {
        useAuth.mockReturnValue({ user: null, isGuest: true });
        useUserProfile.mockReturnValue({ profile: null });

        render(<Header onOpenApiKeyModal={vi.fn()} />);

        // Only checking within the desktop nav for simplicity
        const nav = screen.getByRole('navigation', { hidden: true }); // Desktop nav doesn't have a specific role sometimes but let's query the text

        // Public links
        expect(screen.queryAllByText('Bibliothèque').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Recherche').length).toBeGreaterThan(0);

        // Authenticated links should not be present in the desktop nav (which doesn't hide text, while mobile nav might conditionally render)
        // Check exact texts for the links
        expect(screen.queryByText('Mes Soumissions')).not.toBeInTheDocument();
        expect(screen.queryByText('Modération')).not.toBeInTheDocument();
        expect(screen.queryByText('Admin')).not.toBeInTheDocument();
        expect(screen.queryByText('Explorateur')).not.toBeInTheDocument();
    });

    it('shows User links for authenticated users without special roles', () => {
        useAuth.mockReturnValue({ user: { email: 'user@test.com' }, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'User' } });

        render(<Header onOpenApiKeyModal={vi.fn()} />);

        // Public and User links
        expect(screen.queryAllByText('Bibliothèque').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Recherche').length).toBeGreaterThan(0);

        // "Mes Soumissions" appears in desktop nav, mobile nav, and dropdown menu. We check if it's there at all.
        expect(screen.queryAllByText('Mes Soumissions').length).toBeGreaterThan(0);

        // Elevated privileges shouldn't be there
        expect(screen.queryByText('Modération')).not.toBeInTheDocument();
        expect(screen.queryByText('Admin')).not.toBeInTheDocument();
        expect(screen.queryByText('Explorateur')).not.toBeInTheDocument();
    });

    it('shows Modo links for Moderators', () => {
        useAuth.mockReturnValue({ user: { email: 'modo@test.com' }, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'Modo' } });

        render(<Header onOpenApiKeyModal={vi.fn()} />);

        expect(screen.queryAllByText('Mes Soumissions').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Modération').length).toBeGreaterThan(0);

        // Admin limits
        expect(screen.queryByText('Admin')).not.toBeInTheDocument();
        expect(screen.queryByText('Explorateur')).not.toBeInTheDocument();
    });

    it('shows all links for Admins', () => {
        useAuth.mockReturnValue({ user: { email: 'admin@test.com' }, isGuest: false });
        useUserProfile.mockReturnValue({ profile: { role: 'Admin' } });

        render(<Header onOpenApiKeyModal={vi.fn()} />);

        expect(screen.queryAllByText('Mes Soumissions').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Modération').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Admin').length).toBeGreaterThan(0);
        expect(screen.queryAllByText('Explorateur').length).toBeGreaterThan(0);
    });
});
