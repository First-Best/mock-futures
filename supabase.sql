-- 24시 모의선물 순위 서버
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 Run 을 누르면 돼요. 여러 번 실행해도 괜찮아요.
--
-- 누구나 읽을 수 있는 것: 닉네임, 지갑·총 입금·보유 포지션(state), 거래·입금 기록(events)
-- 아무도 직접 쓸 수 없고, 아래 함수 세 개(join_game, report, leave_game)로만 바꿀 수 있어요.
-- 함수는 브라우저마다 만든 비밀 코드(secret)를 확인해서 자기 기록만 바꾸게 해요. 서버에는 비밀 코드의 해시만 남아요.

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  nick text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resets int not null default 0,              -- "처음부터 다시"를 누른 횟수 (모두에게 보여요)
  state jsonb not null default '{}'::jsonb    -- 브라우저가 알려 준 지갑·총 입금·월급 받은 달·보유 포지션
);
create unique index if not exists players_nick_key on public.players (lower(nick));
create index if not exists players_updated on public.players (updated_at);

create table if not exists public.player_secrets (
  id uuid primary key references public.players(id) on delete cascade,
  secret_hash text not null
);

-- 거래·입금 기록. server_at 은 서버 시각이라 브라우저가 바꿀 수 없어요 (나중에 실제 시세로 검증할 때 써요).
create table if not exists public.events (
  id bigserial primary key,
  player uuid not null references public.players(id) on delete cascade,
  server_at timestamptz not null default now(),
  body jsonb not null
);
create index if not exists events_player on public.events (player, id);

alter table public.players enable row level security;
alter table public.player_secrets enable row level security;
alter table public.events enable row level security;

drop policy if exists "players are public" on public.players;
create policy "players are public" on public.players for select using (true);
drop policy if exists "events are public" on public.events;
create policy "events are public" on public.events for select using (true);

revoke all on public.player_secrets from anon, authenticated;
revoke insert, update, delete, truncate on public.players, public.events from anon, authenticated;
grant select on public.players, public.events to anon, authenticated;

create or replace function public.secret_ok(p_id uuid, p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from player_secrets
                 where id = p_id and secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex'));
$$;
revoke execute on function public.secret_ok(uuid, text) from public, anon, authenticated;

-- 순위 참가: 닉네임(한글·영문·숫자·밑줄 2~12자)과 비밀 코드로 등록하고 id 를 돌려줘요
create or replace function public.join_game(p_nick text, p_secret text, p_state jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_nick text := btrim(coalesce(p_nick, ''));
  v_id uuid;
begin
  if char_length(v_nick) not between 2 and 12 then raise exception 'nick_length'; end if;
  if v_nick !~ '^[가-힣A-Za-z0-9_]+$' then raise exception 'nick_chars'; end if;
  if char_length(coalesce(p_secret, '')) < 24 then raise exception 'secret_short'; end if;
  if pg_column_size(p_state) > 32000 then raise exception 'too_big'; end if;
  if (select count(*) from players) >= 5000 then raise exception 'full'; end if;
  if exists (select 1 from players where lower(nick) = lower(v_nick)) then raise exception 'nick_taken'; end if;
  insert into players (nick, state) values (v_nick, coalesce(p_state, '{}'::jsonb)) returning id into v_id;
  insert into player_secrets (id, secret_hash) values (v_id, encode(sha256(convert_to(p_secret, 'UTF8')), 'hex'));
  return v_id;
end $$;

-- 내 상태 알리기: 지금 상태로 덮어쓰고, 새 거래·입금 기록을 서버 시각과 함께 쌓아요
create or replace function public.report(p_id uuid, p_secret text, p_state jsonb, p_events jsonb default '[]'::jsonb, p_reset boolean default false)
returns timestamptz language plpgsql security definer set search_path = public as $$
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  if pg_column_size(p_state) > 32000 then raise exception 'too_big'; end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 200 then raise exception 'events'; end if;
  update players set state = p_state, updated_at = now(), resets = resets + case when p_reset then 1 else 0 end where id = p_id;
  insert into events (player, body) select p_id, e from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e;
  return now();
end $$;

-- 순위에서 나가기: 내 기록을 서버에서 모두 지워요
create or replace function public.leave_game(p_id uuid, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  delete from players where id = p_id;
end $$;

revoke execute on function public.join_game(text, text, jsonb), public.report(uuid, text, jsonb, jsonb, boolean), public.leave_game(uuid, text) from public;
grant execute on function public.join_game(text, text, jsonb), public.report(uuid, text, jsonb, jsonb, boolean), public.leave_game(uuid, text) to anon, authenticated;
