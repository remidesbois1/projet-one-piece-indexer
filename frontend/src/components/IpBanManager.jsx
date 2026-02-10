import React, { useState, useEffect } from 'react';
import { getBannedIps, banIp, unbanIp } from '@/lib/api';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Loader2, ShieldAlert, Trash2, Plus, Ban } from "lucide-react";
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

const IpBanManager = () => {
    const [ips, setIps] = useState([]);
    const [newIp, setNewIp] = useState("");
    const [reason, setReason] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);

    const fetchIps = async () => {
        setLoading(true);
        try {
            const response = await getBannedIps();
            setIps(response.data);
            setError(null);
        } catch (err) {
            setError("Erreur chargement des IPs bannies.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchIps();
    }, []);

    const handleBan = async (e) => {
        e.preventDefault();
        if (!newIp.trim()) return;

        setSubmitting(true);
        try {
            await banIp(newIp.trim(), reason.trim() || "Banni manuellement");
            setNewIp("");
            setReason("");
            fetchIps();
        } catch (err) {
            if (err.response?.status === 409) {
                alert("IP déjà bannie.");
            } else {
                alert("Erreur lors du bannissement.");
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleUnban = async (ip) => {
        if (!window.confirm(`Débannir l'IP ${ip} ?`)) return;
        try {
            await unbanIp(ip);
            fetchIps();
        } catch (err) {
            alert("Erreur lors du débannissement.");
        }
    };

    return (
        <Card className="w-full border-none shadow-none bg-red-50/30 overflow-hidden">
            <CardHeader className="bg-transparent border-none">
                <div className="flex items-center gap-2">
                    <ShieldAlert className="h-6 w-6 text-red-600" />
                    <CardTitle className="text-2xl font-bold text-red-900">Sécurité des IPs</CardTitle>
                </div>
                <CardDescription className="text-base text-red-700/70 mt-2">
                    Bannissez les adresses IP suspectes ou abusives pour protéger votre API.
                </CardDescription>
            </CardHeader>

            <CardContent className="p-6">
                <form onSubmit={handleBan} className="flex gap-2 mb-6 flex-wrap md:flex-nowrap">
                    <Input
                        placeholder="Adresse IP (ex: 192.168.1.1)"
                        value={newIp}
                        onChange={(e) => setNewIp(e.target.value)}
                        className="flex-1 min-w-[200px]"
                    />
                    <Input
                        placeholder="Raison (optionnel)"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="flex-1 min-w-[200px]"
                    />
                    <Button type="submit" variant="destructive" disabled={!newIp.trim() || submitting}>
                        <Ban className="h-4 w-4 mr-2" /> Bannir
                    </Button>
                </form>

                {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

                <div className="relative min-h-[150px] border rounded-lg bg-slate-50/30">
                    {loading && ips.length === 0 ? (
                        <div className="flex items-center justify-center p-8">
                            <Loader2 className="h-8 w-8 animate-spin text-slate-300" />
                        </div>
                    ) : ips.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-10 text-slate-400">
                            <ShieldAlert className="h-10 w-10 mb-2 opacity-20" />
                            <p className="text-sm">Aucune IP bannie.</p>
                        </div>
                    ) : (
                        <div className="divide-y divide-slate-100">
                            <div className="grid grid-cols-12 gap-4 p-3 bg-slate-100 text-xs font-medium text-slate-500 uppercase tracking-wider">
                                <div className="col-span-3">IP</div>
                                <div className="col-span-4">Raison</div>
                                <div className="col-span-3">Date</div>
                                <div className="col-span-2 text-right">Action</div>
                            </div>
                            {ips.map((item) => (
                                <div key={item.ip} className="grid grid-cols-12 gap-4 p-3 items-center hover:bg-white transition-colors text-sm">
                                    <div className="col-span-3 font-mono font-medium text-slate-700">{item.ip}</div>
                                    <div className="col-span-4 text-slate-600 truncate" title={item.reason}>{item.reason || '-'}</div>
                                    <div className="col-span-3 text-slate-500 text-xs">
                                        {item.created_at ? format(new Date(item.created_at), 'dd MMM yyyy HH:mm', { locale: fr }) : '-'}
                                    </div>
                                    <div className="col-span-2 text-right">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0 text-slate-400 hover:text-red-600 hover:bg-red-50"
                                            onClick={() => handleUnban(item.ip)}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </CardContent>
        </Card>
    );
};

export default IpBanManager;
