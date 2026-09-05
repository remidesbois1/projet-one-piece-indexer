'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

export default function FalconSandbox() {
    const worker = useRef(null);
    const pending = useRef(new Map());
    const [status, setStatus] = useState('idle');
    const [progress, setProgress] = useState({ file: '', progress: 0 });
    const [gpu, setGpu] = useState('');
    const [examples, setExamples] = useState([]);
    const [selected, setSelected] = useState(null);
    const [result, setResult] = useState(null);
    const [results, setResults] = useState([]);
    const [stream, setStream] = useState('');
    const [error, setError] = useState('');
    useEffect(() => {
        const localUrl = selected?.blob ? selected.url : null;
        return () => { if (localUrl) URL.revokeObjectURL(localUrl); };
    }, [selected]);
    useEffect(() => {
        const w = new Worker(new URL('../../../workers/falcon.worker.js', import.meta.url), { type: 'module' });
        worker.current = w;
        w.onmessage = ({ data }) => {
            if (data.status === 'download_progress') setProgress(data);
            if (data.status === 'ready') { setStatus('ready'); setGpu(data.gpu); }
            if (data.status === 'stream') setStream(data.text);
            if (data.status === 'complete') { pending.current.get(data.requestId)?.resolve(data); pending.current.delete(data.requestId); }
            if (data.status === 'error') {
                setError(data.detail || data.error);
                setStatus(data.requestId ? 'ready' : 'error');
                pending.current.get(data.requestId)?.reject(new Error(data.error)); pending.current.delete(data.requestId);
            }
        };
        w.onerror = event => { setError(event.message); setStatus('error'); };
        fetch('/models/falcon-ocr/fixtures/examples.json').then(r => r.ok ? r.json() : []).then(values => {
            setExamples(values); if (values[0]) setSelected({ ...values[0], url: `/models/falcon-ocr/${values[0].image}` });
        }).catch(() => {});
        return () => { w.terminate(); };
    }, []);
    const recognize = async item => {
        const requestId = crypto.randomUUID();
        const imageBlob = item.blob || await (await fetch(item.url)).blob();
        return new Promise((resolve, reject) => {
            pending.current.set(requestId, { resolve, reject });
            worker.current.postMessage({ type: 'run', imageBlob, requestId });
        });
    };
    const run = async (all = false) => {
        setStatus('running'); setError(''); setStream(''); setResult(null); setResults([]);
        try {
            const items = all ? examples.map(e => ({ ...e, url: `/models/falcon-ocr/${e.image}` })) : [selected];
            const completed = [];
            for (const item of items) {
                setSelected(item); setResult(null); setStream('');
                const prediction = await recognize(item);
                setResult(prediction);
                completed.push({ ...prediction, reference: item.native || item.reference, id: item.id });
                setResults([...completed]);
            }
        } catch (e) { setError(e.message); }
        finally { setStatus('ready'); }
    };
    return <main className="mx-auto max-w-5xl px-6 py-12 space-y-8">
        <Link href="/sandbox" className="text-sm text-blue-400">← Sandbox Poneglyph</Link>
        <header><p className="text-sm uppercase tracking-widest text-blue-400">Reconnaissance locale</p>
            <h1 className="text-4xl font-semibold mt-3">Falcon-OCR · WebGPU</h1>
            <p className="mt-4 text-slate-400">Le modèle Poneglyph s’exécute sur votre GPU, directement dans Chrome. Les images restent sur votre appareil.</p></header>
        <section className="rounded-xl border border-slate-700 p-6 space-y-4">
            <div className="flex flex-wrap items-center gap-4">
                <button className="rounded-lg bg-blue-600 px-5 py-3 disabled:opacity-40" disabled={!['idle','error'].includes(status)} onClick={() => {
                    setStatus('loading'); setError(''); worker.current.postMessage({ type: 'init' });
                }}>Charger Falcon sur WebGPU</button>
                <span role="status">{status === 'loading' ? `${progress.file} · ${progress.progress.toFixed(0)} %` : status === 'ready' ? `Prêt · WebGPU · ${gpu}` : status === 'running' ? 'Transcription en cours…' : 'Modèle non chargé · environ 618 Mo'}</span>
            </div>
            {status === 'loading' && <progress className="w-full" value={progress.progress} max="100" />}
            {error && <pre role="alert" className="whitespace-pre-wrap break-all text-sm text-red-400">{error}</pre>}
        </section>
        <div className="grid gap-6 md:grid-cols-2">
            <section className="rounded-xl border border-slate-700 p-6 space-y-4">
                <h2 className="text-xl font-medium">Une bulle à transcrire</h2>
                <label className="block text-sm">Choisir une image <input className="block mt-2" type="file" accept="image/*" onChange={event => {
                    const blob = event.target.files?.[0]; if (blob) setSelected({ blob, url: URL.createObjectURL(blob) });
                }} /></label>
                {examples.length > 0 && <select aria-label="Bulle de contrôle" className="w-full rounded border p-2 bg-slate-900" value={selected?.id || ''} onChange={event => {
                    const item = examples.find(e => e.id === event.target.value); setSelected({ ...item, url: `/models/falcon-ocr/${item.image}` });
                }}>{examples.map((e,i) => <option key={e.id} value={e.id}>Bulle {i+1} · {e.reference}</option>)}</select>}
                {/* eslint-disable-next-line @next/next/no-img-element -- Local blobs and fixtures bypass the image optimizer. */}
                {selected && <img src={selected.url} alt="Bulle sélectionnée" className="max-h-80 max-w-full mx-auto bg-white" />}
                <button className="rounded-lg bg-blue-600 px-5 py-3 disabled:opacity-40" disabled={status !== 'ready' || !selected} onClick={() => run()}>Transcrire la bulle</button>
            </section>
            <section className="rounded-xl border border-slate-700 p-6 space-y-4">
                <h2 className="text-xl font-medium">Transcription</h2>
                <p className="text-2xl whitespace-pre-wrap min-h-24" aria-live="polite">{result?.text || stream || 'La transcription apparaîtra ici.'}</p>
                {result && <p className="text-sm text-slate-400">Exécution : {result.provider} · {result.timings.totalMs} ms · {result.tokens} tokens{result.tokenLimit ? ' · Limite de génération atteinte' : ''}</p>}
            </section>
        </div>
        {examples.length > 0 && <section className="rounded-xl border border-slate-700 p-6 space-y-4">
            <h2 className="text-xl font-medium">Contrôle face au modèle Python</h2>
            <p className="text-sm text-slate-400">Ces exemples locaux vérifient l’exécution. Ils ne constituent pas un benchmark indépendant du modèle réentraîné sur toutes les bulles.</p>
            <button className="rounded-lg border border-blue-500 px-5 py-3 disabled:opacity-40" disabled={status !== 'ready'} onClick={() => run(true)}>Tester les {examples.length} bulles</button>
            <ul className="space-y-3">{results.map((r,i) => <li key={i} className="rounded bg-slate-900 p-3">
                <strong>{r.text === r.reference ? 'Identique' : 'Différence'} · {r.timings.totalMs} ms · {r.provider}</strong>
                <p>{r.text}</p><p className="text-sm text-slate-400">Python : {r.reference}</p>
            </li>)}</ul>
        </section>}
    </main>;
}
