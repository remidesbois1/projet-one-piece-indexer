import React, { useState, useEffect } from 'react';
import { getPagesForReview } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';

// UI Components
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, BookOpen } from "lucide-react";

const PageReviewList = () => {
  const { session } = useAuth();
  const [pages, setPages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (session) {
      getPagesForReview(session.access_token)
        .then(response => setPages(response.data))
        .catch(err => console.error("Erreur chargement pages", err))
        .finally(() => setIsLoading(false));
    }
  }, [session?.access_token]);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[200px] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-slate-600 bg-slate-50 p-3 rounded-lg border border-slate-200 w-fit">
        <Badge variant="secondary" className="bg-white border-slate-200">
          {pages.length}
        </Badge>
        <span className="text-sm font-medium">page(s) en attente de vérification finale</span>
      </div>
      
      {pages.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
          <div className="flex justify-center mb-4">
            <CheckCircle2 className="h-12 w-12 text-green-500/50" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900">Tout est à jour !</h3>
          <p className="text-slate-500">Aucune page n'attend de validation pour le moment.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {pages.map(page => (
            <Card key={page.id} className="group hover:shadow-lg transition-all duration-300 hover:-translate-y-1 border-slate-200">
              <CardHeader className="pb-3">
                <CardTitle className="flex justify-between items-start">
                  <span>Chapitre {page.chapitres.numero}</span>
                  <Badge variant="outline" className="font-mono text-xs text-slate-500">
                    P.{page.numero_page}
                  </Badge>
                </CardTitle>
                <CardDescription className="flex items-center gap-1">
                  <BookOpen className="h-3 w-3" />
                  Tome {page.chapitres.tomes.numero}
                </CardDescription>
              </CardHeader>
              <CardContent className="pb-3">
                <div className="h-24 bg-slate-100 rounded-md flex items-center justify-center text-slate-400 text-sm italic border border-slate-100 group-hover:border-slate-300 transition-colors">
                  Aperçu indisponible
                </div>
              </CardContent>
              <CardFooter>
                <Link to={`/moderation/page/${page.id}`} className="w-full">
                  <Button className="w-full bg-slate-900 hover:bg-slate-800">
                    Examiner la page
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