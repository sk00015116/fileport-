-- 期限切れファイルの自動削除(30分ごと)。YOUR-PROJECT-REF と YOUR_CRON_SECRET を置き換えて実行。
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('fileport-cleanup', '*/30 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/api',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    body := '{"action":"cleanup"}'::jsonb);
$$);
