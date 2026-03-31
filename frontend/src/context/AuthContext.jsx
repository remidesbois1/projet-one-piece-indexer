"use client";
import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [session, setSession] = useState(null);
    const [isGuest, setIsGuest] = useState(false);
    const [role, setRole] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchRole = async (userId) => {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('role')
                .eq('id', userId)
                .single();
            if (data) setRole(data.role);
        } catch (err) {
            console.error("Error fetching role:", err);
        }
    };

    useEffect(() => {
        if (typeof window !== 'undefined') {
            setIsGuest(localStorage.getItem('guest_mode') === 'true');
        }

        supabase.auth.getSession().then(({ data: { session: currentSession } }) => {
            setSession(currentSession);
            if (currentSession?.user) {
                fetchRole(currentSession.user.id);
            }
            setLoading(false);
        });

        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            (_event, newSession) => {
                setSession((prevSession) => {
                    if (prevSession?.access_token === newSession?.access_token) {
                        return prevSession;
                    }
                    if (newSession) {
                        setIsGuest(false);
                        if (typeof window !== 'undefined') {
                            localStorage.removeItem('guest_mode');
                        }
                        fetchRole(newSession.user.id);
                    } else {
                        setRole(null);
                    }
                    return newSession;
                });
            }
        );

        return () => subscription.unsubscribe();
    }, []);

    const loginAsGuest = useCallback(() => {
        setIsGuest(true);
        setRole(null);
        if (typeof window !== 'undefined') {
            localStorage.setItem('guest_mode', 'true');
        }
        setSession(null);
    }, []);

    const signOut = useCallback(() => {
        setIsGuest(false);
        setRole(null);
        if (typeof window !== 'undefined') {
            localStorage.removeItem('guest_mode');
        }
        return supabase.auth.signOut();
    }, []);

    const value = useMemo(() => ({
        session,
        user: session?.user,
        role,
        isGuest,
        loginAsGuest,
        signOut,
    }), [session, role, isGuest, loginAsGuest, signOut]);

    return (
        <AuthContext.Provider value={value}>
            {!loading && children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
