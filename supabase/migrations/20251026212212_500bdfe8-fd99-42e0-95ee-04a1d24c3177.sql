-- Enable pg_cron extension for scheduling
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Schedule smart-sync batch job every 3 minutes
SELECT cron.schedule(
  'smart-sync-batch-runner',
  '*/3 * * * *',
  $$
  SELECT
    net.http_post(
        url:='https://bmrarrfrhhdsjvokwmgr.supabase.co/functions/v1/smart-sync',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtcmFycmZyaGhkc2p2b2t3bWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQzMzU2OTksImV4cCI6MjA2OTkxMTY5OX0.xiszcPAejwU7EyZl4--l5gnKIYo2Obpbtv4JJn0ud88"}'::jsonb,
        body:='{"mode":"full","batch":true,"maxItems":500,"timeBudgetMs":45000,"minRemaining":60,"dryRun":false}'::jsonb
    ) as request_id;
  $$
);