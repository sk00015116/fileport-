-- FilePort schema: SQL Editor に貼り付けて Run
create table if not exists transfers (
  id text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','active','deleted')),
  total_size bigint not null,
  pw_hash text, pw_salt text,
  manage_hash text not null,
  ip_hash text not null,
  download_count int not null default 0,
  fail_count int not null default 0,
  lock_until timestamptz
);
create table if not exists files (
  id text primary key,
  transfer_id text not null references transfers(id) on delete cascade,
  name text not null, size bigint not null, mime text not null
);
create table if not exists downloads (
  id bigint generated always as identity primary key,
  transfer_id text not null references transfers(id) on delete cascade,
  file_id text not null,
  at timestamptz not null default now(),
  ua text
);
create index if not exists transfers_ip_idx on transfers(ip_hash, created_at);
create index if not exists transfers_exp_idx on transfers(expires_at) where status <> 'deleted';
create index if not exists files_tr_idx on files(transfer_id);
create index if not exists dl_tr_idx on downloads(transfer_id, at desc);

-- RLS 有効 + ポリシーなし = ブラウザ(anon)からは一切アクセス不可。
-- Edge Function(service role)だけが読み書きできる。
alter table transfers enable row level security;
alter table files enable row level security;
alter table downloads enable row level security;

-- 非公開バケット。サイズ上限とMIME許可リストをStorage側でも強制する。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fileport','fileport', false, 52428800, array[
 'application/pdf','image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
 'video/mp4','video/quicktime','video/webm','audio/mpeg','audio/mp4','audio/wav',
 'application/zip','text/plain','text/csv','application/msword',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set public=false, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
-- storage.objects にポリシーを作らない = 署名付きURL以外ではアクセス不可
