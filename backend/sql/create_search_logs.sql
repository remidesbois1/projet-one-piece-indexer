create table if not exists search_logs (
    id bigint generated always as identity primary key,
    created_at timestamptz default now(),

    user_id uuid references auth.users(id),
    user_email text,

    raw_query text not null,
    normalized_query text,
    model_provider text not null,
    search_mode text not null,

    manga_slug text,
    filter_characters jsonb,
    filter_arc text,
    filter_tome integer,

    rerank_enabled boolean default false,

    voyage_candidates_count integer,
    gemini_candidates_count integer,
    dual_overlap_count integer,
    merged_candidates_count integer,
    final_results_count integer,

    duration_normalization_ms integer,
    duration_voyage_embedding_ms integer,
    duration_gemini_embedding_ms integer,
    duration_voyage_rpc_ms integer,
    duration_gemini_rpc_ms integer,
    duration_merge_ms integer,
    duration_rerank_ms integer,
    duration_total_ms integer,

    top_result_id integer,
    top_result_score numeric,

    error text
);

create index idx_search_logs_created_at on search_logs(created_at desc);
create index idx_search_logs_user_id on search_logs(user_id);
create index idx_search_logs_model_provider on search_logs(model_provider);

alter table search_logs enable row level security;

create policy "Admins can read search logs"
    on search_logs for select
    using (
        exists (
            select 1 from profiles
            where profiles.id = auth.uid()
            and profiles.role = 'Admin'
        )
    );

create policy "Service role can insert search logs"
    on search_logs for insert
    with check (true);
