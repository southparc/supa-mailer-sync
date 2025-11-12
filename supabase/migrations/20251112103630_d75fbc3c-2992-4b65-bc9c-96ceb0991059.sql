-- Add subscription_status column to track MailerLite subscriber status
ALTER TABLE public.clients 
ADD COLUMN subscription_status TEXT;

COMMENT ON COLUMN public.clients.subscription_status IS 'MailerLite subscription status: active, unsubscribed, bounced, junk, or unconfirmed';