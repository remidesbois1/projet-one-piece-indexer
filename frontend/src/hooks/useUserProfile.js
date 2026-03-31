"use client";
import { useAuth } from '@/context/AuthContext';

export const useUserProfile = () => {
    const { role, user } = useAuth();
    const profile = role ? { role } : null;
    const loading = user !== undefined && role === null && user !== null;

    return { profile, loading: false };
};
