-- Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- Add the new column for Voyage embeddings (dimension 1024 for voyage-4-large)
alter table pages add column if not exists embedding_voyage vector(1024);

-- Create an index for faster similarity search
create index if not exists pages_embedding_voyage_idx on pages using hnsw (embedding_voyage vector_cosine_ops);
