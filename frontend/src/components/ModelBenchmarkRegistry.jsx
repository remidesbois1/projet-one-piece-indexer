import React from 'react';
import { ExternalLink } from 'lucide-react';
import { PUBLISHED_MODEL_BENCHMARKS, formatRegistryMetric } from '@/lib/modelRegistry';

export default function ModelBenchmarkRegistry() {
    return (
        <section className="rounded-2xl border border-white/10 bg-[#071625]/70 p-5 backdrop-blur-md" aria-labelledby="model-benchmark-registry-title">
            <div className="mb-4">
                <h2 id="model-benchmark-registry-title" className="font-semibold text-white">Benchmarks publiés</h2>
                <p className="mt-1 text-xs text-slate-400">Valeurs issues du registre versionné, avec révision et protocole figés.</p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
                {PUBLISHED_MODEL_BENCHMARKS.map(model => {
                    const benchmark = model.benchmark;
                    return (
                        <article key={model.id} className="rounded-xl border border-white/10 bg-white/[0.04] p-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <h3 className="text-sm font-semibold text-slate-100">{model.display_name}</h3>
                                    <p className="mt-1 text-xs font-medium text-sky-300">{formatRegistryMetric(model.id)}</p>
                                </div>
                                <a
                                    href={benchmark.source_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-md border border-white/10 p-1.5 text-slate-400 transition hover:text-white"
                                    aria-label={`Ouvrir la preuve de ${model.display_name}`}
                                >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                            </div>
                            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px] leading-relaxed">
                                <dt className="text-slate-500">Évaluation</dt><dd className="text-slate-300">{benchmark.split} · {benchmark.sample_count.toLocaleString('fr-FR')} · {benchmark.date}</dd>
                                <dt className="text-slate-500">Matériel</dt><dd className="text-slate-300">{benchmark.hardware}</dd>
                                <dt className="text-slate-500">Version</dt><dd className="break-all font-mono text-slate-400">{model.artifact.revision.slice(0, 12)}</dd>
                                <dt className="text-slate-500">Protocole</dt><dd className="text-slate-300">{benchmark.protocol}</dd>
                            </dl>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}
