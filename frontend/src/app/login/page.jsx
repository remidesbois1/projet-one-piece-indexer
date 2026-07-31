"use client";
import React, { Suspense, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import Image from "next/image";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

function LoginContent() {
    const router = useRouter();
    const { loginAsGuest } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const searchParams = useSearchParams();
    const nextUrl = searchParams.get('next') || '/';

    const handleLogin = async (event) => {
        event.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Erreur de connexion.');
            }

            await supabase.auth.setSession(data.session);
            router.push(nextUrl);

        } catch (error) {
            setError(error.message);
        } finally {
            setLoading(false);
        }
    };

    const handleGuestLogin = () => {
        loginAsGuest();
        router.push(nextUrl);
    };

    return (
        <div className="poneglyph-app flex min-h-screen items-center justify-center px-4 py-10">
            <div className="w-full max-w-md">
                <div className="mb-8 flex flex-col items-center text-center">
                    <Image src="/favicon-96x96.png" alt="Logo Projet Poneglyph" width={52} height={52} className="mb-4 rounded-lg" />
                    <h1 className="poneglyph-title text-3xl font-black">Projet Poneglyph</h1>
                    <p className="poneglyph-muted mt-2 text-sm">Accédez à votre espace d’annotation et de recherche.</p>
                </div>
                <Card className="poneglyph-panel rounded-xl">
                    <CardHeader className="space-y-1">
                        <CardTitle className="text-center text-2xl font-bold text-white">Connexion</CardTitle>
                        <CardDescription className="text-center text-slate-400">
                            Entrez vos identifiants pour accéder au Projet Poneglyph
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleLogin} className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-slate-200">Email</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    placeholder="exemple@email.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    className="poneglyph-input"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="password" className="text-slate-200">Mot de passe</Label>
                                <Input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                    className="poneglyph-input"
                                />
                            </div>

                            {error && (
                                <div className="text-sm text-red-500 font-medium text-center">
                                    {error}
                                </div>
                            )}

                            <Button type="submit" className="poneglyph-blue-button w-full hover:bg-[#2f73dc]" disabled={loading}>
                                {loading ? 'Connexion en cours...' : 'Se connecter'}
                            </Button>
                        </form>

                        <div className="mt-6 flex items-center gap-4">
                            <Separator className="flex-1" />
                            <span className="text-xs uppercase text-slate-500">Ou</span>
                            <Separator className="flex-1" />
                        </div>

                        <Button
                            variant="outline"
                            className="mt-6 w-full border-white/14 bg-white/8 text-slate-200 hover:bg-white/14 hover:text-white"
                            onClick={handleGuestLogin}
                        >
                            Continuer en tant qu&apos;invité
                        </Button>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense
            fallback={(
                <div className="poneglyph-app flex min-h-screen items-center justify-center">
                    <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-700 border-t-white" />
                </div>
            )}
        >
            <LoginContent />
        </Suspense>
    );
}
