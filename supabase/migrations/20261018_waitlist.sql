-- Seltigo kurucu üye / bekleme listesi
create extension if not exists pg_net with schema extensions;

create table if not exists public.waitlist (
  id         bigserial primary key,
  email      text not null,
  sells_on   text,
  lang       text not null default 'tr',
  founder    boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists waitlist_email_uq on public.waitlist (lower(email));
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

create or replace function public.waitlist_stats()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('founders', (select count(*) from public.waitlist where founder), 'limit', 25);
$$;

create or replace function public.join_waitlist(p_email text, p_sells_on text default null, p_lang text default 'tr', p_hp text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  n int; is_f boolean; ins int; tok text; chat text;
begin
  if coalesce(p_hp, '') <> '' then
    return json_build_object('status', 'ok', 'founder', false);
  end if;
  if length(e) > 254 or e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return json_build_object('status', 'invalid');
  end if;
  if exists (select 1 from public.waitlist where lower(email) = e) then
    return json_build_object('status', 'exists');
  end if;
  if (select count(*) from public.waitlist where created_at > now() - interval '10 minutes') >= 40 then
    return json_build_object('status', 'busy');
  end if;

  perform pg_advisory_xact_lock(7311025);
  select count(*) into n from public.waitlist where founder;
  is_f := n < 25;
  insert into public.waitlist (email, sells_on, lang, founder)
  values (e, left(p_sells_on, 40), case when p_lang = 'en' then 'en' else 'tr' end, is_f)
  on conflict do nothing;
  get diagnostics ins = row_count;
  if ins = 0 then
    return json_build_object('status', 'exists');
  end if;
  if is_f then n := n + 1; end if;

  -- Telegram bildirimi: Vault'ta seltigo_bot_token ve seltigo_admin_chat_id varsa gönderir, yoksa sessizce geçer
  begin
    select decrypted_secret into tok  from vault.decrypted_secrets where name = 'seltigo_bot_token';
    select decrypted_secret into chat from vault.decrypted_secrets where name = 'seltigo_admin_chat_id';
    if tok is not null and chat is not null then
      perform net.http_post(
        url     := 'https://api.telegram.org/bot' || tok || '/sendMessage',
        body    := jsonb_build_object('chat_id', chat, 'text',
                     case when is_f then 'Yeni kurucu üye (' || n || '/25)' else 'Bekleme listesine yeni kayıt' end
                     || E'\n' || e || E'\nSatış yeri: ' || coalesce(p_sells_on, '-')),
        headers := '{"Content-Type":"application/json"}'::jsonb);
    end if;
  exception when others then null;
  end;

  return json_build_object('status', 'ok', 'founder', is_f, 'founders', n, 'limit', 25);
end $$;

revoke all on function public.waitlist_stats() from public;
revoke all on function public.join_waitlist(text, text, text, text) from public;
grant execute on function public.waitlist_stats() to anon, authenticated;
grant execute on function public.join_waitlist(text, text, text, text) to anon, authenticated;
