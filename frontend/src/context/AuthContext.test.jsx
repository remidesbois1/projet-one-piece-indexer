import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { supabase } from '@/lib/supabaseClient';


vi.mock('@/lib/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
            onAuthStateChange: vi.fn(),
            signOut: vi.fn(),
        }
    }
}));


const TestComponent = () => {
    const auth = useAuth();
    return (
        <div>
            <span data-testid="isGuest">{String(auth.isGuest)}</span>
            <span data-testid="userEmail">{auth.user?.email || 'none'}</span>
            <button onClick={auth.loginAsGuest} data-testid="loginGuestBtn">Login Guest</button>
            <button onClick={auth.signOut} data-testid="signOutBtn">Sign Out</button>
        </div>
    );
};

describe('AuthContext', () => {
    let getItemSpy;
    let setItemSpy;
    let removeItemSpy;

    beforeEach(() => {
        vi.clearAllMocks();

        
        supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
        supabase.auth.onAuthStateChange.mockReturnValue({
            data: { subscription: { unsubscribe: vi.fn() } }
        });

        
        getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
        setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
        removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    });

    afterEach(() => {
        getItemSpy.mockRestore();
        setItemSpy.mockRestore();
        removeItemSpy.mockRestore();
    });

    it('loads null session by default and isGuest is false', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        
        expect(await screen.findByTestId('isGuest')).toHaveTextContent('false');
        expect(screen.getByTestId('userEmail')).toHaveTextContent('none');
    });

    it('loads session from supabase correctly', async () => {
        const mockUser = { email: 'luffy@test.com' };
        supabase.auth.getSession.mockResolvedValue({
            data: { session: { user: mockUser } }
        });

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        expect(await screen.findByTestId('userEmail')).toHaveTextContent('luffy@test.com');
        expect(screen.getByTestId('isGuest')).toHaveTextContent('false');
    });

    it('restores guest mode from localStorage', async () => {
        getItemSpy.mockReturnValue('true'); 

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        expect(await screen.findByTestId('isGuest')).toHaveTextContent('true');
    });

    it('loginAsGuest sets guest mode to true and clears session', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await screen.findByTestId('isGuest'); 

        act(() => {
            screen.getByTestId('loginGuestBtn').click();
        });

        expect(screen.getByTestId('isGuest')).toHaveTextContent('true');
        expect(setItemSpy).toHaveBeenCalledWith('guest_mode', 'true');
    });

    it('signOut calls supabase.auth.signOut and clears guest mode', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await screen.findByTestId('isGuest'); 

        act(() => {
            screen.getByTestId('signOutBtn').click();
        });

        expect(screen.getByTestId('isGuest')).toHaveTextContent('false');
        expect(removeItemSpy).toHaveBeenCalledWith('guest_mode');
        expect(supabase.auth.signOut).toHaveBeenCalled();
    });
});
