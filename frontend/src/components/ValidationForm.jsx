import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createBubble, updateBubbleText } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const normalizeOcrText = (text) => (text || '').replace(/\s+/g, ' ').trim();

function groupOcrCandidates(candidates = []) {
  const groups = new Map();
  candidates.forEach((candidate) => {
    const key = normalizeOcrText(candidate.text);
    const group = groups.get(key) || { text: candidate.text || '', labels: [] };
    group.labels.push(candidate.label || candidate.modelKey);
    groups.set(key, group);
  });
  return [...groups.values()];
}

function longestCommonSubsequence(left, right) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      table[leftIndex][rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? table[leftIndex - 1][rightIndex - 1] + 1
        : Math.max(table[leftIndex - 1][rightIndex], table[leftIndex][rightIndex - 1]);
    }
  }

  const sequence = [];
  let leftIndex = left.length;
  let rightIndex = right.length;
  while (leftIndex && rightIndex) {
    if (left[leftIndex - 1] === right[rightIndex - 1]) {
      sequence.unshift(left[leftIndex - 1]);
      leftIndex -= 1;
      rightIndex -= 1;
    } else if (table[leftIndex - 1][rightIndex] >= table[leftIndex][rightIndex - 1]) {
      leftIndex -= 1;
    } else {
      rightIndex -= 1;
    }
  }
  return sequence;
}

function getAnchorPositions(text, anchors) {
  let cursor = 0;
  return anchors.map((character) => {
    const position = text.indexOf(character, cursor);
    cursor = position + 1;
    return position;
  });
}

function buildComparisonSegments(texts) {
  if (texts.length < 2) return [];
  let anchors = Array.from(texts[0]);
  texts.slice(1).forEach(text => { anchors = longestCommonSubsequence(anchors, Array.from(text)); });

  const positions = texts.map(text => getAnchorPositions(text, anchors));
  const cursors = texts.map(() => 0);
  const segments = [];
  let staticText = '';
  let differenceId = 0;

  const addDifference = (values) => {
    if (staticText) segments.push({ type: 'static', value: staticText });
    staticText = '';
    segments.push({ type: 'difference', id: differenceId, values });
    differenceId += 1;
  };

  anchors.forEach((character, anchorIndex) => {
    const values = texts.map((text, textIndex) => text.slice(cursors[textIndex], positions[textIndex][anchorIndex]));
    if (!values.every(value => value === values[0])) addDifference(values);
    staticText += character;
    cursors.forEach((_, textIndex) => { cursors[textIndex] = positions[textIndex][anchorIndex] + 1; });
  });

  const remaining = texts.map((text, index) => text.slice(cursors[index]));
  if (!remaining.every(value => value === remaining[0])) addDifference(remaining);
  if (staticText) segments.push({ type: 'static', value: staticText });
  return segments;
}

