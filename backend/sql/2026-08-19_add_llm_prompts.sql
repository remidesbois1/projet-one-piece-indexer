-- Centralise les prompts LLM auparavant dupliques entre .env, geminiClient.js,
-- chatGptDesktop/main.rs et f2llmClient.js. Les valeurs par defaut sont
-- egalement embarquees dans packages/shared/src/llm-prompts.json (fallback
-- runtime) ; cette seed n'ecrase jamais une ligne deja personnalisee.
BEGIN;

CREATE TABLE IF NOT EXISTS public.llm_prompts (
    key text NOT NULL,
    label text NOT NULL,
    category text NOT NULL,
    description text NOT NULL DEFAULT '',
    content text NOT NULL,
    updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT llm_prompts_pkey PRIMARY KEY (key),
    CONSTRAINT llm_prompts_key_check CHECK (key ~ '^[a-z0-9_]{3,64}$'),
    CONSTRAINT llm_prompts_category_check CHECK (category IN (
        'ocr',
        'description',
        'embedding',
        'search',
        'import',
        'system'
    )),
    CONSTRAINT llm_prompts_label_length_check CHECK (length(trim(label)) BETWEEN 1 AND 120),
    CONSTRAINT llm_prompts_content_length_check CHECK (length(trim(content)) BETWEEN 1 AND 20000)
);

CREATE OR REPLACE FUNCTION public.set_llm_prompt_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_llm_prompts_updated_at ON public.llm_prompts;
CREATE TRIGGER set_llm_prompts_updated_at
BEFORE UPDATE ON public.llm_prompts
FOR EACH ROW EXECUTE FUNCTION public.set_llm_prompt_updated_at();

ALTER TABLE public.llm_prompts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage llm prompts" ON public.llm_prompts;
CREATE POLICY "Admins manage llm prompts" ON public.llm_prompts
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Les contenus canoniques vivent dans packages/shared/src/llm-prompts.json.
-- La table ne stocke que les overrides personnalisés effectués depuis l'admin.

COMMIT;
