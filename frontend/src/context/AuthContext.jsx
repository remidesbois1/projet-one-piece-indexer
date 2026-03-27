"use client";
import React, { createContext, useContext, useState, useEffect } from 'react';
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

        const initAuth = async () => {
            const { data: { session: currentSession } } = await supabase.auth.getSession();

            if (currentSession) {
                const { error } = await supabase.auth.getUser();
                if (error) {
                    await supabase.auth.signOut();
                    setSession(null);
                    setLoading(false);
                    return;
                }
            }

            setSession(currentSession);
            if (currentSession?.user) {
                fetchRole(currentSession.user.id);
            }
            setLoading(false);
        };

        // Suppress Supabase "Invalid Refresh Token" console errors on startup
        const originalError = console.error;
        console.error = (...args) => {
            if (typeof args[0] === 'string' && args[0].includes('AuthApiError')) return;
            if (args[0] instanceof Error && args[0].message?.includes('Refresh Token Not Found')) return;
            originalError.apply(console, args);
        };

        initAuth();

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

        return () => {
            console.error = originalError;
            subscription.unsubscribe();
        };
    }, []);

    const value = {
        session,
        user: session?.user,
        role,
        isGuest,
        loginAsGuest: () => {
            setIsGuest(true);
            setRole(null);
            if (typeof window !== 'undefined') {
                localStorage.setItem('guest_mode', 'true');
            }
            setSession(null);
        },
        signOut: () => {
            setIsGuest(false);
            setRole(null);
            if (typeof window !== 'undefined') {
                localStorage.removeItem('guest_mode');
            }
            return supabase.auth.signOut();
        },
    };

    return (
        <AuthContext.Provider value={value}>
            {!loading && children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
