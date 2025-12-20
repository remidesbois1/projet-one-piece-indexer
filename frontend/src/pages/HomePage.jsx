import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';
import { useNavigate } from 'react-router-dom';
import { getTomes, getChapitres, getPages } from '../services/api';

// --- Shadcn UI Components ---
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

// --- Icons ---
import { ChevronRight, ArrowLeft, BookOpen } from "lucide-react";

const HomePage = () => {
  const { session } = useAuth();
  const { loading: profileLoading } = useUserProfile();
  const navigate = useNavigate();

  // Data State
  const [tomes, setTomes] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [pages, setPages] = useState([]);

  // UI State
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [selectedTome, setSelectedTome] = useState(null);
  const [selectedChapter, setSelectedChapter] = useState(null);
  const [isLoadingData, setIsLoadingData] = useState(false);

  const token = session?.access_token;

  // Fetch Tomes initial
  useEffect(() => {
    if (token) {
      getTomes(token).then(res => setTomes(res.data)).catch(console.error);
    }
  }, [token]);

  // Handlers
  const openTome = async (tome) => {
    setSelectedTome(tome);
    setSelectedChapter(null);
    setPages([]);
    setIsSheetOpen(true);
    setIsLoadingData(true);
    
    try {
      const res = await getChapitres(tome.id, token);
      setChapters(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingData(false);
    }
  };

  const openChapter = async (chapter) => {
    setSelectedChapter(chapter);
    setIsLoadingData(true);
    try {
      const res = await getPages(chapter.id, token);
      setPages(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingData(false);
    }
  };

  const handleSheetChange = (open) => {
    setIsSheetOpen(open);
    if (!open) {
      // Petit délai pour reset les data après l'animation de fermeture
      setTimeout(() => {
        setSelectedTome(null);
        setSelectedChapter(null);
      }, 300);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'pending_review':
        return "bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-100 hover:border-yellow-300";
      case 'completed':
        return "bg-green-50 text-green-700 border-green-200 hover:bg-green-100 hover:border-green-300";
      case 'rejected':
        return "bg-red-50 text-red-700 border-red-200 hover:bg-red-100 hover:border-red-300";
      default:
        return "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100";
    }
  };

  if (profileLoading) return null;

  return (
    <div className="w-full max-w-[1600px] mx-auto px-6 py-8 md:px-12">
      
      {/* --- HEADER --- */}
      <header className="flex items-center justify-between mb-8 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Poneglyph Archives
          </h1>
          <Badge variant="secondary" className="font-mono text-xs">
            {tomes.length} VOL
          </Badge>
        </div>
      </header>

      {/* --- GRID DES TOMES --- */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
        {tomes.map((tome) => (
          <Card 
            key={tome.id} 
            onClick={() => openTome(tome)}
            className="group cursor-pointer overflow-hidden border-slate-200 hover:shadow-lg hover:-translate-y-1 transition-all duration-300"
          >
            <div className="aspect-[2/3] w-full overflow-hidden bg-slate-100 relative">
              {tome.cover_url ? (
                <img 
                  src={tome.cover_url} 
                  alt={`Tome ${tome.numero}`} 
                  className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-slate-300">
                  <BookOpen size={48} />
                </div>
              )}
            </div>
            <CardContent className="p-4 text-center">
              <p className="font-semibold text-slate-700 group-hover:text-black">
                Tome {tome.numero}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* --- DRAWER (SHEET) --- */}
      <Sheet open={isSheetOpen} onOpenChange={handleSheetChange}>
        <SheetContent className="w-full sm:max-w-md p-0 flex flex-col bg-white">
          
          {/* Sheet Header */}
          <div className="px-6 py-4 border-b border-slate-100">
            <SheetHeader className="text-left">
              {selectedChapter ? (
                <div className="space-y-1">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="h-6 px-0 text-slate-400 hover:text-slate-700 -ml-1"
                    onClick={() => setSelectedChapter(null)}
                  >
                    <ArrowLeft className="mr-1 h-3 w-3" />
                    Tome {selectedTome?.numero}
                  </Button>
                  <SheetTitle className="text-xl">Chapitre {selectedChapter.numero}</SheetTitle>
                  <SheetDescription>Sélectionnez une page à éditer</SheetDescription>
                </div>
              ) : (
                <div className="space-y-1 pt-2">
                   <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sélection</div>
                   <SheetTitle className="text-xl">Tome {selectedTome?.numero}</SheetTitle>
                </div>
              )}
            </SheetHeader>
          </div>

          {/* Sheet Body (Scrollable) */}
          <ScrollArea className="flex-1">
            <div className="p-6">
              
              {/* VUE 1: Liste des Chapitres */}
              {!selectedChapter && (
                isLoadingData ? (
                  <div className="space-y-3">
                    {[1,2,3,4,5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {chapters.map((chap) => (
                      <div
                        key={chap.id}
                        onClick={() => openChapter(chap)}
                        className="flex items-center justify-between p-3 rounded-lg hover:bg-slate-50 cursor-pointer group transition-colors border border-transparent hover:border-slate-100"
                      >
                        <div className="flex items-center gap-4">
                          <span className="font-mono font-semibold text-slate-500 w-8">
                            {chap.numero}
                          </span>
                          <span className="text-slate-700 font-medium group-hover:text-slate-900">
                            {chap.titre || "Sans titre"}
                          </span>
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-slate-500" />
                      </div>
                    ))}
                  </div>
                )
              )}

              {/* VUE 2: Grille de Pages (Heatmap) */}
              {selectedChapter && (
                isLoadingData ? (
                  <div className="grid grid-cols-6 gap-2">
                    {[1,2,3,4,5,6,7,8].map(i => <Skeleton key={i} className="h-10 w-10 rounded-md" />)}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {pages.map((page) => (
                      <div
                        key={page.id}
                        onClick={() => navigate(`/annotate/${page.id}`)}
                        className={`
                          h-10 w-10 flex items-center justify-center rounded-md border text-sm font-semibold cursor-pointer transition-all
                          ${getStatusColor(page.statut)}
                        `}
                        title={`Page ${page.numero_page} - ${page.statut}`}
                      >
                        {page.numero_page}
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </ScrollArea>

        </SheetContent>
      </Sheet>
    </div>
  );
};

export default HomePage;