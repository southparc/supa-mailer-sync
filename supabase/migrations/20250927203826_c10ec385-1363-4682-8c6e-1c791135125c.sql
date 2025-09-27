-- Phase 1: Remove the problematic ml_subscribers table and related tables
DROP TABLE IF EXISTS public.ml_subscriber_groups CASCADE;
DROP TABLE IF EXISTS public.ml_subscribers CASCADE;
DROP TABLE IF EXISTS public.ml_groups CASCADE;
DROP TABLE IF EXISTS public.ml_outbox CASCADE;
DROP TABLE IF EXISTS public.ml_sync_state CASCADE;
DROP TABLE IF EXISTS public.mailerlite_groups CASCADE;
DROP TABLE IF EXISTS public.mailerlite_profiles CASCADE;