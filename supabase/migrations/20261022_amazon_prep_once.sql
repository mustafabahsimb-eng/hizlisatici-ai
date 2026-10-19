-- Amazon hızlı yükleme: aynı ürünün pahalı hazırlık işi (ana görsel düzeltme) TEK kez yapılır, diğer pazarlar sonucu bekler.
-- Yalnız sunucu (service role) kullanır; panele açık değil.
create table if not exists public.prep_once (
  key        text primary key,
  status     text not null default 'running',   -- running | done
  value      jsonb,
  updated_at timestamptz not null default now()
);
alter table public.prep_once enable row level security;
create index if not exists prep_once_updated_idx on public.prep_once (updated_at);

-- Takılı kalan senkron işleri 15 yerine 3 dakikada geri sıraya al (işçi en fazla ~150 sn çalışır)
create or replace function public.claim_sync_jobs(p_limit integer, p_worker text)
 returns setof sync_jobs
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update public.sync_jobs
  set status = 'queued', locked_at = null, locked_by = null,
      last_error = coalesce(last_error, '') || ' [zaman aşımı, tekrar sıraya alındı]'
  where status = 'running'
    and locked_at < now() - interval '3 minutes';

  -- 1 günden eski hazırlık kayıtları
  delete from public.prep_once where updated_at < now() - interval '1 day';

  return query
  update public.sync_jobs j
  set status    = 'running',
      locked_at = now(),
      locked_by = p_worker,
      attempts  = j.attempts + 1
  where j.id in (
    select s.id
    from public.sync_jobs s
    where s.status = 'queued'
      and s.run_after <= now()
    order by s.priority, s.run_after
    for update skip locked
    limit greatest(coalesce(p_limit, 10), 1)
  )
  returning j.*;
end;
$function$;
