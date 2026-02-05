import React, { useState, useEffect } from 'react';
import { getPagesForReview } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import Link from 'next/link';

import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  FileText,
  ArrowRight,
  ScanEye
} from "lucide-react";

const PageReviewList = () => {
  const { session } = useAuth();
  const [pages, setPages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (session) {
      getPagesForReview()
        .then(response => setPages(response.data))
        .catch(err => console.error("Erreur chargement pages", err))
        .finally(() => setIsLoading(false));
    }
  }, [session]);

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-200 w-fit">
          <Badge variant="default" className="bg-slate-900 hover:bg-slate-700">
            {pages.length}
          </Badge>
          <span className="text-sm font-medium pr-2">page(s) à vérifier</span>
        </div>
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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
          {pages.map(page => (
            <Card
              key={page.id}
              className="group overflow-hidden border-slate-200 hover:shadow-xl hover:ring-2 hover:ring-slate-900/10 transition-all duration-300 flex flex-col"
            >
              <div className="aspect-[2/3] w-full bg-slate-100 relative overflow-hidden">
                {page.url_image ? (
                  <>
                    <img
                      src={page.url_image}
                      alt={`Page ${page.numero_page}`}
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                      loading="lazy"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300" />
                  </>
                ) : (
                  <div className="h-full w-full flex flex-col items-center justify-center text-slate-300 gap-2">
                    <FileText size={48} strokeWidth={1} />
                    <span className="text-xs font-medium uppercase tracking-widest text-slate-400">Aperçu</span>
                  </div>
                )}

                <div className="absolute top-2 right-2">
                  <Badge variant="secondary" className="bg-white/90 backdrop-blur text-slate-900 shadow-sm border-slate-200">
                    P.{page.numero_page}
                  </Badge>
                </div>
              </div>

              <CardContent className="p-3 bg-white relative z-10 flex-1 flex flex-col justify-between">
                <div>
                  <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wider mb-0.5">
                    Tome {page.chapitres?.tomes?.numero}
                  </div>
                  <div className="font-bold text-slate-900 leading-tight">
                    Chapitre {page.chapitres?.numero}
                  </div>
                </div>
              </CardContent>

              <CardFooter className="p-3 pt-0">
                <Link href={`/moderation/page/${page.id}`} prefetch={false} className="w-full">
                  <Button size="sm" className="w-full bg-slate-900 hover:bg-slate-700 group-hover:translate-y-0 transition-all">
                    <ScanEye className="mr-2 h-4 w-4" />
                    Examiner
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default PageReviewList;