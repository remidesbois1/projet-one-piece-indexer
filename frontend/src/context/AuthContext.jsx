"use client";

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { supabase } from '../lib/supabaseClient';

export const AUTH_STATUS = Object.freeze({
    IDLE: 'idle',
    LOADING: 'loading',
    AUTHENTICATED: 'authenticated',
    GUEST: 'guest',
    UNAUTHENTICATED: 'unauthenticated',
    ERROR: 'error',
});

export const ROLE_STATUS = Object.freeze({
    IDLE: 'idle',
    LOADING: 'loading',
    READY: 'ready',
    ERROR: 'error',
});

const AuthContext = createContext(undefined);
const SESSION_EXPIRED_ERROR = 'SessionExpiredError';
const EXPIRED_SESSION_CODES = new Set([
    'bad_jwt',
    'invalid_jwt',
    'refresh_token_already_used',
    'refresh_token_not_found',
    'session_not_found',
]);

function readGuestMode() {
    if (typeof window === 'undefined') return false;

    try {
        return window.localStorage.getItem('guest_mode') === 'true';
    } catch {
        return false;
    }
}

function persistGuestMode(enabled) {
    if (typeof window === 'undefined') return;

    try {
        if (enabled) {
            window.localStorage.setItem('guest_mode', 'true');
        } else {
            window.localStorage.removeItem('guest_mode');
        }
    } catch {
        // Guest mode remains usable for the current tab when storage is unavailable.
    }
}

