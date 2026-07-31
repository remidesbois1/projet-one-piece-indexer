import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_STATUS, ROLE_STATUS, useAuth } from '@/context/AuthContext';
import { useUserProfile } from './useUserProfile';

vi.mock('@/context/AuthContext', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, useAuth: vi.fn() };
});

describe('useUserProfile', () => {
    const retry = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps loading true while the authenticated user role is pending', () => {
        useAuth.mockReturnValue({
            role: null,
            authStatus: AUTH_STATUS.AUTHENTICATED,
            roleStatus: ROLE_STATUS.LOADING,
            loading: false,
            error: null,
            roleError: null,
            retry,
        });

        const { result } = renderHook(() => useUserProfile());

        expect(result.current).toEqual({
            profile: null,
            loading: true,
            error: null,
            retry,
        });
    });

    it('returns the profile only once the role is ready', () => {
        useAuth.mockReturnValue({
            role: 'Admin',
            authStatus: AUTH_STATUS.AUTHENTICATED,
            roleStatus: ROLE_STATUS.READY,
            loading: false,
            error: null,
            roleError: null,
            retry,
        });

        const { result } = renderHook(() => useUserProfile());

        expect(result.current).toEqual({
            profile: { role: 'Admin' },
            loading: false,
            error: null,
            retry,
        });
    });

    it('publishes role errors and the shared retry action', () => {
        const roleError = new Error('Permissions indisponibles');
        useAuth.mockReturnValue({
            role: null,
            authStatus: AUTH_STATUS.AUTHENTICATED,
            roleStatus: ROLE_STATUS.ERROR,
            loading: false,
            error: null,
            roleError,
            retry,
        });

        const { result } = renderHook(() => useUserProfile());

        expect(result.current).toEqual({
            profile: null,
            loading: false,
            error: roleError,
            retry,
        });
    });
});
