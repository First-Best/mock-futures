-- 24시 모의선물 서버 (순위 + 아이디 로그인 + 서버 자동 체결·알림)
-- Supabase 대시보드 > SQL Editor 에 이 파일 전체를 붙여 넣고 Run 을 누르면 돼요. 여러 번 실행해도 괜찮아요.
--
-- 누구나 읽을 수 있는 것: 닉네임, 지갑·총 입금·보유 포지션·예약 주문(state), 거래·입금 기록(events)
-- 아무도 직접 쓸 수 없고, 아래 함수로만 바꿀 수 있어요. 함수는 비밀 코드(secret)나 로그인 토큰을 확인해서 자기 기록만 바꾸게 해요.
-- 서버에는 비밀 코드·토큰의 해시와 비밀번호의 bcrypt 해시만 남아요. 원래 비밀번호는 어디에도 저장되지 않아요.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  nick text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resets int not null default 0,              -- "처음부터 다시"를 누른 횟수 (예전 기록용, 모두에게 보여요)
  state jsonb not null default '{}'::jsonb    -- 지갑·총 입금·월급 받은 달·보유 포지션·예약 주문
);
create unique index if not exists players_nick_key on public.players (lower(nick));
create index if not exists players_updated on public.players (updated_at);
-- 앱이 마지막으로 열려 있던 시각. 3분 넘게 지나면 서버 엔진이 대신 체결·청산을 확인해요.
alter table public.players add column if not exists active_at timestamptz;

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

