import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STATUS, AuthProvider, ROLE_STATUS, useAuth } from './AuthContext';
import { supabase } from '@/lib/supabaseClient';

vi.mock('@/lib/supabaseClient', () => ({
    supabase: {
        auth: {
            getSession: vi.fn(),
            getUser: vi.fn(),
            refreshSession: vi.fn(),
            onAuthStateChange: vi.fn(),
            signOut: vi.fn(),
        },
        from: vi.fn(),
    },
}));

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

const TestComponent = () => {
    const auth = useAuth();
    return (
        <div>
            <span data-testid="authStatus">{auth.authStatus}</span>
            <span data-testid="roleStatus">{auth.roleStatus}</span>
            <span data-testid="loading">{String(auth.loading)}</span>
            <span data-testid="isGuest">{String(auth.isGuest)}</span>
            <span data-testid="userEmail">{auth.user?.email || 'none'}</span>
            <span data-testid="role">{auth.role || 'none'}</span>
            <span data-testid="token">{auth.session?.access_token || 'none'}</span>
            <span data-testid="error">{auth.error?.message || 'none'}</span>
            <button onClick={() => void auth.retry()} data-testid="retryBtn">Retry</button>
            <button onClick={auth.loginAsGuest} data-testid="loginGuestBtn">Login Guest</button>
            <button onClick={() => void auth.signOut()} data-testid="signOutBtn">Sign Out</button>
        </div>
    );
};

