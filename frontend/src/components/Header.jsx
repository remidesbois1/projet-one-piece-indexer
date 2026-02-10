"use client";
import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useManga } from '@/context/MangaContext'; // [NEW]

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
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

// Icons
import { LogOut, User, Shield, ShieldAlert, Book, Sparkles, Menu, Search, FileText, Image as ImageIcon, Languages, Settings2, Library } from "lucide-react";

const Header = ({ onOpenApiKeyModal }) => {
    const { user, signOut, isGuest } = useAuth();
    const { profile } = useUserProfile();
    const router = useRouter();
    const pathname = usePathname();
    const { mangaSlug } = useManga(); // [NEW] Get mangaSlug

    const handleLogout = async () => {
        await signOut();
        router.push('/login');
    };

    const isAdmin = profile?.role === 'Admin';
    const isModo = profile?.role === 'Modo';

    // Fonction utilitaire pour le style des liens
    const getLinkStyle = (path) => {
        // [NEW] Adjust active check to ignore manga prefix for styling if needed, 
        // or just check if pathname ends with path
        const fullPath = `/${mangaSlug}${path}`;
        const isActive = pathname === fullPath;
        return `text-sm font-medium transition-colors hover:text-primary ${isActive ? "text-primary font-bold" : "text-slate-500"}`;
    };

    // Initiales pour l'avatar (ex: "john.doe@gmail.com" -> "JO")
    const getInitials = (email) => {
        if (!email) return "U";
        return email.substring(0, 2).toUpperCase();
    };

    // [NEW] Helper for Links
    const getHref = (path) => `/${mangaSlug}${path}`;

    if (!mangaSlug) return null; // Should not happen in authenticated layout

    return (
        <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60">
            <div className="container mx-auto flex h-16 items-center justify-between px-4 sm:px-8 max-w-[1600px]">

                {/* LOGO */}
                <div className="flex items-center gap-2">
                    <Link href={`/`} prefetch={false} className="flex items-center space-x-2">
                        <span className="text-xl font-bold tracking-tight text-slate-900">
                            Projet Poneglyph
                        </span>
                    </Link>
                </div>

                {/* NAVIGATION DESKTOP */}
                <nav className="hidden md:flex items-center gap-6">
                    <Link href={getHref('/dashboard')} prefetch={false} className={getLinkStyle('/dashboard')}>
                        Bibliothèque
                    </Link>
                    <Link href={getHref('/search')} prefetch={false} className={getLinkStyle('/search')}>
                        Recherche
                    </Link>
                    {!isGuest && (
                        <Link href={getHref('/my-submissions')} prefetch={false} className={getLinkStyle('/my-submissions')}>
                            Mes Soumissions
                        </Link>
                    )}
                    {!isGuest && (isAdmin || isModo) && (
                        <Link href={getHref('/moderation')} prefetch={false} className={getLinkStyle('/moderation')}>
                            Modération
                        </Link>
                    )}
                    {!isGuest && isAdmin && (
                        <>
                            <Link href={getHref('/admin')} prefetch={false} className={getLinkStyle('/admin')}>
                                Admin
                            </Link>
                            <Link href={getHref('/admin/data')} prefetch={false} className={getLinkStyle('/admin/data')}>
                                Explorateur
                            </Link>
                        </>
                    )}
                </nav>

                {/* USER SECTION */}
                {/* USER SECTION & MOBILE MENU */}
                <div className="flex items-center gap-2 sm:gap-4">
                    {/* DESKTOP USER DROPDOWN */}
                    <div className="hidden md:block">
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
                                    <DropdownMenuItem onClick={() => router.push(getHref('/my-submissions'))}>
                                        <Book className="mr-2 h-4 w-4" />
                                        <span>Mes Soumissions</span>
                                    </DropdownMenuItem>
                                    {(isAdmin || isModo) && (
                                        <DropdownMenuItem onClick={() => router.push(getHref('/moderation'))}>
                                            <Shield className="mr-2 h-4 w-4" />
                                            <span>Modération</span>
                                        </DropdownMenuItem>
                                    )}
                                    {isAdmin && (
                                        <DropdownMenuItem onClick={() => router.push(getHref('/admin'))}>
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
                                <Link href="/login" prefetch={false}>
                                    <Button size="sm">Connexion</Button>
                                </Link>
                            </div>
                        )}
                    </div>

                    {/* MOBILE HAMBURGER MENU */}
                    <div className="md:hidden">
                        <Sheet>
                            <SheetTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-10 w-10">
                                    <Menu className="h-6 w-6" />
                                </Button>
                            </SheetTrigger>
                            <SheetContent side="right" className="p-0 flex flex-col w-[280px]">
                                <SheetHeader className="p-6 text-left border-b border-slate-100">
                                    <SheetTitle className="text-xl font-bold">Menu</SheetTitle>
                                    <div className="flex items-center gap-3 mt-4">
                                        <Avatar className="h-10 w-10 border">
                                            {user && !isGuest && <AvatarImage src={profile?.avatar_url} />}
                                            <AvatarFallback>{user && !isGuest ? getInitials(user.email) : "G"}</AvatarFallback>
                                        </Avatar>
                                        <div className="flex flex-col">
                                            <span className="text-sm font-semibold truncate max-w-[150px]">
                                                {user && !isGuest ? user.email : "Invité"}
                                            </span>
                                            <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">
                                                {isAdmin ? "Administrateur" : (isModo ? "Modérateur" : (isGuest ? "Visiteur" : "Utilisateur"))}
                                            </span>
                                        </div>
                                    </div>
                                </SheetHeader>

                                <div className="flex-1 overflow-y-auto py-4">
                                    <nav className="flex flex-col gap-1 px-4">
                                        <p className="px-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 mt-2">Navigation</p>
                                        <Link href={getHref('/dashboard')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                            <div className="p-1.5 bg-slate-100 group-hover:bg-white rounded border border-transparent group-hover:border-slate-200 shadow-sm transition-all text-slate-600">
                                                <Book size={18} />
                                            </div>
                                            Bibliothèque
                                        </Link>
                                        <Link href={getHref('/search')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                            <div className="p-1.5 bg-slate-100 group-hover:bg-white rounded border border-transparent group-hover:border-slate-200 shadow-sm transition-all text-slate-600">
                                                <Search size={18} />
                                            </div>
                                            Recherche
                                        </Link>

                                        {!isGuest && (
                                            <>
                                                <p className="px-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 mt-6">Espace Travail</p>
                                                <Link href={getHref('/my-submissions')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                    <div className="p-1.5 bg-indigo-50 rounded border border-indigo-100 shadow-sm text-indigo-600 ">
                                                        <FileText size={18} />
                                                    </div>
                                                    Mes Soumissions
                                                </Link>
                                                {(isAdmin || isModo) && (
                                                    <Link href={getHref('/moderation')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                        <div className="p-1.5 bg-amber-50 rounded border border-amber-100 shadow-sm text-amber-600 ">
                                                            <Shield size={18} />
                                                        </div>
                                                        Modération
                                                    </Link>
                                                )}
                                                {isAdmin && (
                                                    <>
                                                        <p className="px-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 mt-6">Administration</p>
                                                        <Link href={getHref('/admin')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                            <div className="p-1.5 bg-red-50 rounded border border-red-100 shadow-sm text-red-600 ">
                                                                <Library size={18} />
                                                            </div>
                                                            Gestion Bibliothèque
                                                        </Link>
                                                        <Link href={getHref('/admin?tab=covers')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                            <div className="p-1.5 bg-red-50 rounded border border-red-100 shadow-sm text-red-600 ">
                                                                <ImageIcon size={18} />
                                                            </div>
                                                            Gestion Apparence
                                                        </Link>
                                                        <Link href={getHref('/admin?tab=glossary')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                            <div className="p-1.5 bg-red-50 rounded border border-red-100 shadow-sm text-red-600 ">
                                                                <Languages size={18} />
                                                            </div>
                                                            Gestion Glossaire
                                                        </Link>
                                                        <Link href={getHref('/admin?tab=security')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                            <div className="p-1.5 bg-red-50 rounded border border-red-100 shadow-sm text-red-600 ">
                                                                <ShieldAlert size={18} />
                                                            </div>
                                                            Gestion Sécurité
                                                        </Link>
                                                        <Link href={getHref('/admin/data')} prefetch={false} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group">
                                                            <div className="p-1.5 bg-slate-900 rounded border border-slate-800 shadow-sm text-white ">
                                                                <Settings2 size={18} />
                                                            </div>
                                                            Explorateur de données
                                                        </Link>
                                                    </>
                                                )}
                                            </>
                                        )}

                                        <p className="px-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 mt-6">Paramètres</p>
                                        <button onClick={onOpenApiKeyModal} className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg hover:bg-slate-50 text-slate-700 font-medium transition-all group text-left">
                                            <div className="p-1.5 bg-emerald-50 rounded border border-emerald-100 shadow-sm text-emerald-600 ">
                                                <Sparkles size={18} />
                                            </div>
                                            Clé API Gemini
                                        </button>
                                    </nav>
                                </div>

                                <div className="p-6 border-t border-slate-100 pb-10">
                                    {user && !isGuest ? (
                                        <Button variant="destructive" className="w-full gap-2 h-11 shadow-sm" onClick={handleLogout}>
                                            <LogOut size={18} />
                                            Déconnexion
                                        </Button>
                                    ) : (
                                        <Link href="/login" prefetch={false} className="block w-full">
                                            <Button className="w-full gap-2 h-11 shadow-xl bg-slate-900 hover:bg-slate-800">
                                                <User size={18} />
                                                Se Connecter
                                            </Button>
                                        </Link>
                                    )}
                                </div>
                            </SheetContent>
                        </Sheet>
                    </div>
                </div>
            </div>
        </header>
    );
};

export default Header;
