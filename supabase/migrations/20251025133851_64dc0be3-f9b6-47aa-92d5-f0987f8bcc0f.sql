-- Enable required extensions for cron jobs
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule backfill to run every 3 minutes
SELECT cron.schedule(
  'backfill-mailerlite-ids-auto',
  '*/3 * * * *',
  $$
  SELECT net.http_post(
    url:='https://bmrarrfrhhdsjvokwmgr.supabase.co/functions/v1/backfill-mailerlite-ids',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtcmFycmZyaGhkc2p2b2t3bWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQzMzU2OTksImV4cCI6MjA2OTkxMTY5OX0.xiszcPAejwU7EyZl4--l5gnKIYo2Obpbtv4JJn0ud88"}'::jsonb,
    body:='{}'::jsonb
  ) as request_id;
  $$
);