describe('AuthContext', () => {
    let authListener;
    let getItemSpy;
    let setItemSpy;
    let removeItemSpy;
    let profileSingle;

    beforeEach(() => {
        vi.clearAllMocks();
        authListener = null;

        supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
        supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null });
        supabase.auth.refreshSession.mockResolvedValue({ data: { session: null }, error: null });
        supabase.auth.signOut.mockResolvedValue({ error: null });
        supabase.auth.onAuthStateChange.mockImplementation((listener) => {
            authListener = listener;
            return { data: { subscription: { unsubscribe: vi.fn() } } };
        });

        profileSingle = vi.fn().mockResolvedValue({ data: { role: 'User' }, error: null });
        supabase.from.mockImplementation(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({ single: profileSingle })),
            })),
        }));

        getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
        setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
        removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem');
    });

    afterEach(() => {
        getItemSpy.mockRestore();
        setItemSpy.mockRestore();
        removeItemSpy.mockRestore();
    });

    it('publishes an unauthenticated state instead of hiding its children', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        expect(screen.getByTestId('authStatus')).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.UNAUTHENTICATED);
        });
        expect(screen.getByTestId('loading')).toHaveTextContent('false');
        expect(screen.getByTestId('isGuest')).toHaveTextContent('false');
    });

    it('validates the session and loads the user role', async () => {
        const session = {
            access_token: 'valid-token',
            user: { id: 'user-1', email: 'stale@test.com' },
        };
        const verifiedUser = { id: 'user-1', email: 'luffy@test.com' };
        supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
        supabase.auth.getUser.mockResolvedValue({ data: { user: verifiedUser }, error: null });
        profileSingle.mockResolvedValue({ data: { role: 'Admin' }, error: null });

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.AUTHENTICATED);
            expect(screen.getByTestId('roleStatus')).toHaveTextContent(ROLE_STATUS.READY);
        });
        expect(screen.getByTestId('userEmail')).toHaveTextContent('luffy@test.com');
        expect(screen.getByTestId('role')).toHaveTextContent('Admin');
        expect(supabase.auth.getUser).toHaveBeenCalledWith('valid-token');
    });

    it('keeps role loading explicit until a late profile query resolves', async () => {
        const deferredProfile = createDeferred();
        const user = { id: 'user-2', email: 'nami@test.com' };
        const session = { access_token: 'role-token', user };
        supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
        supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null });
        profileSingle.mockReturnValue(deferredProfile.promise);

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.AUTHENTICATED);
            expect(screen.getByTestId('roleStatus')).toHaveTextContent(ROLE_STATUS.LOADING);
        });
        expect(screen.getByTestId('role')).toHaveTextContent('none');

        await act(async () => {
            deferredProfile.resolve({ data: { role: 'Modo' }, error: null });
            await deferredProfile.promise;
        });

        await waitFor(() => {
            expect(screen.getByTestId('roleStatus')).toHaveTextContent(ROLE_STATUS.READY);
            expect(screen.getByTestId('role')).toHaveTextContent('Modo');
        });
    });

    it('retries a failed role query without reinitializing the valid session', async () => {
        const user = { id: 'user-role-retry', email: 'chopper@test.com' };
        const session = { access_token: 'role-retry-token', user };
        supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
        supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null });
        profileSingle
            .mockResolvedValueOnce({ data: null, error: new Error('Profile network failure') })
            .mockResolvedValueOnce({ data: { role: 'Admin' }, error: null });

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('roleStatus')).toHaveTextContent(ROLE_STATUS.ERROR);
        });
        fireEvent.click(screen.getByTestId('retryBtn'));

        await waitFor(() => {
            expect(screen.getByTestId('roleStatus')).toHaveTextContent(ROLE_STATUS.READY);
            expect(screen.getByTestId('role')).toHaveTextContent('Admin');
        });
        expect(supabase.auth.getSession).toHaveBeenCalledTimes(1);
    });

    it('publishes a recoverable error when Supabase is unreachable', async () => {
        supabase.auth.getSession.mockRejectedValue(new TypeError('Failed to fetch'));

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.ERROR);
        });
        expect(screen.getByTestId('loading')).toHaveTextContent('false');
        expect(screen.getByTestId('error')).toHaveTextContent('Impossible de vérifier votre session');
        expect(supabase.auth.signOut).not.toHaveBeenCalled();

        act(() => authListener('INITIAL_SESSION', null));
        expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.ERROR);
    });

    it('retries authentication after a network error', async () => {
        supabase.auth.getSession
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce({ data: { session: null }, error: null });

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.ERROR);
        });
        fireEvent.click(screen.getByTestId('retryBtn'));

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.UNAUTHENTICATED);
        });
        expect(supabase.auth.getSession).toHaveBeenCalledTimes(2);
        expect(screen.getByTestId('error')).toHaveTextContent('none');
    });

    it('does not mistake a user-validation network failure for an expired session', async () => {
        const session = {
            access_token: 'stored-token',
            user: { id: 'user-network', email: 'sanji@test.com' },
        };
        supabase.auth.getSession.mockResolvedValue({ data: { session }, error: null });
        supabase.auth.getUser.mockRejectedValue(new TypeError('Failed to fetch'));

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.ERROR);
        });
        expect(supabase.auth.refreshSession).not.toHaveBeenCalled();
        expect(supabase.auth.signOut).not.toHaveBeenCalled();
    });

    it('clears an expired refresh-token session without entering an error loop', async () => {
        supabase.auth.getSession.mockResolvedValue({
            data: { session: null },
            error: {
                name: 'AuthApiError',
                code: 'refresh_token_not_found',
                status: 400,
                message: 'Invalid Refresh Token: Refresh Token Not Found',
            },
        });

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.UNAUTHENTICATED);
        });
        expect(screen.getByTestId('error')).toHaveTextContent('none');
        expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('refreshes an expired access token before accepting the session', async () => {
        const staleSession = {
            access_token: 'expired-access-token',
            refresh_token: 'valid-refresh-token',
            user: { id: 'user-3', email: 'robin@test.com' },
        };
        const freshSession = {
            access_token: 'fresh-access-token',
            refresh_token: 'next-refresh-token',
            user: staleSession.user,
        };
        supabase.auth.getSession.mockResolvedValue({ data: { session: staleSession }, error: null });
        supabase.auth.getUser
            .mockResolvedValueOnce({
                data: { user: null },
                error: { name: 'AuthApiError', status: 401, message: 'JWT expired' },
            })
            .mockResolvedValueOnce({ data: { user: staleSession.user }, error: null });
        supabase.auth.refreshSession.mockResolvedValue({
            data: { session: freshSession },
            error: null,
        });

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.AUTHENTICATED);
            expect(screen.getByTestId('token')).toHaveTextContent('fresh-access-token');
        });
        expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1);
        expect(supabase.auth.getUser).toHaveBeenNthCalledWith(2, 'fresh-access-token');
    });

    it('restores guest mode without waiting for Supabase', async () => {
        getItemSpy.mockReturnValue('true');

        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.GUEST);
        });
        expect(screen.getByTestId('isGuest')).toHaveTextContent('true');
        expect(supabase.auth.getSession).not.toHaveBeenCalled();
    });

    it('enters guest mode and clears any local Supabase session', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );
        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.UNAUTHENTICATED);
        });

        fireEvent.click(screen.getByTestId('loginGuestBtn'));

        expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.GUEST);
        expect(screen.getByTestId('isGuest')).toHaveTextContent('true');
        expect(setItemSpy).toHaveBeenCalledWith('guest_mode', 'true');
        expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('signs out and exposes an unauthenticated state', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );
        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.UNAUTHENTICATED);
        });

        fireEvent.click(screen.getByTestId('signOutBtn'));

        await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalled());
        expect(screen.getByTestId('isGuest')).toHaveTextContent('false');
        expect(removeItemSpy).toHaveBeenCalledWith('guest_mode');
    });

    it('handles a later signed-in event and loads its role', async () => {
        render(
            <AuthProvider>
                <TestComponent />
            </AuthProvider>
        );
        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.UNAUTHENTICATED);
        });

        const session = {
            access_token: 'event-token',
            user: { id: 'user-4', email: 'zoro@test.com' },
        };
        act(() => authListener('SIGNED_IN', session));

        await waitFor(() => {
            expect(screen.getByTestId('authStatus')).toHaveTextContent(AUTH_STATUS.AUTHENTICATED);
            expect(screen.getByTestId('roleStatus')).toHaveTextContent(ROLE_STATUS.READY);
        });
        expect(screen.getByTestId('userEmail')).toHaveTextContent('zoro@test.com');
    });
});
