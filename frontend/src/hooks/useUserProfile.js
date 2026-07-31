"use client";
import { AUTH_STATUS, ROLE_STATUS, useAuth } from '@/context/AuthContext';

export const useUserProfile = () => {
    const {
        role,
        authStatus,
        roleStatus,
        loading: authLoading,
        error: authError,
        roleError,
        retry,
    } = useAuth();

    const authenticated = authStatus === AUTH_STATUS.AUTHENTICATED;
    const loading = authLoading
        || (authenticated && (roleStatus === ROLE_STATUS.IDLE || roleStatus === ROLE_STATUS.LOADING));
    const profile = authenticated && roleStatus === ROLE_STATUS.READY ? { role } : null;
    const error = authStatus === AUTH_STATUS.ERROR ? authError : roleError;

    return { profile, loading, error, retry };
};
