-- Remove the cron job for backfill-mailerlite-ids since it's redundant with the new diagnostic approach
SELECT cron.unschedule('backfill-mailerlite-ids-auto');