import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getMySubmissions } from '../services/api';
import { Link } from 'react-router-dom';

// Shadcn Components
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

// Icons
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";

const RESULTS_PER_PAGE = 15;

const MySubmissionsPage = () => {
    const { session } = useAuth();
    const [submissions, setSubmissions] = useState([]);
    const [totalCount, setTotalCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [isLoading, setIsLoading] = useState(true);

    const fetchSubmissions = (pageToFetch) => {
        if (session) {
            setIsLoading(true);
            getMySubmissions(pageToFetch, RESULTS_PER_PAGE)
                .then(res => {
                    setSubmissions(res.data.results);
                    setTotalCount(res.data.totalCount);
                    setCurrentPage(pageToFetch);
                })
                .catch(err => {
                    console.error("Erreur de chargement des soumissions:", err);
                })
                .finally(() => setIsLoading(false));
        }
    };

    useEffect(() => {
        if (session) {
            fetchSubmissions(1);
        }
    }, [session?.access_token]);

    const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);

    const getStatusBadge = (status) => {
        switch (status) {
            case 'Validé':
                return <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-green-200">Validé</Badge>;
            case 'Rejeté':
                return <Badge variant="destructive" className="bg-red-100 text-red-700 hover:bg-red-200 border-red-200">Rejeté</Badge>;
            default:
                return <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">En attente</Badge>;
        }
    };

    return (
        <div className="container max-w-5xl mx-auto py-10 px-4 animate-in fade-in duration-500">
            <div className="mb-8 space-y-2">
                <h1 className="text-3xl font-bold tracking-tight text-slate-900">Mes Soumissions</h1>
                <p className="text-slate-500 text-lg">
                    Suivez l'état de validation de vos contributions.
                </p>
            </div>

            <Card className="border-slate-200 shadow-sm">
                <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                    <div className="flex justify-between items-center">
                        <div>
                            <CardTitle>Historique</CardTitle>
                            <CardDescription>Vos {totalCount} propositions de traduction.</CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {isLoading ? (
                        <div className="p-6 space-y-4">
                            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
                        </div>
                    ) : submissions.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                            <Inbox className="h-12 w-12 mb-4 text-slate-300" />
                            <p>Vous n'avez encore soumis aucune bulle.</p>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead className="w-[50%]">Texte Proposé</TableHead>
                                    <TableHead>Localisation</TableHead>
                                    <TableHead className="text-right">Statut</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {submissions.map((sub) => (
                                    <TableRow key={sub.id} className="hover:bg-slate-50/50">
                                        {/* AJOUT : max-w sur la cellule et truncate sur le contenu */}
                                        <TableCell className="max-w-[200px] md:max-w-[450px]">
                                            <div
                                                className="font-medium text-slate-700 italic truncate"
                                                title={sub.texte_propose} // L'utilisateur peut voir le texte complet au survol
                                            >
                                                "{sub.texte_propose}"
                                            </div>
                                        </TableCell>

                                        <TableCell>
                                            <Link
                                                to={`/annotate/${sub.pages.id}`}
                                                className="inline-flex items-center rounded-md bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800 hover:bg-slate-200 transition-colors whitespace-nowrap"
                                            >
                                                Tome {sub.pages.chapitres.tomes.numero} • Chap {sub.pages.chapitres.numero} • P{sub.pages.numero_page}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {getStatusBadge(sub.statut)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex justify-center items-center gap-4 mt-6">
                    <Button
                        variant="outline"
                        onClick={() => fetchSubmissions(currentPage - 1)}
                        disabled={currentPage === 1}
                        size="sm"
                    >
                        <ChevronLeft className="h-4 w-4 mr-1" /> Précédent
                    </Button>

                    <span className="text-sm font-medium text-slate-600">
                        Page {currentPage} / {totalPages}
                    </span>

                    <Button
                        variant="outline"
                        onClick={() => fetchSubmissions(currentPage + 1)}
                        disabled={currentPage === totalPages}
                        size="sm"
                    >
                        Suivant <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                </div>
            )}
        </div>
    );
};

export default MySubmissionsPage;