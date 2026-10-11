-- 24시 모의선물: 서버 자동 체결 엔진을 1분마다 깨우는 예약 작업
-- 순서: ① supabase.sql 실행 → ② Edge Functions 에 'engine' 함수 배포 (supabase/functions/engine/index.ts)
--       → ③ 이 파일을 SQL Editor 에서 실행. 여러 번 실행해도 됩니다 (예약을 지우고 다시 만들어요).
-- 엔진 열쇠(cron_key)는 이 파일에 적지 않고 실행할 때마다 표(engine_meta)에서 읽어요. 아무도 그 표를 읽을 수 없어요.
-- 아래 apikey 는 앱에도 들어 있는 공개용(publishable) 키예요. secret 키는 넣지 마세요.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'mock24-engine';

select cron.schedule('mock24-engine', '* * * * *', $$
  select net.http_post(
    url := 'https://qilswrphnmshaewzjtgj.supabase.co/functions/v1/engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_rF6Kk63W11LAsPFr-JZI0Q_JtYeLjQL',
      'x-engine-key', (select cron_key from public.engine_meta where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$$);

-- 잘 도는지 보기 (2~3분 뒤):
--   select ran_at, last_result from public.engine_meta;          -- ran_at 이 1분마다 바뀌면 정상
--   select status_code, left(content, 200) from net._http_response order by id desc limit 5;   -- 200 이면 정상
-- 멈추기:
--   select cron.unschedule('mock24-engine');
