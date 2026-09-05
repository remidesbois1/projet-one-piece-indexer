'use client';

import { useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';

export default function SubmitPageDialog({ pageNumber, onClose, onConfirm }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submitting = useRef(false);
    const cancelButton = useRef(null);

    const confirm = async () => {
        if (submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError('');
        try {
            await onConfirm();
            onClose();
        } catch (failure) {
            const reason = failure?.response?.data?.error;
            setError(typeof reason === 'string' ? reason : 'L’envoi a échoué. Réessayez dans un instant.');
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    };

    return (
        <Dialog open onOpenChange={open => { if (!open && !submitting.current) onClose(); }}>
            <DialogContent
                showCloseButton={false}
                onOpenAutoFocus={event => { event.preventDefault(); cancelButton.current?.focus(); }}
                className="gap-0 overflow-hidden rounded-2xl border-white/10 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-md"
                aria-busy={busy}
            >
                <div className="p-7 pb-6">
                    <div className="mb-5 flex items-center gap-3">
                        <span className="flex size-11 items-center justify-center rounded-xl border border-sky-400/20 bg-sky-400/10 text-sky-300"><Send size={19} aria-hidden="true" /></span>
                        <span className="text-xs font-medium tracking-wide text-slate-400">{pageNumber != null ? `PAGE ${pageNumber}` : 'VALIDATION'}</span>
                    </div>
                    <DialogTitle className="text-xl leading-snug tracking-tight">Envoyer en validation ?</DialogTitle>
                    <DialogDescription className="mt-3 text-sm leading-relaxed text-slate-400">
                        La page sera transmise à la modération pour vérification.
                    </DialogDescription>
                    {error && <p role="alert" className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">{error}</p>}
                </div>
                <DialogFooter className="border-t border-white/10 bg-white/[0.025] px-7 py-4">
                    <Button ref={cancelButton} variant="ghost" disabled={busy} onClick={onClose} className="text-slate-300 hover:bg-white/10 hover:text-white">Continuer l’annotation</Button>
                    <Button disabled={busy} onClick={confirm} className="bg-sky-600 text-white hover:bg-sky-500">
                        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                        {busy ? 'Envoi en cours…' : 'Envoyer'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