-- 아이디·비밀번호 (2026-10-11). 비밀번호는 bcrypt 해시만. 5번 틀리면 5분 잠겨요.
create table if not exists public.accounts (
  player uuid primary key references public.players(id) on delete cascade,
  login text not null,
  pw_hash text not null,
  fails int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists accounts_login_key on public.accounts (lower(login));

-- 로그인한 기기마다 하나씩 주는 토큰 (해시만 저장). 한 사람에 20개까지.
create table if not exists public.player_tokens (
  token_hash text primary key,
  player uuid not null references public.players(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists player_tokens_player on public.player_tokens (player, created_at);

-- 체결 알림을 받을 기기 (브라우저 웹 푸시 구독). 한 사람에 10개까지.
create table if not exists public.push_subs (
  endpoint text primary key,
  player uuid not null references public.players(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_player on public.push_subs (player);

-- 서버 엔진 상태. cron_key = 예약 실행(pg_cron)만 엔진을 돌릴 수 있게 하는 열쇠, vapid = 웹 푸시 서명 열쇠(엔진이 처음 돌 때 만들어요)
create table if not exists public.engine_meta (
  id int primary key default 1 check (id = 1),
  cron_key text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  vapid_public text,
  vapid_private jsonb,
  ran_at timestamptz,
  last_event bigint not null default 0,
  lev jsonb not null default '{}'::jsonb,
  lev_at timestamptz,
  last_result jsonb
);
insert into public.engine_meta (id, last_event) select 1, coalesce(max(id), 0) from public.events on conflict (id) do nothing;

alter table public.players enable row level security;
alter table public.player_secrets enable row level security;
alter table public.events enable row level security;
alter table public.accounts enable row level security;
alter table public.player_tokens enable row level security;
alter table public.push_subs enable row level security;
alter table public.engine_meta enable row level security;

drop policy if exists "players are public" on public.players;
create policy "players are public" on public.players for select using (true);
drop policy if exists "events are public" on public.events;
create policy "events are public" on public.events for select using (true);

revoke all on public.player_secrets, public.accounts, public.player_tokens, public.push_subs, public.engine_meta from anon, authenticated;
revoke insert, update, delete, truncate on public.players, public.events from anon, authenticated;
grant select on public.players, public.events to anon, authenticated;

create or replace function public.hash_of(p text)
returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;
-- 브라우저 비밀 코드(예전 순위 참가) 또는 로그인 토큰이 맞는지
create or replace function public.secret_ok(p_id uuid, p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from player_secrets where id = p_id and secret_hash = hash_of(p_secret))
      or exists (select 1 from player_tokens where player = p_id and token_hash = hash_of(p_secret));
$$;
-- 상태의 rev(기록이 바뀐 횟수). 숫자가 아니면 0
create or replace function public.rev_of(s jsonb)
returns bigint language sql immutable as $$
  select case when jsonb_typeof(s -> 'rev') = 'number' then floor((s ->> 'rev')::numeric)::bigint else 0 end;
$$;
revoke execute on function public.hash_of(text), public.secret_ok(uuid, text), public.rev_of(jsonb) from public, anon, authenticated;

-- 순위 참가 (로그인 없이, 예전 방식): 닉네임(한글·영문·숫자·밑줄 2~12자)과 비밀 코드로 등록하고 id 를 돌려줘요
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
  insert into players (nick, state, active_at) values (v_nick, coalesce(p_state, '{}'::jsonb), now()) returning id into v_id;
  insert into player_secrets (id, secret_hash) values (v_id, hash_of(p_secret));
  return v_id;
end $$;

-- 내 상태 알리기 (예전 앱용): 지금 상태로 덮어쓰고, 새 거래·입금 기록을 서버 시각과 함께 쌓아요
create or replace function public.report(p_id uuid, p_secret text, p_state jsonb, p_events jsonb default '[]'::jsonb, p_reset boolean default false)
returns timestamptz language plpgsql security definer set search_path = public as $$
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  if pg_column_size(p_state) > 32000 then raise exception 'too_big'; end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 200 then raise exception 'events'; end if;
  update players set state = p_state, updated_at = now(), active_at = now(), resets = resets + case when p_reset then 1 else 0 end where id = p_id;
  insert into events (player, body) select p_id, e from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e;
  return now();
end $$;

-- 내 상태 알리기 (v0.5): p_base = 이 기기가 마지막으로 맞춘 서버 rev. 그 사이 다른 기기나 서버 엔진이 바꿨으면
-- 덮어쓰지 않고 서버 기록을 돌려줘요 (conflict). 기기 여러 대에서 하거나 서버가 대신 체결해도 기록이 섞이지 않게.
create or replace function public.sync_state(p_id uuid, p_secret text, p_state jsonb, p_events jsonb default '[]'::jsonb, p_base bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r players;
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  if pg_column_size(p_state) > 32000 then raise exception 'too_big'; end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_events, '[]'::jsonb)) > 200 then raise exception 'events'; end if;
  update players set state = p_state, updated_at = now(), active_at = now()
   where id = p_id and (p_base is null or rev_of(state) = p_base);
  if not found then
    update players set active_at = now() where id = p_id returning * into r;
    return jsonb_build_object('conflict', true, 'state', r.state, 'updated_at', r.updated_at);
  end if;
  insert into events (player, body) select p_id, e from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) as e;
  return jsonb_build_object('ok', true, 'at', now());
end $$;

-- 앱이 열려 있다고 알리기 (1분마다). 열려 있는 동안은 서버 엔진이 끼어들지 않아요.
create or replace function public.ping(p_id uuid, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if secret_ok(p_id, p_secret) then update players set active_at = now() where id = p_id; end if;
end $$;

-- 순위에서 나가기 = 계정 지우기: 내 기록·아이디·로그인·알림 구독을 서버에서 모두 지워요
create or replace function public.leave_game(p_id uuid, p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  delete from players where id = p_id;
end $$;

-- ───────── 아이디·비밀번호 ─────────
-- 아이디: 영문 소문자·숫자·밑줄 4~20자. 비밀번호: 6자 이상 (bcrypt 한도 72바이트까지)
create or replace function public.new_token(p_player uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into player_tokens (token_hash, player) values (hash_of(v), p_player);
  delete from player_tokens where player = p_player
    and token_hash in (select token_hash from player_tokens where player = p_player order by created_at desc offset 20);
  return v;
end $$;
create or replace function public.check_login(p_login text, p_password text)
returns text language plpgsql immutable as $$
declare v text := lower(btrim(coalesce(p_login, '')));
begin
  if v !~ '^[a-z0-9_]{4,20}$' then raise exception 'login_chars'; end if;
  if char_length(coalesce(p_password, '')) < 6 or octet_length(p_password) > 72 then raise exception 'pw_length'; end if;
  return v;
end $$;
revoke execute on function public.new_token(uuid), public.check_login(text, text) from public, anon, authenticated;

-- 새로 가입: 닉네임 + 아이디 + 비밀번호 + 지금 기록. 순위에 닉네임으로 참가해요.
create or replace function public.sign_up(p_login text, p_password text, p_nick text, p_state jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_login text := check_login(p_login, p_password);
  v_nick text := btrim(coalesce(p_nick, ''));
  v_id uuid;
begin
  if char_length(v_nick) not between 2 and 12 then raise exception 'nick_length'; end if;
  if v_nick !~ '^[가-힣A-Za-z0-9_]+$' then raise exception 'nick_chars'; end if;
  if pg_column_size(p_state) > 32000 then raise exception 'too_big'; end if;
  if (select count(*) from players) >= 5000 then raise exception 'full'; end if;
  if exists (select 1 from accounts where lower(login) = v_login) then raise exception 'login_taken'; end if;
  if exists (select 1 from players where lower(nick) = lower(v_nick)) then raise exception 'nick_taken'; end if;
  insert into players (nick, state, active_at) values (v_nick, coalesce(p_state, '{}'::jsonb), now()) returning id into v_id;
  insert into accounts (player, login, pw_hash) values (v_id, v_login, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  return jsonb_build_object('id', v_id, 'nick', v_nick, 'login', v_login, 'token', new_token(v_id));
end $$;

-- 이미 순위에 참가한 기록에 아이디·비밀번호 붙이기. 붙이면 예전 비밀 코드(이어하기 링크)는 더 이상 쓸 수 없어요.
create or replace function public.add_login(p_id uuid, p_secret text, p_login text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_login text := check_login(p_login, p_password);
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  if exists (select 1 from accounts where player = p_id) then raise exception 'has_login'; end if;
  if exists (select 1 from accounts where lower(login) = v_login) then raise exception 'login_taken'; end if;
  insert into accounts (player, login, pw_hash) values (p_id, v_login, extensions.crypt(p_password, extensions.gen_salt('bf', 10)));
  delete from player_secrets where id = p_id;
  return jsonb_build_object('id', p_id, 'nick', (select nick from players where id = p_id), 'login', v_login, 'token', new_token(p_id));
end $$;

-- 로그인. 틀리면 오류 대신 {error} 를 돌려줘요 (틀린 횟수를 저장해야 해서). 5번 틀리면 5분 잠금.
create or replace function public.log_in(p_login text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a accounts;
begin
  select * into a from accounts where lower(login) = lower(btrim(coalesce(p_login, '')));
  if not found then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10));   -- 없는 아이디도 같은 시간이 걸리게
    return jsonb_build_object('error', 'login_failed');
  end if;
  if a.locked_until > now() then return jsonb_build_object('error', 'locked', 'until', a.locked_until); end if;
  if a.pw_hash <> extensions.crypt(coalesce(p_password, ''), a.pw_hash) then
    update accounts set fails = case when fails >= 4 then 0 else fails + 1 end,
                        locked_until = case when fails >= 4 then now() + interval '5 minutes' else locked_until end
     where player = a.player;
    return jsonb_build_object('error', case when a.fails >= 4 then 'locked' else 'login_failed' end);
  end if;
  update accounts set fails = 0, locked_until = null where player = a.player;
  return jsonb_build_object('id', a.player, 'nick', (select nick from players where id = a.player), 'login', a.login, 'token', new_token(a.player));
end $$;

-- 로그아웃: 이 기기 토큰과 알림 구독을 지워요
create or replace function public.log_out(p_id uuid, p_secret text, p_endpoint text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not secret_ok(p_id, p_secret) then return; end if;
  if p_endpoint is not null then delete from push_subs where player = p_id and endpoint = p_endpoint; end if;
  delete from player_tokens where player = p_id and token_hash = hash_of(p_secret);
end $$;

-- 비밀번호 바꾸기: 지금 기기만 로그인 상태로 남고 다른 기기는 다시 로그인해야 해요
create or replace function public.change_password(p_id uuid, p_secret text, p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a accounts;
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  select * into a from accounts where player = p_id;
  if not found then raise exception 'no_login'; end if;
  perform check_login(a.login, p_new);
  if a.locked_until > now() then return jsonb_build_object('error', 'locked'); end if;
  if a.pw_hash <> extensions.crypt(coalesce(p_old, ''), a.pw_hash) then
    update accounts set fails = case when fails >= 4 then 0 else fails + 1 end,
                        locked_until = case when fails >= 4 then now() + interval '5 minutes' else locked_until end
     where player = p_id;
    return jsonb_build_object('error', 'login_failed');
  end if;
  update accounts set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), fails = 0, locked_until = null where player = p_id;
  delete from player_tokens where player = p_id and token_hash <> hash_of(p_secret);
  return jsonb_build_object('ok', true);
end $$;

-- 비밀번호를 잊은 친구: 대시보드 SQL Editor 에서 select admin_set_password('아이디', '새비밀번호'); (앱에서는 부를 수 없어요)
create or replace function public.admin_set_password(p_login text, p_new text)
returns text language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform check_login(p_login, p_new);
  update accounts set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)), fails = 0, locked_until = null
   where lower(login) = lower(btrim(p_login)) returning player into v;
  if v is null then return '그런 아이디가 없어요'; end if;
  delete from player_tokens where player = v;
  return '바꿨어요. 그 친구의 다른 기기는 모두 로그아웃됐어요.';
end $$;
revoke execute on function public.admin_set_password(text, text) from public, anon, authenticated;

-- ───────── 체결 알림 (웹 푸시) ─────────
-- 서버 정보: 알림 서명 공개 열쇠, 서버 엔진이 마지막으로 돈 시각
create or replace function public.server_info()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('v', 5, 'push_key', vapid_public, 'engine_at', ran_at) from engine_meta where id = 1;
$$;
-- 알림 받을 기기 등록. 알려진 푸시 서버(구글·모질라·애플·마이크로소프트) 주소만 받아요.
create or replace function public.save_push(p_id uuid, p_secret text, p_sub jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_ep text := p_sub ->> 'endpoint';
  v_p text := p_sub #>> '{keys,p256dh}';
  v_a text := p_sub #>> '{keys,auth}';
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  if v_ep is null or char_length(v_ep) > 1000 or v_ep !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)/' then raise exception 'push_endpoint'; end if;
  if coalesce(v_p, '') !~ '^[A-Za-z0-9_-]{80,100}={0,2}$' or coalesce(v_a, '') !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then raise exception 'push_keys'; end if;
  insert into push_subs (endpoint, player, p256dh, auth) values (v_ep, p_id, v_p, v_a)
    on conflict (endpoint) do update set player = excluded.player, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  delete from push_subs where player = p_id
    and endpoint in (select endpoint from push_subs where player = p_id order by created_at desc offset 10);
end $$;
create or replace function public.drop_push(p_id uuid, p_secret text, p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if secret_ok(p_id, p_secret) then delete from push_subs where player = p_id and endpoint = p_endpoint; end if;
end $$;
-- 알림 보내 달라고 맡기기 (앱이 뒤에 숨어 있을 때 체결된 것, 시험 알림). 서버 엔진이 1분 안에 보내요. 10분에 20개까지.
create or replace function public.notify_me(p_id uuid, p_secret text, p_text text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not secret_ok(p_id, p_secret) then raise exception 'auth'; end if;
  if (select count(*) from events where player = p_id and body ->> 'k' = 'nt' and server_at > now() - interval '10 minutes') >= 20 then raise exception 'too_many'; end if;
  insert into events (player, body) values (p_id, jsonb_build_object('k', 'nt', 't', left(coalesce(p_text, ''), 200), 'at', floor(extract(epoch from now()) * 1000)));
end $$;

revoke execute on function public.join_game(text, text, jsonb), public.report(uuid, text, jsonb, jsonb, boolean), public.leave_game(uuid, text),
  public.sync_state(uuid, text, jsonb, jsonb, bigint), public.ping(uuid, text), public.sign_up(text, text, text, jsonb), public.add_login(uuid, text, text, text),
  public.log_in(text, text), public.log_out(uuid, text, text), public.change_password(uuid, text, text, text),
  public.server_info(), public.save_push(uuid, text, jsonb), public.drop_push(uuid, text, text), public.notify_me(uuid, text, text) from public;
grant execute on function public.join_game(text, text, jsonb), public.report(uuid, text, jsonb, jsonb, boolean), public.leave_game(uuid, text),
  public.sync_state(uuid, text, jsonb, jsonb, bigint), public.ping(uuid, text), public.sign_up(text, text, text, jsonb), public.add_login(uuid, text, text, text),
  public.log_in(text, text), public.log_out(uuid, text, text), public.change_password(uuid, text, text, text),
  public.server_info(), public.save_push(uuid, text, jsonb), public.drop_push(uuid, text, text), public.notify_me(uuid, text, text) to anon, authenticated;
