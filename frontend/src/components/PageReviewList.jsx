import React, { useState, useEffect } from 'react';
import { getPagesForReview, approveAllPages } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useManga } from '@/context/MangaContext';
import Link from 'next/link';

import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  FileText,
  ArrowRight,
  ScanEye,
  Clock
} from "lucide-react";

const PageReviewList = () => {
  const { session } = useAuth();
  const { mangaSlug } = useManga();
  const { profile } = useUserProfile();
  const [pages, setPages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchPages = () => {
    if (session) {
      setIsLoading(true);
      getPagesForReview()
        .then(response => setPages(response.data))
        .catch(err => console.error("Erreur chargement pages", err))
        .finally(() => setIsLoading(false));
    }
  };

  useEffect(() => {
    fetchPages();
  }, [session]);

  const handleApproveAll = async () => {
    if (!confirm(`Êtes-vous sûr de vouloir valider TOUTES les ${pages.length} pages en attente ?\nCette action est réservée aux administrateurs.`)) {
      return;
    }

    try {
      await approveAllPages();
      fetchPages();
    } catch (err) {
      console.error(err);
      alert("Une erreur est survenue lors de la validation globale.");
    }
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200 w-fit">
          <Badge variant="secondary" className="bg-white border-slate-200 text-slate-900">
            {pages.length}
          </Badge>
          <span className="text-sm font-medium">page(s) à vérifier</span>
        </div>

        {profile?.role === 'Admin' && pages.length > 0 && (
          <Button
            onClick={handleApproveAll}
            variant="default"
            className="bg-slate-900 hover:bg-slate-800 text-white"
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Tout Valider (Admin)
          </Button>
        )}
      </div>

      {pages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
          <div className="h-16 w-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h3 className="text-xl font-bold text-slate-900">Tout est à jour !</h3>
          <p className="text-slate-500 mt-2 max-w-sm text-center">
            Aucune page n'est en attente de validation finale. Bon travail !
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-6">
          {pages.map(page => (
            <Card
              key={page.id}
              className="group relative overflow-hidden border-slate-200 bg-white hover:shadow-2xl hover:shadow-slate-200/50 transition-all duration-500 flex flex-col h-full border-0 shadow-sm"
            >
              {/* Image Container with Hover Overlay */}
              <div className="aspect-[2/3] w-full bg-slate-100 relative overflow-hidden shrink-0">
                {page.url_image ? (
                  <>
                    <img
                      src={page.url_image}
                      alt={`Page ${page.numero_page}`}
                      className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
                      loading="lazy"
                    />
                    {/* Gradient Overlay */}
                    <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                  </>
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 gap-3 bg-slate-50">
                    <FileText size={48} strokeWidth={1} className="opacity-20" />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Pas d'aperçu</span>
                  </div>
                )}

                {/* Page Number Badge (Top Right) */}
                <div className="absolute top-3 right-3 z-10">
                  <Badge variant="secondary" className="bg-white/95 backdrop-blur-md text-slate-900 shadow-xl border-white font-bold px-2 py-1">
                    Page {page.numero_page}
                  </Badge>
                </div>

                {/* Status/Type Badge (Top Left) */}
                <div className="absolute top-3 left-3 z-10">
                  <Badge className="bg-amber-500/90 backdrop-blur-md text-white border-0 text-[10px] font-bold tracking-tighter uppercase px-2 shadow-sm">
                    À Vérifier
                  </Badge>
                </div>

                {/* Hover Action Button (Centered) */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-4 group-hover:translate-y-0 z-20">
                  <Link href={`/${mangaSlug}/moderation/page/${page.id}`} prefetch={false}>
                    <Button className="bg-white text-slate-900 hover:bg-slate-100 rounded-full px-6 shadow-2xl font-bold gap-2">
                      <ScanEye className="h-4 w-4" />
                      Ouvrir l'examen
                    </Button>
                  </Link>
                </div>
              </div>

              {/* Card Content */}
              <CardContent className="p-4 flex-1 flex flex-col gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                    <span className="text-[10px] uppercase font-black text-slate-400 tracking-[0.15em]">
                      Tome {page.chapitres?.tomes?.numero || '?'}
                    </span>
                  </div>
                  <h4 className="font-extrabold text-slate-900 text-lg leading-tight group-hover:text-indigo-600 transition-colors">
                    Chapitre {page.chapitres?.numero || '?'}
                  </h4>
                  {page.chapitres?.titre && (
                    <p className="text-xs text-slate-500 italic line-clamp-1">{page.chapitres.titre}</p>
                  )}
                </div>

                {/* Footer Meta */}
                <div className="pt-3 mt-auto border-t border-slate-50 flex items-center justify-between text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    {page.created_at ? new Date(page.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : 'Récemment'}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default PageReviewList;