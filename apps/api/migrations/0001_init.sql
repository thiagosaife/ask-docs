create extension if not exists vector;

create table if not exists sites (
  id                  text primary key,
  tenant              text not null,
  name                text not null,
  base_url            text not null,
  public_token        text not null unique,
  allowed_origins     text[] not null,
  daily_answer_budget int not null default 500,
  created_at          timestamptz not null default now()
);

create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  tenant       text not null,
  url          text not null,
  path         text not null,
  title        text not null,
  content_hash text not null,
  fetched_at   timestamptz not null default now(),
  unique (tenant, url)
);

create table if not exists chunks (
  id           uuid primary key default gen_random_uuid(),
  tenant       text not null,
  document_id  uuid not null references documents(id) on delete cascade,
  ord          int  not null,
  url          text not null,
  path         text not null,
  anchor       text,
  anchors      text[] not null default '{}',
  heading_path text[] not null default '{}',
  header       text not null,
  content      text not null,
  token_count  int  not null,
  content_hash text not null,
  embed_model  text not null,
  embedding    vector(1536) not null,
  tsv          tsvector generated always as (
                 setweight(to_tsvector('english', header), 'A') ||
                 setweight(to_tsvector('english', content), 'B')
               ) stored,
  created_at   timestamptz not null default now()
);

create index if not exists chunks_embedding_hnsw on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_tsv_gin        on chunks using gin (tsv);
create index if not exists chunks_tenant_doc     on chunks (tenant, document_id, ord);

create table if not exists eval_runs (
  id                  uuid primary key default gen_random_uuid(),
  version             text not null,
  ran_at              timestamptz not null default now(),
  n_cases             int not null,
  recall_at5          numeric(5,4) not null,
  faithfulness        numeric(5,4) not null,
  injection_pass_rate numeric(5,4) not null,
  cost_per_answer_usd numeric(10,6) not null,
  answer_model        text not null,
  judge_model         text not null,
  embed_model         text not null,
  details             jsonb not null
);
create index if not exists eval_runs_version on eval_runs (version, ran_at desc);
