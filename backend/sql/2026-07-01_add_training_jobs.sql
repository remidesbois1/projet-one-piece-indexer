CREATE TABLE IF NOT EXISTS public.training_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('surya_bubble_ocr', 'surya_bbox', 'lighton_ocr', 'lighton_bbox', 'trocr', 'ppocrv6_bubble_line')),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued',
        'preparing_dataset',
        'dataset_ready',
        'starting_gpu',
        'running',
        'benchmarking',
        'uploading',
        'completed',
        'failed',
        'cancelled'
    )),
    provider text NOT NULL DEFAULT 'modal' CHECK (provider IN ('modal', 'runpod', 'local')),
    modal_function_name text,
    modal_call_id text,
    modal_volume_name text,
    runpod_pod_id text,
    hf_repo text,
    params_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    metrics_json jsonb,
    summary_json jsonb,
    logs_text text,
    logs_url text,
    error_message text,
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.model_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    training_job_id uuid REFERENCES public.training_jobs(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('surya_bubble_ocr', 'surya_bbox', 'lighton_ocr', 'lighton_bbox', 'trocr', 'ppocrv6_bubble_line')),
    hf_repo text NOT NULL,
    hf_revision text,
    metrics_json jsonb,
    is_candidate boolean NOT NULL DEFAULT true,
    is_active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    promoted_at timestamptz,
    notes text
);

ALTER TABLE public.training_jobs DROP CONSTRAINT IF EXISTS training_jobs_kind_check;
ALTER TABLE public.training_jobs ADD CONSTRAINT training_jobs_kind_check
CHECK (kind IN ('surya_bubble_ocr', 'surya_bbox', 'lighton_ocr', 'lighton_bbox', 'trocr', 'ppocrv6_bubble_line'));

ALTER TABLE public.model_versions DROP CONSTRAINT IF EXISTS model_versions_kind_check;
ALTER TABLE public.model_versions ADD CONSTRAINT model_versions_kind_check
CHECK (kind IN ('surya_bubble_ocr', 'surya_bbox', 'lighton_ocr', 'lighton_bbox', 'trocr', 'ppocrv6_bubble_line'));

CREATE INDEX IF NOT EXISTS training_jobs_created_at_idx ON public.training_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS training_jobs_kind_status_idx ON public.training_jobs (kind, status);
CREATE INDEX IF NOT EXISTS model_versions_kind_created_at_idx ON public.model_versions (kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS model_versions_one_active_per_kind_idx ON public.model_versions (kind) WHERE is_active;

CREATE OR REPLACE FUNCTION public.set_training_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_training_jobs_updated_at ON public.training_jobs;
CREATE TRIGGER set_training_jobs_updated_at
BEFORE UPDATE ON public.training_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_training_updated_at();

ALTER TABLE public.training_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage training jobs" ON public.training_jobs;
CREATE POLICY "Admins manage training jobs" ON public.training_jobs
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage model versions" ON public.model_versions;
CREATE POLICY "Admins manage model versions" ON public.model_versions
USING (public.is_admin())
WITH CHECK (public.is_admin());
