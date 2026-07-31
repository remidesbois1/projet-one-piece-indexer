BEGIN;

CREATE TABLE IF NOT EXISTS public.modal_ocr_quota_buckets (
    scope text NOT NULL,
    subject_key text NOT NULL,
    bucket_start timestamp with time zone NOT NULL,
    used_units integer NOT NULL DEFAULT 0 CHECK (used_units >= 0),
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (scope, subject_key, bucket_start)
);

ALTER TABLE public.modal_ocr_quota_buckets
    DROP CONSTRAINT IF EXISTS modal_ocr_quota_buckets_scope_check;
ALTER TABLE public.modal_ocr_quota_buckets
    ADD CONSTRAINT modal_ocr_quota_buckets_scope_check CHECK (scope IN (
        'global_day',
        'user_day',
        'user_minute',
        'anonymous_global_minute',
        'anonymous_global_day',
        'anonymous_day',
        'anonymous_minute',
        'ip_minute',
        'device_minute'
    ));

CREATE INDEX IF NOT EXISTS modal_ocr_quota_buckets_expires_at_idx
    ON public.modal_ocr_quota_buckets (expires_at);

ALTER TABLE public.modal_ocr_quota_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.modal_ocr_quota_buckets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.modal_ocr_quota_buckets TO service_role;

-- Remove the earlier authenticated-only signature if a pre-release version of
-- this migration was applied while the anonymous sandbox quota was being added.
DROP FUNCTION IF EXISTS public.consume_modal_ocr_quota(
    uuid, text, text, integer, integer, integer, integer, integer, integer
);

