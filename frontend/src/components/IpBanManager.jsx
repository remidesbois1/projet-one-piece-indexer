import React, { useState, useEffect } from 'react';
import { getBannedIps, banIp, unbanIp } from '@/lib/api';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, ShieldAlert, Trash2, Ban, ShieldCheck } from "lucide-react";
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
            setError("Erreur lors du chargement des IPs bannies.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { fetchIps(); }, []);

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
        <div className="space-y-5">
            {/* Header */}
            <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-500/12">
                    <ShieldAlert className="h-4 w-4 text-rose-300" />
                </div>
                <div>
                    <h2 className="font-semibold text-white">Sécurité des IPs</h2>
                    <p className="text-xs text-slate-400">Bannissez les adresses abusives pour protéger l&apos;API.</p>
                </div>
            </div>

            {/* Ban form */}
            <form onSubmit={handleBan} className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-[#071625]/70 p-4 backdrop-blur-md">
                <Input
                    placeholder="Adresse IP (ex: 192.168.1.1)"
                    value={newIp}
                    onChange={(e) => setNewIp(e.target.value)}
                    className="min-w-[200px] flex-1"
                />
                <Input
                    placeholder="Raison (optionnel)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-w-[200px] flex-1"
                />
                <Button type="submit" variant="destructive" disabled={!newIp.trim() || submitting} className="shrink-0">
                    {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Ban className="mr-2 h-4 w-4" />}
                    Bannir
                </Button>
            </form>

            {error && <p className="text-sm text-rose-400">{error}</p>}

            {/* List */}
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#071625]/70 backdrop-blur-md">
                <div className="grid grid-cols-12 gap-4 border-b border-white/8 bg-white/[0.04] px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-slate-400">
                    <div className="col-span-3">IP</div>
                    <div className="col-span-4">Raison</div>
                    <div className="col-span-3">Date</div>
                    <div className="col-span-2 text-right">Action</div>
                </div>

                {loading && ips.length === 0 ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-7 w-7 animate-spin text-[#8dbbff]" />
                    </div>
                ) : ips.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 py-12 text-slate-400">
                        <ShieldCheck className="h-10 w-10 opacity-25" />
                        <p className="text-sm">Aucune IP bannie.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-white/6">
                        {ips.map((item) => (
                            <div key={item.ip} className="grid grid-cols-12 gap-4 px-4 py-3 text-sm transition-colors hover:bg-white/[0.04]">
                                <div className="col-span-3 font-mono font-medium text-slate-200">{item.ip}</div>
                                <div className="col-span-4 truncate text-slate-300" title={item.reason}>{item.reason || '-'}</div>
                                <div className="col-span-3 text-xs text-slate-400">
                                    {item.created_at ? format(new Date(item.created_at), 'dd MMM yyyy HH:mm', { locale: fr }) : '-'}
                                </div>
                                <div className="col-span-2 text-right">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0 text-slate-400 hover:bg-rose-500/14 hover:text-rose-300"
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
        </div>
    );
};

export default IpBanManager;