const ValidationForm = ({ annotationData, onValidationSuccess, onCancel, onReject, isSandbox = false, tone = 'light' }) => {
  const [text, setText] = useState('');
  const [isAiFailure, setIsAiFailure] = useState(false);
  const textareaRef = useRef(null);
  const isSubmitting = false;
  const isEditing = annotationData?.id && typeof annotationData.id !== 'string';

  const candidateGroups = useMemo(() => groupOcrCandidates(annotationData?.ocr_candidates), [annotationData?.ocr_candidates]);
  const comparisonSegments = useMemo(() => buildComparisonSegments(candidateGroups.map(candidate => candidate.text)), [candidateGroups]);
  const hasDifferentOcrResults = candidateGroups.length > 1;

  useEffect(() => {
    const timeout = setTimeout(() => textareaRef.current?.focus(), 100);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!annotationData) return;
      if (annotationData.texte_propose === '<REJET>') {
        setText('');
        setIsAiFailure(true);
      } else {
        setText(annotationData.texte_propose || '');
        setIsAiFailure(false);
      }
    }, 0);
    return () => clearTimeout(timeout);
  }, [annotationData]);

  const chooseWholeCandidate = (candidateIndex) => setText(candidateGroups[candidateIndex].text);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (text.trim() === '') {
      toast.error('Le texte ne peut pas être vide.');
      return;
    }
    const tempId = annotationData.id;
    const finalBubbleData = {
      id_page: annotationData.id_page,
      x: annotationData.x, y: annotationData.y,
      w: annotationData.w, h: annotationData.h,
      texte_propose: text,
      tempId: typeof tempId === 'string' ? tempId : null
    };
    onValidationSuccess({ ...finalBubbleData, id: tempId, isOptimistic: true });
    if (isSandbox) return;
    try {
      const response = isEditing
        ? await updateBubbleText(annotationData.id, text)
        : await createBubble(finalBubbleData);
      onValidationSuccess(response.data, tempId);
    } catch (error) {
      console.error('Erreur soumission background', error);
      toast.error("Erreur d'enregistrement en arrière-plan.");
    }
  };

  if (!annotationData) return null;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {isAiFailure && <div className={cn('flex gap-2 rounded-md p-3 text-sm', tone === 'dark' ? 'border border-amber-400/30 bg-amber-400/10 text-amber-100' : 'border border-amber-200 bg-amber-50 text-amber-800')}><AlertCircle className="h-5 w-5 shrink-0" /><p>L&apos;IA n&apos;a pas pu lire le texte. Veuillez le transcrire manuellement.</p></div>}

      {hasDifferentOcrResults && (
        <div className={cn('space-y-3 rounded-lg border p-3', tone === 'dark' ? 'border-amber-300/25 bg-amber-300/[0.07]' : 'border-amber-200 bg-amber-50')}>
          <div>
            <p className={cn('text-xs font-bold', tone === 'dark' ? 'text-amber-100' : 'text-amber-900')}>Comparer les propositions OCR</p>
            <p className={cn('mt-0.5 text-[11px]', tone === 'dark' ? 'text-amber-100/70' : 'text-amber-800/75')}>Choisissez la transcription la plus fiable. Seules les parties qui changent sont surlignées.</p>
          </div>

          <div className="space-y-2">
            {candidateGroups.map((candidate, candidateIndex) => (
              <button key={`${candidate.labels.join('-')}-${candidate.text}`} type="button" onClick={() => chooseWholeCandidate(candidateIndex)} className={cn('w-full rounded-md border p-2.5 text-left transition-colors', text === candidate.text ? tone === 'dark' ? 'border-sky-300/55 bg-sky-400/10' : 'border-sky-300 bg-sky-50' : tone === 'dark' ? 'border-white/10 bg-black/10 hover:bg-white/[0.05]' : 'border-amber-200/80 bg-white hover:bg-amber-50/50')}>
                <span className={cn('mb-1.5 block text-[10px] font-bold', tone === 'dark' ? 'text-sky-200' : 'text-sky-700')}>{candidate.labels.join(' + ')}</span>
                <span className={cn('block whitespace-pre-wrap break-words text-sm leading-relaxed', tone === 'dark' ? 'text-slate-100' : 'text-slate-800')}>
                  {comparisonSegments.map((segment, segmentIndex) => segment.type === 'static'
                    ? <React.Fragment key={`candidate-${candidateIndex}-static-${segmentIndex}`}>{segment.value}</React.Fragment>
                    : <mark key={`candidate-${candidateIndex}-difference-${segment.id}`} className="rounded bg-amber-300/40 px-0.5 text-inherit">{segment.values[candidateIndex] || '∅'}</mark>
                  )}
                </span>
              </button>
            ))}
          </div>

        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="bubble-text" className={tone === 'dark' ? 'text-slate-200' : undefined}>Texte de la bulle</Label>
        <Textarea id="bubble-text" ref={textareaRef} value={text} onChange={event => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); handleSubmit(event); } }} placeholder="Saisissez le texte ici..." className={cn('min-h-[120px] resize-y text-base font-medium', tone === 'dark' ? 'border-white/15 bg-slate-900 text-slate-50 placeholder:text-slate-500 focus-visible:border-sky-400 focus-visible:ring-sky-400/20' : '')} />
      </div>

      <div className="flex justify-end gap-3 pt-2">
        {onReject && <Button type="button" variant="destructive" onClick={() => onReject(annotationData.id)} disabled={isSubmitting}>Refuser</Button>}
        {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting} className={tone === 'dark' ? 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10 hover:text-white' : undefined}>Annuler</Button>}
        <Button type="submit" disabled={isSubmitting} className={cn('min-w-[140px] text-white', tone === 'dark' ? 'bg-sky-600 hover:bg-sky-500' : 'bg-slate-900 hover:bg-slate-800')}>{isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Enregistrement...</> : isEditing ? 'Mettre à jour' : 'Valider'}</Button>
      </div>
    </form>
  );
};

export default ValidationForm;
