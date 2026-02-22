create extension if not exists vector;

alter table pages add column if not exists embedding_gemini halfvec(3072);

create index if not exists pages_embedding_gemini_idx on pages using hnsw (embedding_gemini halfvec_cosine_ops);
