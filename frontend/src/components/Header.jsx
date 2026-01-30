"use client";
import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';

// UI Components
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

// Icons
import { LogOut, User, Shield, ShieldAlert, Book, Sparkles } from "lucide-react";

const Header = ({ onOpenApiKeyModal }) => {
    const { user, signOut, isGuest } = useAuth();
    const { profile } = useUserProfile();
    const router = useRouter();
    const pathname = usePathname();

    const handleLogout = async () => {
        await signOut();
        router.push('/login');
    };

    const isAdmin = profile?.role === 'Admin';
    const isModo = profile?.role === 'Modo';

    // Fonction utilitaire pour le style des liens
    const getLinkStyle = (path) => {
        const isActive = pathname === path;
        return `text-sm font-medium transition-colors hover:text-primary ${isActive ? "text-primary font-bold" : "text-slate-500"}`;
    };

    // Initiales pour l'avatar (ex: "john.doe@gmail.com" -> "JO")
    const getInitials = (email) => {
        if (!email) return "U";
        return email.substring(0, 2).toUpperCase();
    };

    return (
        <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
            <div className="container mx-auto flex h-16 items-center justify-between px-4 sm:px-8 max-w-[1600px]">

                {/* LOGO */}
                <div className="flex items-center gap-2">
                    <Link href="/" className="flex items-center space-x-2">
                        <span className="text-xl font-bold tracking-tight text-slate-900">
                            Projet Poneglyph
                        </span>
                    </Link>
                </div>

                {/* NAVIGATION DESKTOP */}
                <nav className="hidden md:flex items-center gap-6">
                    <Link href="/dashboard" className={getLinkStyle('/dashboard')}>
                        Bibliothèque
                    </Link>
                    <Link href="/search" className={getLinkStyle('/search')}>
                        Recherche
                    </Link>
                    {!isGuest && (
                        <Link href="/my-submissions" className={getLinkStyle('/my-submissions')}>
                            Mes Soumissions
                        </Link>
                    )}
                    {!isGuest && (isAdmin || isModo) && (
                        <Link href="/moderation" className={getLinkStyle('/moderation')}>
                            Modération
                        </Link>
                    )}
                    {!isGuest && isAdmin && (
                        <>
                            <Link href="/admin" className={getLinkStyle('/admin')}>
                                Admin
                            </Link>
                            <Link href="/admin/data" className={getLinkStyle('/admin/data')}>
                                Explorateur
                            </Link>
                        </>
                    )}
                </nav>

                {/* USER SECTION */}
                <div className="flex items-center gap-4">
                    {user && !isGuest ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" className="relative h-9 w-9 rounded-full">
                                    <Avatar className="h-9 w-9 border border-slate-200">
                                        <AvatarImage src={profile?.avatar_url} alt={user.email} />
                                        <AvatarFallback>{getInitials(user.email)}</AvatarFallback>
                                    </Avatar>
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="w-56" align="end" forceMount>
                                <DropdownMenuLabel className="font-normal">
                                    <div className="flex flex-col space-y-1">
                                        <p className="text-sm font-medium leading-none">Mon Compte</p>
                                        <p className="text-xs leading-none text-muted-foreground">
                                            {user.email}
                                        </p>
                                    </div>
                                </DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => router.push('/my-submissions')}>
                                    <Book className="mr-2 h-4 w-4" />
                                    <span>Mes Soumissions</span>
                                </DropdownMenuItem>
                                {(isAdmin || isModo) && (
                                    <DropdownMenuItem onClick={() => router.push('/moderation')}>
                                        <Shield className="mr-2 h-4 w-4" />
                                        <span>Modération</span>
                                    </DropdownMenuItem>
                                )}
                                {isAdmin && (
                                    <DropdownMenuItem onClick={() => router.push('/admin')}>
                                        <ShieldAlert className="mr-2 h-4 w-4" />
                                        <span>Administration</span>
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={onOpenApiKeyModal} className="cursor-pointer">
                                    <Sparkles className="mr-2 h-4 w-4 text-amber-500" />
                                    <span>Clé API IA (Gemini)</span>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={handleLogout} className="text-red-600 focus:text-red-600">
                                    <LogOut className="mr-2 h-4 w-4" />
                                    <span>Déconnexion</span>
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <div className="flex items-center gap-2">
                            {isGuest && (
                                <Badge variant="outline" className="text-slate-500 border-slate-200">
                                    Mode Invité
                                </Badge>
                            )}
                            <Link href="/login">
                                <Button size="sm">Connexion</Button>
                            </Link>
                        </div>
                    )}
                </div>
            </div>
        </header>
    );
};

export default Header;
