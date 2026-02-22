import React, { useState, useEffect } from 'react';
import { getGlossary, addGlossaryEntry, updateGlossaryEntry, deleteGlossaryEntry } from '@/lib/api';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Loader2, Plus, Search, Trash2, Edit2, Save, XCircle, ArrowLeft, ArrowRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const ITEMS_PER_PAGE = 10;

const GlossaryManager = () => {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [currentPage, setCurrentPage] = useState(1);

    const [newAliases, setNewAliases] = useState("");

    const [editingId, setEditingId] = useState(null);
    const [editAliases, setEditAliases] = useState("");

    const fetchGlossary = async () => {
        setLoading(true);
        try {
            const response = await getGlossary();
            setItems(response.data || []);
            setError(null);
        } catch (err) {
            setError("Erreur lors du chargement.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchGlossary();
    }, []);

    const filteredItems = items.filter(item =>
        item.aliases && item.aliases.some(a => a.toLowerCase().includes(searchTerm.toLowerCase()))
    );

    const totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
    const paginatedItems = filteredItems.slice(
        (currentPage - 1) * ITEMS_PER_PAGE,
        currentPage * ITEMS_PER_PAGE
    );

    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm]);

    const handleAdd = async (e) => {
        e.preventDefault();
        const aliasesArray = newAliases
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        if (aliasesArray.length === 0) return;

        try {
            await addGlossaryEntry(aliasesArray);
            setNewAliases("");
            fetchGlossary();
        } catch (err) {
            console.error(err);
            const msg = err.response?.data?.error || err.message || "Erreur inconnue";
            alert(`Erreur lors de l'ajout: ${msg}`);
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm("Supprimer cette entrée ?")) return;
        try {
            await deleteGlossaryEntry(id);
            setItems(items.filter(item => item.id !== id));
        } catch (err) {
            console.error(err);
            const msg = err.response?.data?.error || err.message || "Erreur inconnue";
            alert(`Erreur lors de la suppression: ${msg}`);
            fetchGlossary();
        }
    };

    const startEditing = (item) => {
        setEditingId(item.id);
        const aliases = item.aliases || [];
        setEditAliases(aliases.join(", "));
    };

    const saveEditing = async (id) => {
        const aliasesArray = editAliases
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        try {
            await updateGlossaryEntry(id, aliasesArray);
            setEditingId(null);
            fetchGlossary();
        } catch (err) {
            console.error(err);
            const msg = err.response?.data?.error || err.message || "Erreur inconnue";
            alert(`Erreur lors de la modification: ${msg}`);
        }
    };

    return (
        <Card className="w-full border-none shadow-sm bg-white">
            <CardHeader className="border-b border-slate-100 bg-slate-50/50">
                <div className="flex justify-between items-center">
                    <div>
                        <CardTitle className="text-xl font-bold text-slate-800">Glossaire de Personnages & Termes</CardTitle>
                        <CardDescription className="text-sm text-slate-500 mt-1">
                            Gérez les synonymes et alias pour enrichir la recherche. (ex: "Luffy, Mugiwara, Chapeau de Paille")
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="p-6">

                <div className="mb-8 p-4 bg-slate-50 rounded-lg border border-slate-200">
                    <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                        <Plus className="h-4 w-4" /> Ajouter une entrée
                    </h3>
                    <form onSubmit={handleAdd} className="flex flex-col md:flex-row gap-3">
                        <div className="flex-1">
                            <Input
                                placeholder="Tous les alias, séparés par des virgules (ex: Luffy, Mugiwara...)"
                                value={newAliases}
                                onChange={(e) => setNewAliases(e.target.value)}
                                className="bg-white"
                            />
                        </div>
                        <Button type="submit" disabled={!newAliases.trim() || loading}>
                            Ajouter
                        </Button>
                    </form>
                </div>


                <div className="flex items-center gap-2 mb-4">
                    <div className="relative flex-1 max-w-sm">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                        <Input
                            placeholder="Rechercher..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-9"
                        />
                    </div>
                    <div className="text-sm text-slate-400 ml-auto">
                        {filteredItems.length} entrées trouvées
                    </div>
                </div>

                {error && <p className="text-red-500 text-sm mb-4">{error}</p>}


                <div className="rounded-md border border-slate-200 overflow-hidden">
                    <Table>
                        <TableHeader className="bg-slate-50">
                            <TableRow>
                                <TableHead className="font-semibold">Alias & Variantes</TableHead>
                                <TableHead className="w-[100px] text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {loading ? (
                                <TableRow>
                                    <TableCell colSpan={2} className="h-32 text-center">
                                        <Loader2 className="h-6 w-6 animate-spin mx-auto text-slate-400" />
                                    </TableCell>
                                </TableRow>
                            ) : paginatedItems.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={2} className="h-32 text-center text-slate-500">
                                        Aucun résultat.
                                    </TableCell>
                                </TableRow>
                            ) : (
                                paginatedItems.map((item) => (
                                    <TableRow key={item.id}>
                                        <TableCell className="align-middle">
                                            {editingId === item.id ? (
                                                <Input
                                                    value={editAliases}
                                                    onChange={(e) => setEditAliases(e.target.value)}
                                                    className="h-8"
                                                />
                                            ) : (
                                                <div className="flex flex-wrap gap-1">
                                                    {item.aliases && item.aliases.length > 0 ? (
                                                        item.aliases.map((alias, idx) => (
                                                            <Badge key={idx} variant="secondary" className="bg-slate-100 text-slate-700 border hover:bg-slate-200">
                                                                {alias}
                                                            </Badge>
                                                        ))
                                                    ) : (
                                                        <span className="text-slate-300 text-xs italic">Aucun alias</span>
                                                    )}
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right align-middle">
                                            {editingId === item.id ? (
                                                <div className="flex justify-end gap-1">
                                                    <Button size="sm" variant="ghost" onClick={() => saveEditing(item.id)} className="h-8 w-8 p-0 text-green-600 hover:bg-green-50">
                                                        <Save className="h-4 w-4" />
                                                    </Button>
                                                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} className="h-8 w-8 p-0 text-slate-500 hover:bg-slate-100">
                                                        <XCircle className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="flex justify-end gap-1">
                                                    <Button size="sm" variant="ghost" onClick={() => startEditing(item)} className="h-8 w-8 p-0 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50">
                                                        <Edit2 className="h-4 w-4" />
                                                    </Button>
                                                    <Button size="sm" variant="ghost" onClick={() => handleDelete(item.id)} className="h-8 w-8 p-0 text-slate-400 hover:text-red-600 hover:bg-red-50">
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>


                {totalPages > 1 && (
                    <div className="flex items-center justify-end space-x-2 py-4">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="text-sm text-slate-500">
                            Page {currentPage} sur {totalPages}
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                        >
                            <ArrowRight className="h-4 w-4" />
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
};

export default GlossaryManager;