CREATE OR REPLACE FUNCTION public.consume_modal_ocr_quota(
    p_user_id uuid,
    p_anonymous_hash text,
    p_ip_hash text,
    p_device_hash text,
    p_cost integer,
    p_user_minute_limit integer,
    p_user_day_limit integer,
    p_anonymous_minute_limit integer,
    p_anonymous_day_limit integer,
    p_ip_minute_limit integer,
    p_device_minute_limit integer,
    p_global_day_limit integer,
    p_anonymous_global_minute_limit integer,
    p_anonymous_global_day_limit integer
)
RETURNS TABLE (
    allowed boolean,
    retry_after_seconds integer,
    limited_scope text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now timestamp with time zone := pg_catalog.clock_timestamp();
    v_minute_start timestamp with time zone := pg_catalog.date_trunc('minute', v_now);
    v_day_start timestamp with time zone := (
        pg_catalog.date_trunc('day', v_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    );
    v_user_key text := p_user_id::text;
    v_global_used integer := 0;
    v_user_day_used integer := 0;
    v_user_minute_used integer := 0;
    v_anonymous_global_minute_used integer := 0;
    v_anonymous_global_used integer := 0;
    v_anonymous_day_used integer := 0;
    v_anonymous_minute_used integer := 0;
    v_ip_minute_used integer := 0;
    v_device_minute_used integer := 0;
    v_minute_retry integer;
    v_day_retry integer;
    v_is_anonymous boolean := p_user_id IS NULL;
BEGIN
    IF (p_user_id IS NULL AND (p_anonymous_hash IS NULL OR p_anonymous_hash !~ '^[0-9a-f]{64}$'))
        OR (p_user_id IS NOT NULL AND p_anonymous_hash IS NOT NULL)
        OR p_ip_hash IS NULL OR p_ip_hash !~ '^[0-9a-f]{64}$'
        OR p_device_hash IS NULL OR p_device_hash !~ '^[0-9a-f]{64}$'
        OR p_cost IS NULL OR p_cost <= 0
        OR p_user_minute_limit IS NULL OR p_user_minute_limit <= 0
        OR p_user_day_limit IS NULL OR p_user_day_limit <= 0
        OR p_anonymous_minute_limit IS NULL OR p_anonymous_minute_limit <= 0
        OR p_anonymous_day_limit IS NULL OR p_anonymous_day_limit <= 0
        OR p_ip_minute_limit IS NULL OR p_ip_minute_limit <= 0
        OR p_device_minute_limit IS NULL OR p_device_minute_limit <= 0
        OR p_global_day_limit IS NULL OR p_global_day_limit <= 0
        OR p_anonymous_global_minute_limit IS NULL OR p_anonymous_global_minute_limit <= 0
        OR p_anonymous_global_day_limit IS NULL OR p_anonymous_global_day_limit <= 0
    THEN
        RAISE EXCEPTION 'Invalid Modal OCR quota parameters' USING ERRCODE = '22023';
    END IF;

    -- A single transaction-scoped lock keeps every related counter atomic
    -- across all Next.js instances. It is released before OCR starts.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('poneglyph:modal-ocr-quota:v2', 0)
    );

    DELETE FROM public.modal_ocr_quota_buckets
    WHERE expires_at < v_now;

    SELECT used_units INTO v_global_used
    FROM public.modal_ocr_quota_buckets
    WHERE scope = 'global_day' AND subject_key = 'global' AND bucket_start = v_day_start;

    IF v_is_anonymous THEN
        SELECT used_units INTO v_anonymous_global_minute_used
        FROM public.modal_ocr_quota_buckets
        WHERE scope = 'anonymous_global_minute'
            AND subject_key = 'anonymous-global'
            AND bucket_start = v_minute_start;

        SELECT used_units INTO v_anonymous_global_used
        FROM public.modal_ocr_quota_buckets
        WHERE scope = 'anonymous_global_day'
            AND subject_key = 'anonymous-global'
            AND bucket_start = v_day_start;

        SELECT used_units INTO v_anonymous_day_used
        FROM public.modal_ocr_quota_buckets
        WHERE scope = 'anonymous_day'
            AND subject_key = p_anonymous_hash
            AND bucket_start = v_day_start;

        SELECT used_units INTO v_anonymous_minute_used
        FROM public.modal_ocr_quota_buckets
        WHERE scope = 'anonymous_minute'
            AND subject_key = p_anonymous_hash
            AND bucket_start = v_minute_start;
    ELSE
        SELECT used_units INTO v_user_day_used
        FROM public.modal_ocr_quota_buckets
        WHERE scope = 'user_day' AND subject_key = v_user_key AND bucket_start = v_day_start;

        SELECT used_units INTO v_user_minute_used
        FROM public.modal_ocr_quota_buckets
        WHERE scope = 'user_minute' AND subject_key = v_user_key AND bucket_start = v_minute_start;
    END IF;

    SELECT used_units INTO v_ip_minute_used
    FROM public.modal_ocr_quota_buckets
    WHERE scope = 'ip_minute' AND subject_key = p_ip_hash AND bucket_start = v_minute_start;

    SELECT used_units INTO v_device_minute_used
    FROM public.modal_ocr_quota_buckets
    WHERE scope = 'device_minute' AND subject_key = p_device_hash AND bucket_start = v_minute_start;

    v_global_used := COALESCE(v_global_used, 0);
    v_user_day_used := COALESCE(v_user_day_used, 0);
    v_user_minute_used := COALESCE(v_user_minute_used, 0);
    v_anonymous_global_minute_used := COALESCE(v_anonymous_global_minute_used, 0);
    v_anonymous_global_used := COALESCE(v_anonymous_global_used, 0);
    v_anonymous_day_used := COALESCE(v_anonymous_day_used, 0);
    v_anonymous_minute_used := COALESCE(v_anonymous_minute_used, 0);
    v_ip_minute_used := COALESCE(v_ip_minute_used, 0);
    v_device_minute_used := COALESCE(v_device_minute_used, 0);
    v_minute_retry := GREATEST(
        1,
        pg_catalog.ceil(EXTRACT(EPOCH FROM (v_minute_start + INTERVAL '1 minute' - v_now)))::integer
    );
    v_day_retry := GREATEST(
        1,
        pg_catalog.ceil(EXTRACT(EPOCH FROM (v_day_start + INTERVAL '1 day' - v_now)))::integer
    );

    IF v_global_used + p_cost > p_global_day_limit THEN
        RETURN QUERY SELECT false, v_day_retry, 'global_day'::text;
        RETURN;
    END IF;

    IF v_is_anonymous THEN
        IF v_anonymous_global_minute_used + p_cost > p_anonymous_global_minute_limit THEN
            RETURN QUERY SELECT false, v_minute_retry, 'anonymous_global_minute'::text;
            RETURN;
        END IF;
        IF v_anonymous_global_used + p_cost > p_anonymous_global_day_limit THEN
            RETURN QUERY SELECT false, v_day_retry, 'anonymous_global_day'::text;
            RETURN;
        END IF;
        IF v_anonymous_day_used + p_cost > p_anonymous_day_limit THEN
            RETURN QUERY SELECT false, v_day_retry, 'anonymous_day'::text;
            RETURN;
        END IF;
        IF v_anonymous_minute_used + p_cost > p_anonymous_minute_limit THEN
            RETURN QUERY SELECT false, v_minute_retry, 'anonymous_minute'::text;
            RETURN;
        END IF;
    ELSE
        IF v_user_day_used + p_cost > p_user_day_limit THEN
            RETURN QUERY SELECT false, v_day_retry, 'user_day'::text;
            RETURN;
        END IF;
        IF v_user_minute_used + p_cost > p_user_minute_limit THEN
            RETURN QUERY SELECT false, v_minute_retry, 'user_minute'::text;
            RETURN;
        END IF;
    END IF;

    IF v_ip_minute_used + p_cost > p_ip_minute_limit THEN
        RETURN QUERY SELECT false, v_minute_retry, 'ip_minute'::text;
        RETURN;
    END IF;
    IF v_device_minute_used + p_cost > p_device_minute_limit THEN
        RETURN QUERY SELECT false, v_minute_retry, 'device_minute'::text;
        RETURN;
    END IF;

    INSERT INTO public.modal_ocr_quota_buckets
        (scope, subject_key, bucket_start, used_units, expires_at)
    VALUES
        ('global_day', 'global', v_day_start, p_cost, v_day_start + INTERVAL '8 days'),
        ('ip_minute', p_ip_hash, v_minute_start, p_cost, v_minute_start + INTERVAL '2 days'),
        ('device_minute', p_device_hash, v_minute_start, p_cost, v_minute_start + INTERVAL '2 days')
    ON CONFLICT (scope, subject_key, bucket_start)
    DO UPDATE SET
        used_units = modal_ocr_quota_buckets.used_units + EXCLUDED.used_units,
        expires_at = GREATEST(modal_ocr_quota_buckets.expires_at, EXCLUDED.expires_at);

    IF v_is_anonymous THEN
        INSERT INTO public.modal_ocr_quota_buckets
            (scope, subject_key, bucket_start, used_units, expires_at)
        VALUES
            ('anonymous_global_minute', 'anonymous-global', v_minute_start, p_cost, v_minute_start + INTERVAL '2 days'),
            ('anonymous_global_day', 'anonymous-global', v_day_start, p_cost, v_day_start + INTERVAL '8 days'),
            ('anonymous_day', p_anonymous_hash, v_day_start, p_cost, v_day_start + INTERVAL '8 days'),
            ('anonymous_minute', p_anonymous_hash, v_minute_start, p_cost, v_minute_start + INTERVAL '2 days')
        ON CONFLICT (scope, subject_key, bucket_start)
        DO UPDATE SET
            used_units = modal_ocr_quota_buckets.used_units + EXCLUDED.used_units,
            expires_at = GREATEST(modal_ocr_quota_buckets.expires_at, EXCLUDED.expires_at);
    ELSE
        INSERT INTO public.modal_ocr_quota_buckets
            (scope, subject_key, bucket_start, used_units, expires_at)
        VALUES
            ('user_day', v_user_key, v_day_start, p_cost, v_day_start + INTERVAL '8 days'),
            ('user_minute', v_user_key, v_minute_start, p_cost, v_minute_start + INTERVAL '2 days')
        ON CONFLICT (scope, subject_key, bucket_start)
        DO UPDATE SET
            used_units = modal_ocr_quota_buckets.used_units + EXCLUDED.used_units,
            expires_at = GREATEST(modal_ocr_quota_buckets.expires_at, EXCLUDED.expires_at);
    END IF;

    RETURN QUERY SELECT true, 0, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_modal_ocr_quota(
    uuid, text, text, text,
    integer, integer, integer, integer, integer, integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_modal_ocr_quota(
    uuid, text, text, text,
    integer, integer, integer, integer, integer, integer, integer, integer, integer, integer
) TO service_role;

COMMIT;