function getErrorText(error) {
    return [error?.code, error?.name, error?.message]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

function isRetryableAuthError(error) {
    if (!error) return false;
    if (error instanceof TypeError) return true;

    const status = Number(error.status);
    return error.name === 'AuthRetryableFetchError'
        || status === 0
        || status >= 500
        || /fetch failed|failed to fetch|network|networkerror|timeout/.test(getErrorText(error));
}

function isExpiredSessionError(error) {
    if (!error || isRetryableAuthError(error)) return false;
    if (error.name === SESSION_EXPIRED_ERROR) return true;
    if (EXPIRED_SESSION_CODES.has(error.code)) return true;

    const status = Number(error.status);
    const text = getErrorText(error);
    return (
        /refresh token|refresh_token|jwt expired|invalid jwt|invalid token|session.*(?:expired|missing|not found)/.test(text)
        || ([400, 401, 403].includes(status) && /token|jwt|session/.test(text))
    );
}

function createSessionExpiredError(cause) {
    const error = new Error('La session a expiré.');
    error.name = SESSION_EXPIRED_ERROR;
    error.cause = cause;
    return error;
}

function createPublicAuthError() {
    return new Error('Impossible de vérifier votre session. Vérifiez votre connexion puis réessayez.');
}

function createPublicRoleError() {
    return new Error('Impossible de charger vos permissions. Réessayez dans quelques instants.');
}

export function AuthProvider({ children }) {
    const [session, setSession] = useState(null);
    const [isGuest, setIsGuest] = useState(false);
    const [role, setRole] = useState(null);
    const [authStatus, setAuthStatus] = useState(AUTH_STATUS.IDLE);
    const [roleStatus, setRoleStatus] = useState(ROLE_STATUS.IDLE);
    const [error, setError] = useState(null);
    const [roleError, setRoleError] = useState(null);

    const mountedRef = useRef(false);
    const authRequestRef = useRef(0);
    const roleRequestRef = useRef(0);
    const roleUserIdRef = useRef(null);
    const guestRef = useRef(false);

    const setGuestState = useCallback((enabled) => {
        guestRef.current = enabled;
        setIsGuest(enabled);
        persistGuestMode(enabled);
    }, []);

    const resetRoleState = useCallback(() => {
        roleRequestRef.current += 1;
        roleUserIdRef.current = null;
        setRole(null);
        setRoleStatus(ROLE_STATUS.IDLE);
        setRoleError(null);
    }, []);

    const loadRole = useCallback(async (userId) => {
        if (!userId) {
            resetRoleState();
            return null;
        }

        const requestId = ++roleRequestRef.current;
        roleUserIdRef.current = userId;
        setRole(null);
        setRoleStatus(ROLE_STATUS.LOADING);
        setRoleError(null);

        try {
            const { data, error: profileError } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', userId)
                .single();

            if (profileError) throw profileError;
            if (!data?.role) throw new Error('Profil utilisateur sans rôle.');

            if (
                mountedRef.current
                && requestId === roleRequestRef.current
                && roleUserIdRef.current === userId
            ) {
                setRole(data.role);
                setRoleStatus(ROLE_STATUS.READY);
                setRoleError(null);
            }

            return data.role;
        } catch {
            if (
                mountedRef.current
                && requestId === roleRequestRef.current
                && roleUserIdRef.current === userId
            ) {
                setRole(null);
                setRoleStatus(ROLE_STATUS.ERROR);
                setRoleError(createPublicRoleError());
            }
            return null;
        }
    }, [resetRoleState]);

    const scheduleRoleLoad = useCallback((userId) => {
        resetRoleState();
        Promise.resolve().then(() => {
            if (mountedRef.current) void loadRole(userId);
        });
    }, [loadRole, resetRoleState]);

    const applyAuthenticatedSession = useCallback((nextSession) => {
        const userId = nextSession?.user?.id;
        if (!userId) throw createSessionExpiredError();

        setSession(nextSession);
        setGuestState(false);
        setError(null);
        setAuthStatus(AUTH_STATUS.AUTHENTICATED);
        scheduleRoleLoad(userId);
    }, [scheduleRoleLoad, setGuestState]);

    const applyNoSession = useCallback((guestMode = false) => {
        setSession(null);
        setGuestState(guestMode);
        setError(null);
        setAuthStatus(guestMode ? AUTH_STATUS.GUEST : AUTH_STATUS.UNAUTHENTICATED);
        resetRoleState();
    }, [resetRoleState, setGuestState]);

    const validateStoredSession = useCallback(async () => {
        const sessionResult = await supabase.auth.getSession();
        if (sessionResult?.error) {
            if (isExpiredSessionError(sessionResult.error)) {
                throw createSessionExpiredError(sessionResult.error);
            }
            throw sessionResult.error;
        }

        const currentSession = sessionResult?.data?.session ?? null;
        if (!currentSession) return null;

        const userResult = await supabase.auth.getUser(currentSession.access_token);
        if (!userResult?.error && userResult?.data?.user) {
            return { ...currentSession, user: userResult.data.user };
        }

        if (isRetryableAuthError(userResult?.error)) throw userResult.error;

        const refreshResult = await supabase.auth.refreshSession();
        if (refreshResult?.error) {
            if (isRetryableAuthError(refreshResult.error)) throw refreshResult.error;
            throw createSessionExpiredError(refreshResult.error);
        }

        const refreshedSession = refreshResult?.data?.session;
        if (!refreshedSession) throw createSessionExpiredError(userResult?.error);

        const refreshedUserResult = await supabase.auth.getUser(refreshedSession.access_token);
        if (refreshedUserResult?.error || !refreshedUserResult?.data?.user) {
            if (isRetryableAuthError(refreshedUserResult?.error)) throw refreshedUserResult.error;
            throw createSessionExpiredError(refreshedUserResult?.error);
        }

        return { ...refreshedSession, user: refreshedUserResult.data.user };
    }, []);

    const clearExpiredSession = useCallback(() => {
        try {
            Promise.resolve(supabase.auth.signOut({ scope: 'local' })).catch(() => {});
        } catch {
            // Supabase normally removes an invalid refresh token itself; state still resolves locally.
        }
    }, []);

    const initializeAuth = useCallback(async () => {
        const requestId = ++authRequestRef.current;
        let resolved = false;
        setAuthStatus(AUTH_STATUS.LOADING);
        setError(null);

        const guestMode = readGuestMode();
        guestRef.current = guestMode;
        setIsGuest(guestMode);

        try {
            if (guestMode) {
                if (mountedRef.current && requestId === authRequestRef.current) {
                    applyNoSession(true);
                    resolved = true;
                }
                return;
            }

            const currentSession = await validateStoredSession();
            if (!mountedRef.current || requestId !== authRequestRef.current) return;

            if (currentSession) {
                applyAuthenticatedSession(currentSession);
            } else {
                applyNoSession(false);
            }
            resolved = true;
        } catch (authError) {
            if (!mountedRef.current || requestId !== authRequestRef.current) return;

            if (isExpiredSessionError(authError)) {
                applyNoSession(false);
                clearExpiredSession();
            } else {
                setSession(null);
                setGuestState(false);
                resetRoleState();
                setError(createPublicAuthError());
                setAuthStatus(AUTH_STATUS.ERROR);
            }
            resolved = true;
        } finally {
            if (mountedRef.current && requestId === authRequestRef.current && !resolved) {
                setSession(null);
                resetRoleState();
                setError(createPublicAuthError());
                setAuthStatus(AUTH_STATUS.ERROR);
            }
        }
    }, [
        applyAuthenticatedSession,
        applyNoSession,
        clearExpiredSession,
        resetRoleState,
        setGuestState,
        validateStoredSession,
    ]);

    useEffect(() => {
        mountedRef.current = true;
        void initializeAuth();

        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (event, nextSession) => {
                if (!mountedRef.current) return;
                // Manual initialization above validates the stored session and owns its error state.
                // Supabase emits INITIAL_SESSION with null even when its own initialization failed,
                // so accepting that event could erase a recoverable network error.
                if (event === 'INITIAL_SESSION') return;

                authRequestRef.current += 1;

                if (nextSession?.user) {
                    applyAuthenticatedSession(nextSession);
                    return;
                }

                if (event === 'SIGNED_OUT') {
                    applyNoSession(guestRef.current);
                }
            }
        );

        return () => {
            mountedRef.current = false;
            authRequestRef.current += 1;
            roleRequestRef.current += 1;
            subscription?.unsubscribe();
        };
    }, [applyAuthenticatedSession, applyNoSession, initializeAuth]);

    const retry = useCallback(() => {
        if (
            authStatus === AUTH_STATUS.AUTHENTICATED
            && roleStatus === ROLE_STATUS.ERROR
            && session?.user?.id
        ) {
            return loadRole(session.user.id);
        }
        return initializeAuth();
    }, [authStatus, initializeAuth, loadRole, roleStatus, session]);

    const loginAsGuest = useCallback(() => {
        authRequestRef.current += 1;
        applyNoSession(true);

        try {
            Promise.resolve(supabase.auth.signOut({ scope: 'local' })).catch(() => {});
        } catch {
            // Guest mode must remain available even when Supabase is unavailable.
        }
    }, [applyNoSession]);

    const signOut = useCallback(async () => {
        authRequestRef.current += 1;
        setGuestState(false);

        try {
            return await supabase.auth.signOut();
        } finally {
            if (mountedRef.current) applyNoSession(false);
        }
    }, [applyNoSession, setGuestState]);

    const loading = authStatus === AUTH_STATUS.IDLE || authStatus === AUTH_STATUS.LOADING;

    const value = useMemo(() => ({
        session,
        user: session?.user,
        role,
        isGuest,
        authStatus,
        roleStatus,
        loading,
        error,
        roleError,
        retry,
        loginAsGuest,
        signOut,
    }), [
        session,
        role,
        isGuest,
        authStatus,
        roleStatus,
        loading,
        error,
        roleError,
        retry,
        loginAsGuest,
        signOut,
    ]);

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) throw new Error('useAuth doit être utilisé dans AuthProvider.');
    return context;
}
