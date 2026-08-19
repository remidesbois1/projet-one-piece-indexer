-- Retire les prompts qui ne font plus partie du registre de production.
-- Les autres overrides admin sont conservés.
DELETE FROM public.llm_prompts
WHERE key IN ('ocr_firered', 'ocr_firered_dataset', 'benchmark_gemma_bbox');
