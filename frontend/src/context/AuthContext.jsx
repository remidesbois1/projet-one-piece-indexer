"use client";
import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext();

export function AuthProvider({ children }) {
    const [session, setSession] = useState(null);
    const [isGuest, setIsGuest] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Check localStorage only on client
        if (typeof window !== 'undefined') {
            setIsGuest(localStorage.getItem('guest_mode') === 'true');
        }

        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
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
                    }
                    return newSession;
                });
            }
        );

        return () => subscription.unsubscribe();
    }, []);

    const value = {
        session,
        user: session?.user,
        isGuest,
        loginAsGuest: () => {
            setIsGuest(true);
            if (typeof window !== 'undefined') {
                localStorage.setItem('guest_mode', 'true');
            }
            setSession(null);
        },
        signOut: () => {
            setIsGuest(false);
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
