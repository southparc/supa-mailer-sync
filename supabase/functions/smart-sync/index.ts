// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// Types & Constants
// ============================================================================

type FlatRecord = {
  email: string;
  first_name: string;
  last_name: string;
  city: string;
  phone: string;
  country: string;
  groups: string[];
};

interface MailerLiteSubscriber {
  id: string;
  email: string;
  status: string; // active, unsubscribed, bounced, complained, junk
  fields?: {
    name?: string;
    last_name?: string;
    city?: string;
    country?: string;
    phone?: string;
  };
  groups?: Array<{ id: string; name: string }>;
}

type SyncMode = "AtoB" | "BtoA" | "bidirectional" | "full";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ML_KEY = Deno.env.get("MAILERLITE_API_KEY")!;
const ML_BASE = "https://connect.mailerlite.com/api";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Resource protection constants
const MAX_CONCURRENT_SYNCS = 1;
const MIN_DB_CONNECTIONS_AVAILABLE = 5;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const COOLDOWN_PERIOD_MS = 60000; // 1 minute cooldown after errors
const MAX_DAILY_SYNC_RECORDS = 5000; // Max records to process per 24h period
const LOG_RETENTION_DAYS = 7; // Keep logs for 7 days only
const SHADOW_CLEANUP_DAYS = 30; // Clean up old shadow states after 30 days

const supabase = createClient(SB_URL, SB_KEY, { 
  auth: { persistSession: false },
  global: { headers: { 'x-client-info': 'smart-sync' } }
});

// Managed groups that we're allowed to remove (others stay untouched)
const MANAGED_GROUPS = ['BpvdhEmail', 'BpvdhPhone', 'BpvdhCity'];

// ============================================================================
// Token Bucket Rate Limiter for MailerLite API (120 req/min)
// ============================================================================

const MAILERLITE_RATE_LIMIT = 120; // requests per minute
const RATE_WINDOW_MS = 60000; // 1 minute

class TokenBucket {
  tokens: number;
  lastRefill: number;
  tokensPerMs: number;
  maxTokens: number;
  supabaseClient: SupabaseClient;
  
  constructor(maxTokens: number, windowMs: number, supabaseClient: SupabaseClient) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.tokensPerMs = maxTokens / windowMs;
    this.supabaseClient = supabaseClient;
  }
  
  // Load state from database
  async restore(): Promise<void> {
    try {
      const { data, error } = await this.supabaseClient
        .from('sync_state')
        .select('value')
        .eq('key', 'token_bucket_state')
        .maybeSingle();
      
      if (error) {
        console.error('Failed to restore token bucket state:', error);
        return;
      }
      
      if (data?.value) {
        const state = data.value as any;
        this.tokens = state.tokens || this.maxTokens;
        this.lastRefill = state.lastRefill || Date.now();
        console.log(`🪣 Restored token bucket: ${Math.floor(this.tokens)} tokens available`);
      }
    } catch (err) {
      console.error('Error restoring token bucket:', err);
    }
  }
  
  // Save state to database
  async save(): Promise<void> {
    try {
      const { error } = await this.supabaseClient
        .from('sync_state')
        .upsert({
          key: 'token_bucket_state',
          value: {
            tokens: this.tokens,
            lastRefill: this.lastRefill,
            timestamp: new Date().toISOString()
          },
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
      
      if (error) {
        console.error('Failed to save token bucket state:', error);
      }
    } catch (err) {
      console.error('Error saving token bucket:', err);
    }
  }
  
  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    
    // Refill tokens based on time elapsed
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + (elapsed * this.tokensPerMs)
    );
    this.lastRefill = now;
    
    // If no tokens available, wait
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.tokensPerMs);
      console.log(`🪣 Token bucket empty, waiting ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
      this.tokens = 1;
      this.lastRefill = Date.now();
    }
    
    // Consume one token
    this.tokens -= 1;
    
    // Save state after consuming token (every 10th request to reduce DB writes)
    if (Math.floor(this.tokens) % 10 === 0) {
      await this.save();
    }
  }
  
  getAvailable(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    return Math.min(
      this.maxTokens,
      this.tokens + (elapsed * this.tokensPerMs)
    );
  }
  
  getUtilization(): number {
    const available = this.getAvailable();
    return ((this.maxTokens - available) / this.maxTokens) * 100;
  }
}

// Rate limiter with persistent state (created after supabase client)
const mlRateLimiter = new TokenBucket(MAILERLITE_RATE_LIMIT, RATE_WINDOW_MS, supabase);

// Legacy rate tracking for backward compatibility
const LAST_RATE = { remaining: undefined as number | undefined, retryAfter: undefined as number | undefined };
let MANAGED_GROUPS_CACHE: Set<string> | null = null;

// ============================================================================
// Resource Protection Helpers
// ============================================================================

async function checkDatabaseHealth(): Promise<{ healthy: boolean; message: string }> {
  try {
    // Check if we can connect and query
    const { error } = await supabase
      .from('sync_log')
      .select('id')
      .limit(1);
    
    if (error) {
      return { healthy: false, message: `Database error: ${error.message}` };
    }
    
    return { healthy: true, message: 'Database healthy' };
  } catch (err: any) {
    return { healthy: false, message: `Database check failed: ${err.message}` };
  }
}

async function checkConcurrentSyncs(): Promise<{ canRun: boolean; message: string }> {
  try {
    // Check for recent running syncs (within last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('sync_log')
      .select('id, created_at')
      .gte('created_at', fiveMinutesAgo)
      .order('created_at', { ascending: false })
      .limit(10);
    
    if (error) {
      console.error('⚠️ Could not check concurrent syncs:', error);
      // Fail safe - allow sync if we can't check
      return { canRun: true, message: 'Could not verify concurrent syncs' };
    }
    
    // If there are many recent sync logs, another sync might be running
    if (data && data.length > 50) {
      return { canRun: false, message: 'Possible concurrent sync detected' };
    }
    
    return { canRun: true, message: 'No concurrent syncs detected' };
  } catch (err: any) {
    console.error('⚠️ Concurrent sync check error:', err);
    return { canRun: true, message: 'Concurrent check failed, proceeding cautiously' };
  }
}

async function checkRecentErrors(): Promise<{ shouldRun: boolean; message: string }> {
  try {
    // Check for recent errors in last 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('sync_log')
      .select('direction, result, error_type')
      .gte('created_at', tenMinutesAgo)
      .or('result.eq.error,error_type.not.is.null')
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (error) {
      console.error('⚠️ Could not check recent errors:', error);
      return { shouldRun: true, message: 'Could not check error history' };
    }
    
    // Count errors
    const errorCount = data?.length || 0;
    
    if (errorCount >= CIRCUIT_BREAKER_THRESHOLD) {
      return { 
        shouldRun: false, 
        message: `Circuit breaker: ${errorCount} errors in last 10 minutes. Cooldown period active.` 
      };
    }
    
    return { shouldRun: true, message: 'Error rate acceptable' };
  } catch (err: any) {
    console.error('⚠️ Error check failed:', err);
    return { shouldRun: true, message: 'Could not verify error rate' };
  }
}

/**
 * Get last successful sync timestamp for incremental sync
 */
async function getLastSyncTimestamp(): Promise<{ timestamp: string | null; syncedAt: string | null }> {
  try {
    const { data, error } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'last_successful_sync')
      .maybeSingle();
    
    if (error) {
      console.error('Failed to get last sync timestamp:', error);
      return { timestamp: null, syncedAt: null };
    }
    
    if (data?.value) {
      const state = data.value as any;
      return {
        timestamp: state.timestamp || null,
        syncedAt: state.syncedAt || null
      };
    }
    
    return { timestamp: null, syncedAt: null };
  } catch (err) {
    console.error('Error getting last sync timestamp:', err);
    return { timestamp: null, syncedAt: null };
  }
}

/**
 * Update last successful sync timestamp
 */
async function updateLastSyncTimestamp(): Promise<void> {
  try {
    const now = new Date().toISOString();
    
    const { error } = await supabase
      .from('sync_state')
      .upsert({
        key: 'last_successful_sync',
        value: {
          timestamp: now,
          syncedAt: now
        },
        updated_at: now
      }, { onConflict: 'key' });
    
    if (error) {
      console.error('Failed to update last sync timestamp:', error);
    } else {
      console.log(`✅ Updated last sync timestamp: ${now}`);
    }
  } catch (err) {
    console.error('Error updating last sync timestamp:', err);
  }
}

/**
 * Save cumulative sync statistics to sync_state
 */
async function saveSyncStatistics(stats: { created: number; updated: number; skipped: number; errors: number; conflicts?: number }): Promise<void> {
  try {
    // Load existing stats
    const { data: existing } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'sync_statistics')
      .maybeSingle();
    
    const existingStats = (existing?.value as any) || { recordsProcessed: 0, updatesApplied: 0, conflicts: 0 };
    
    // Increment cumulative stats
    const updatedStats = {
      recordsProcessed: (existingStats.recordsProcessed || 0) + (stats.created + stats.updated),
      updatesApplied: (existingStats.updatesApplied || 0) + (stats.created + stats.updated),
      conflicts: (existingStats.conflicts || 0) + (stats.conflicts || 0),
      lastUpdated: new Date().toISOString()
    };
    
    const { error } = await supabase
      .from('sync_state')
      .upsert({ 
        key: 'sync_statistics', 
        value: updatedStats, 
        updated_at: new Date().toISOString() 
      }, { onConflict: 'key' });
    
    if (error) {
      console.error('Failed to save sync statistics:', error);
    } else {
      console.log(`✅ Saved sync statistics: ${JSON.stringify(updatedStats)}`);
    }
  } catch (error) {
    console.error('Error saving sync statistics:', error);
  }
}

/**
 * Calculate and save sync percentage between MailerLite and Supabase
 */
async function calculateAndSaveSyncPercentage(): Promise<void> {
  try {
    console.log('📊 Calculating sync percentage...');
    
    // Get total MailerLite subscribers
    const mlResponse = await retryFetch(`${ML_BASE}/subscribers?limit=1`, {
      method: 'GET',
      headers: { 
        'Authorization': `Bearer ${ML_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!mlResponse.ok) {
      console.error('Failed to fetch MailerLite count');
      return;
    }
    
    const mlData = await mlResponse.json();
    const totalMailerLite = mlData.meta?.total || 0;
    
    // Get total Supabase clients
    const { count: totalSupabase, error: sbError } = await supabase
      .from('clients')
      .select('*', { count: 'exact', head: true });
    
    if (sbError) {
      console.error('Failed to fetch Supabase count:', sbError);
      return;
    }
    
    // Get matched emails from crosswalk
    const { count: matchedCount, error: matchError } = await supabase
      .from('integration_crosswalk')
      .select('*', { count: 'exact', head: true })
      .not('a_id', 'is', null)
      .not('b_id', 'is', null);
    
    if (matchError) {
      console.error('Failed to fetch matched count:', matchError);
      return;
    }
    
    const matched = matchedCount || 0;
    const total = Math.max(totalMailerLite, totalSupabase || 0);
    const percentage = total > 0 ? (matched / total) * 100 : 0;
    
    const syncPercentageStatus = {
      percentage,
      totalMailerLite,
      totalSupabase: totalSupabase || 0,
      matched,
      lastCalculated: new Date().toISOString()
    };
    
    const { error } = await supabase
      .from('sync_state')
      .upsert({ 
        key: 'sync_percentage_status', 
        value: syncPercentageStatus, 
        updated_at: new Date().toISOString() 
      }, { onConflict: 'key' });
    
    if (error) {
      console.error('Failed to save sync percentage:', error);
    } else {
      console.log(`✅ Sync percentage: ${percentage.toFixed(1)}% (${matched}/${total} records in sync)`);
    }
  } catch (error) {
    console.error('Error calculating sync percentage:', error);
  }
}

/**
 * Determine if incremental sync should be used
 * - Use incremental if last sync was less than 24 hours ago
 * - Otherwise do full sync
 */
function shouldUseIncrementalSync(lastSync: { timestamp: string | null; syncedAt: string | null }): boolean {
  if (!lastSync.timestamp || !lastSync.syncedAt) {
    console.log('🔄 No previous sync found - performing full sync');
    return false;
  }
  
  const lastSyncTime = new Date(lastSync.syncedAt).getTime();
  const now = Date.now();
  const hoursSinceLastSync = (now - lastSyncTime) / (1000 * 60 * 60);
  
  // Force full sync every 24 hours
  if (hoursSinceLastSync >= 24) {
    console.log(`🔄 Last sync was ${hoursSinceLastSync.toFixed(1)} hours ago - performing full sync`);
    return false;
  }
  
  console.log(`⚡ Last sync was ${hoursSinceLastSync.toFixed(1)} hours ago - using incremental sync`);
  return true;
}

/**
 * Clean up old sync logs to prevent database bloat
 */
async function cleanupOldLogs(): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);
  
  const { error } = await supabase
    .from('sync_log')
    .delete()
    .lt('created_at', cutoffDate.toISOString());
  
  if (error) {
    console.warn(`⚠️ Failed to cleanup old logs: ${error.message}`);
  } else {
    console.log(`✅ Cleaned up sync logs older than ${LOG_RETENTION_DAYS} days`);
  }
}

/**
 * Clean up old shadow states to prevent database bloat
 */
async function cleanupOldShadows(): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - SHADOW_CLEANUP_DAYS);
  
  const { error } = await supabase
    .from('sync_shadow')
    .delete()
    .lt('updated_at', cutoffDate.toISOString());
  
  if (error) {
    console.warn(`⚠️ Failed to cleanup old shadows: ${error.message}`);
  } else {
    console.log(`✅ Cleaned up shadow states older than ${SHADOW_CLEANUP_DAYS} days`);
  }
}

/**
 * Check how many records have been synced in the last 24 hours
 */
async function checkDailyQuota(): Promise<{ processed: number; remaining: number; allowed: boolean }> {
  const oneDayAgo = new Date();
  oneDayAgo.setHours(oneDayAgo.getHours() - 24);
  
  const { count, error } = await supabase
    .from('sync_log')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', oneDayAgo.toISOString());
  
  if (error) {
    console.warn(`⚠️ Failed to check daily quota: ${error.message}`);
    return { processed: 0, remaining: MAX_DAILY_SYNC_RECORDS, allowed: true };
  }
  
  const processed = count || 0;
  const remaining = Math.max(0, MAX_DAILY_SYNC_RECORDS - processed);
  const allowed = remaining > 0;
  
  console.log(`📊 Daily quota: ${processed}/${MAX_DAILY_SYNC_RECORDS} records processed (${remaining} remaining)`);
  
  return { processed, remaining, allowed };
}

// ============================================================================
// Helpers
// ============================================================================

function stableStringify(o: any): string {
  if (Array.isArray(o)) return JSON.stringify([...o].sort());
  return JSON.stringify(o, Object.keys(o).sort());
}

function isNonEmpty(v: any): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function pickNonEmpty<T extends Record<string, any>>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) {
    if (isNonEmpty(obj[k])) out[k] = obj[k];
  }
  return out;
}

function jsonCompact(o: any): string {
  return JSON.stringify(o);
}

/**
 * Phase 1.3: Email normalization (lowercase + trim)
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Phase 1.1: Deterministic idempotency key (SHA256 hash)
 * Uses timestamp bucket (hourly) to prevent duplicates within same hour
 */
async function generateDedupeKey(email: string, action: string, payload: any): Promise<string> {
  const hourBucket = Math.floor(Date.now() / 3600000); // Round to hour
  const canonical = stableStringify({ email: normalizeEmail(email), action, hourBucket, payload });
  
  const encoder = new TextEncoder();
  const data = encoder.encode(canonical);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Phase 2.1: Retry with exponential backoff + proactive rate limiting via token bucket
 */
async function retryFetch(url: string, init: RequestInit, tries = 8, dryRun = false): Promise<Response> {
  if (dryRun) {
    console.log(`[DRY-RUN] Would fetch: ${init.method || 'GET'} ${url}`);
    return new Response(JSON.stringify({ data: { id: 'dry-run-id' } }), { status: 200 });
  }

  const MAX_BACKOFF_MS = 60_000; // cap waits to 60s

  function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    // ⭐ PROACTIVE RATE LIMITING: Acquire token before making request
    await mlRateLimiter.acquire();

    const res = await fetch(url, init);

    // Track rate limits for observability
    const rlRemaining = res.headers.get('X-RateLimit-Remaining');
    const rlReset = res.headers.get('X-RateLimit-Reset');
    const retryAfter = res.headers.get('Retry-After');
    
    if (rlRemaining) {
      const remaining = parseInt(rlRemaining, 10);
      if (!Number.isNaN(remaining)) {
        LAST_RATE.remaining = remaining;
      }
    }
    
    if (retryAfter) {
      const raNum = Number(retryAfter);
      if (!Number.isNaN(raNum)) {
        LAST_RATE.retryAfter = raNum;
      }
    }
    
    // Update rate limit status for monitoring (fire-and-forget)
    const tokensAvailable = mlRateLimiter.getAvailable();
    const utilization = mlRateLimiter.getUtilization();
    supabase.from('sync_state').upsert({
      key: 'mailerlite_rate_limit_status',
      value: { 
        tokensAvailable: Math.floor(tokensAvailable),
        utilizationPercent: utilization.toFixed(1),
        requestsInLastMinute: MAILERLITE_RATE_LIMIT - Math.floor(tokensAvailable),
        headerRemaining: rlRemaining ? parseInt(rlRemaining, 10) : null,
        timestamp: new Date().toISOString()
      },
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' }).then(() => {/* success */}, () => {/* ignore errors */});

    if (res.status !== 429 && res.status < 500) {
      // Success or client error (not retryable)
      return res;
    }

    // Determine wait from headers (Retry-After or rate-limit reset)
    let waitMs = 0;
    if (retryAfter) {
      const raNum = Number(retryAfter);
      if (!Number.isNaN(raNum)) waitMs = Math.max(raNum * 1000, 1000);
    }
    if (!waitMs && rlReset) {
      const resetEpoch = Number(rlReset);
      if (!Number.isNaN(resetEpoch)) {
        // if looks like seconds epoch
        const resetMs = resetEpoch < 1e12 ? resetEpoch * 1000 : resetEpoch;
        waitMs = Math.max(resetMs - Date.now(), 1000);
      }
    }
    if (!waitMs) {
      // Exponential backoff with jitter
      const base = Math.min(MAX_BACKOFF_MS, Math.pow(2, i) * 1000);
      const jitter = Math.floor(Math.random() * 250);
      waitMs = Math.max(1000, base + jitter);
    }

    last = res;
    console.log(`  ⏳ Retry ${i + 1}/${tries} after ${waitMs}ms (status: ${res.status})`);
    await sleep(waitMs);
  }
  return last!;
}

/**
 * Calculate optimal batch size based on available rate limit tokens
 */
function calculateOptimalBatchSize(operation: 'AtoB' | 'BtoA'): number {
  const availableTokens = mlRateLimiter.getAvailable();
  
  if (operation === 'AtoB') {
    // A→B: 1-2 API calls per email (update subscriber + maybe groups)
    // Leave 30% buffer for retries and other calls
    return Math.max(5, Math.floor(availableTokens * 0.7 / 2));
  } else {
    // B→A: 1 API call per email (fetch subscriber)
    // Leave 30% buffer
    return Math.max(5, Math.floor(availableTokens * 0.7));
  }
}

/**
 * Get adaptive batch multiplier based on database health and rate limit usage
 */
function getAdaptiveBatchMultiplier(dbHealthy: boolean): number {
  const utilization = mlRateLimiter.getUtilization();
  
  if (!dbHealthy) return 0.3; // Slow down if DB struggling
  if (utilization > 80) return 0.5; // Conservative when heavily utilized
  if (utilization > 50) return 0.8; // Balanced mode
  return 1.0; // Full speed ahead
}

/**
 * Idempotency check
 */
async function alreadyDone(dedupe_key: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("sync_log")
    .select("id")
    .eq("dedupe_key", dedupe_key)
    .eq("result", "ok")
    .limit(1);
  
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Phase 2.2: Get managed groups whitelist
 */
async function getManagedGroups(): Promise<Set<string>> {
  if (MANAGED_GROUPS_CACHE) return MANAGED_GROUPS_CACHE;
  
  const { data, error } = await supabase
    .from('managed_mailerlite_groups')
    .select('ml_group_id');
  
  if (error) {
    console.error('Error fetching managed groups:', error);
    return new Set();
  }
  
  MANAGED_GROUPS_CACHE = new Set((data || []).map(r => r.ml_group_id));
  console.log(`📋 Loaded ${MANAGED_GROUPS_CACHE.size} managed groups`);
  return MANAGED_GROUPS_CACHE;
}

// ============================================================================
// Phase 1.2: MailerLite Status Helpers
// ============================================================================

/**
 * Check if a subscriber should not be re-subscribed
 */
function isProtectedStatus(status: string): boolean {
  return ['unsubscribed', 'bounced', 'complained', 'junk'].includes(status.toLowerCase());
}

/**
 * Get current MailerLite subscriber status
 */
async function getMailerLiteStatus(b_id: string, dryRun = false): Promise<string | null> {
  if (dryRun) return 'active';
  
  try {
    const res = await fetch(`${ML_BASE}/subscribers/${b_id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
    });
    
    if (!res.ok) return null;
    const sub = await res.json();
    return sub.status || null;
  } catch (e) {
    console.error('Error fetching ML status:', e);
    return null;
  }
}

// ============================================================================
// Phase 1.4: Supabase Pagination (Batched)
// ============================================================================

/**
 * Fetch ALL MailerLite subscribers with pagination
 */
async function getAllMailerLiteSubscribers(dryRun = false, incrementalFrom?: string): Promise<Map<string, MailerLiteSubscriber>> {
  const result = new Map<string, MailerLiteSubscriber>();
  
  if (dryRun) {
    console.log('[DRY-RUN] Would fetch all MailerLite subscribers');
    return result;
  }

  let cursor: string | null = null;
  let page = 0;

  if (incrementalFrom) {
    console.log(`📥 Fetching MailerLite subscribers updated since ${incrementalFrom}...`);
  } else {
    console.log('📥 Fetching all MailerLite subscribers...');
  }

  do {
    const url = new URL(`${ML_BASE}/subscribers`);
    url.searchParams.set('limit', '1000');
    // Don't filter by status - this returns all subscribers regardless of status
    if (cursor) url.searchParams.set('cursor', cursor);
    
    // Incremental sync: only fetch records updated after timestamp
    if (incrementalFrom) {
      url.searchParams.set('filter[updated_at][from]', incrementalFrom);
    }

    const res = await retryFetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${ML_KEY}`,
        'Content-Type': 'application/json',
      },
    }, 8, dryRun);

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ MailerLite API error: ${res.status} ${err}`);
      throw new Error(`MailerLite subscribers fetch failed: ${res.status}`);
    }

    const json = await res.json();
    const subscribers = json.data || [];
    
    for (const sub of subscribers) {
      const email = normalizeEmail(sub.email || '');
      if (email) {
        result.set(email, sub);
      }
    }

    cursor = json.links?.next ? new URL(json.links.next).searchParams.get('cursor') : null;
    page++;
    console.log(`  Page ${page}: fetched ${subscribers.length} subscribers (total: ${result.size})`);

  } while (cursor);

  console.log(`✅ Total MailerLite subscribers: ${result.size}`);
  return result;
}

/**
 * Phase 1.4: Batched Supabase client fetching with keyset pagination
 */
async function getAllSupabaseClients(dryRun = false): Promise<Map<string, { id: string; email: string; marketing_status?: string }>> {
  const result = new Map<string, { id: string; email: string; marketing_status?: string }>();
  
  if (dryRun) {
    console.log('[DRY-RUN] Would fetch all Supabase clients');
    return result;
  }
  
  console.log('📥 Fetching all Supabase clients (batched)...');
  
  let lastId = '00000000-0000-0000-0000-000000000000';
  const batchSize = 1000;
  let batchNum = 0;
  
  while (true) {
    const { data, error } = await supabase
      .from('clients')
      .select('id, email, marketing_status')
      .gt('id', lastId)
      .order('id')
      .limit(batchSize);

    if (error) {
      console.error('❌ Supabase clients fetch error:', error);
      throw error;
    }

    if (!data || data.length === 0) break;

    for (const client of data) {
      const email = normalizeEmail(client.email || '');
      if (email) {
        result.set(email, { 
          id: client.id, 
          email,
          marketing_status: client.marketing_status || undefined
        });
      }
    }

    lastId = data[data.length - 1].id;
    batchNum++;
    console.log(`  Batch ${batchNum}: fetched ${data.length} clients (total: ${result.size})`);
    
    if (data.length < batchSize) break;
  }

  console.log(`✅ Total Supabase clients: ${result.size}`);
  return result;
}

// ============================================================================
// Phase 2.4: Create Client with Duplicate Detection
// ============================================================================

/**
 * Create a new client in Supabase from MailerLite data
 * Phase 1.3: Duplicate email detection
 * Phase 1.2: Store marketing_status
 */
async function createClientFromMailerLite(mlSub: MailerLiteSubscriber, dryRun = false): Promise<string | null> {
  const email = normalizeEmail(mlSub.email);
  
  if (dryRun) {
    console.log(`[DRY-RUN] Would create client: ${email}`);
    return 'dry-run-client-id';
  }
  
  console.log(`➕ Creating new client from MailerLite: ${email}`);

  // Phase 2.4: Check if client already exists (conflict detection)
  const { data: existing, error: checkErr } = await supabase
    .from('clients')
    .select('id, email')
    .eq('email', email)
    .maybeSingle();

  if (checkErr) {
    console.error(`❌ Error checking for existing client ${email}:`, checkErr);
    return null;
  }

  if (existing) {
    console.log(`⚠️ Client ${email} already exists (id: ${existing.id}), updating crosswalk instead`);
    await updateCrosswalkB(email, mlSub.id, dryRun);
    return existing.id;
  }

  // Extract fields from MailerLite
  const firstName = mlSub.fields?.name || null;
  const lastName = mlSub.fields?.last_name || null;
  const city = mlSub.fields?.city || null;
  const country = mlSub.fields?.country || null;
  const phone = mlSub.fields?.phone || null;
  const marketingStatus = isProtectedStatus(mlSub.status) ? mlSub.status : 'active';

  // Phase 3.3: UPSERT to handle duplicates gracefully
  const { data, error } = await supabase
    .from('clients')
    .upsert({
      email,
      first_name: firstName,
      last_name: lastName,
      city,
      country,
      phone,
      marketing_status: marketingStatus,
    }, { 
      onConflict: 'email',
      ignoreDuplicates: false 
    })
    .select('id')
    .single();

  if (error) {
    console.error(`❌ Error creating/updating client ${email}:`, error);
    
    // Log conflict
    await supabase.from('sync_conflicts').insert({
      email,
      field: 'email',
      a_value: email,
      b_value: email,
      status: 'pending'
    });
    
    return null;
  }

  const clientId = data.id;
  console.log(`✅ Created/updated client ${email} with id ${clientId}`);

  // Update crosswalk with b_id
  await updateCrosswalkB(email, mlSub.id, dryRun);

  return clientId;
}

// ============================================================================
// Database operations
// ============================================================================

async function insertLog(row: {
  email: string;
  direction: "A→B" | "B→A" | "bidirectional";
  action: string;
  result: string;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  dedupe_key?: string | null;
  status_code?: number | null;
  error_type?: string | null;
}) {
  const { error } = await supabase.from("sync_log").insert(row);
  if (error) console.error("Log insert error:", error);
}

async function getShadow(email: string): Promise<FlatRecord | null> {
  const { data, error } = await supabase
    .from("sync_shadow")
    .select("snapshot")
    .eq("email", normalizeEmail(email))
    .maybeSingle();
  
  if (error) {
    console.error("Shadow fetch error:", error);
    return null;
  }
  return data?.snapshot as FlatRecord | null;
}

async function putShadow(email: string, snapshot: FlatRecord, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY-RUN] Would update shadow for: ${email}`);
    return;
  }

  const { error } = await supabase
    .from("sync_shadow")
    .upsert({ 
      email: normalizeEmail(email), 
      snapshot, 
      updated_at: new Date().toISOString() 
    }, { onConflict: "email" });
  
  if (error) console.error("Shadow upsert error:", error);
}

function diff(a: FlatRecord, b: FlatRecord | null): { changed: boolean; fields: (keyof FlatRecord)[] } {
  if (!b) return { changed: true, fields: Object.keys(a) as (keyof FlatRecord)[] };
  
  const changed: (keyof FlatRecord)[] = [];
  for (const k of ["first_name", "last_name", "city", "phone", "country", "groups"] as (keyof FlatRecord)[]) {
    const va = (a as any)[k];
    const vb = (b as any)[k];
    const same = Array.isArray(va)
      ? Array.isArray(vb) && stableStringify(va) === stableStringify(vb)
      : va === vb;
    if (!same) changed.push(k);
  }
  return { changed: changed.length > 0, fields: changed };
}

async function ensureCrosswalk(email: string): Promise<{ a_id: string | null; b_id: string | null }> {
  const { data, error } = await supabase
    .from("integration_crosswalk")
    .select("a_id, b_id")
    .eq("email", normalizeEmail(email))
    .maybeSingle();
  
  if (error) {
    console.error("Crosswalk fetch error:", error);
    return { a_id: null, b_id: null };
  }
  
  if (!data) {
    const { error: insErr } = await supabase.from("integration_crosswalk").insert({ email: normalizeEmail(email) });
    if (insErr) console.error("Crosswalk insert error:", insErr);
    return { a_id: null, b_id: null };
  }
  
  return { a_id: data.a_id ?? null, b_id: data.b_id ?? null };
}

async function updateCrosswalkB(email: string, b_id: string, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY-RUN] Would update crosswalk: ${email} -> ${b_id}`);
    return;
  }

  const { error } = await supabase
    .from("integration_crosswalk")
    .upsert({ 
      email: normalizeEmail(email), 
      b_id, 
      updated_at: new Date().toISOString() 
    }, { onConflict: "email" });
  
  if (error) console.error("Crosswalk update error:", error);
}

// ============================================================================
// Data fetchers
// ============================================================================

async function flatFromA(email: string): Promise<FlatRecord | null> {
  const { data, error } = await supabase
    .from("v_clients_for_ml")
    .select("*")
    .eq("email", normalizeEmail(email))
    .maybeSingle();
  
  if (error) {
    console.error("View fetch error:", error);
    return null;
  }
  
  if (!data) return null;
  
  return {
    email: normalizeEmail(data.email),
    first_name: data.first_name ?? "",
    last_name: data.last_name ?? "",
    city: data.city ?? "",
    phone: data.phone ?? "",
    country: data.country ?? "",
    groups: Array.isArray(data.groups) ? data.groups : [],
  };
}

async function flatFromBById(b_id: string, dryRun = false): Promise<FlatRecord | null> {
  if (dryRun) return null;

  try {
    const res = await fetch(`${ML_BASE}/subscribers/${b_id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
    });
    
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`MailerLite get subscriber failed: ${res.status}`);
      return null;
    }
    
    const sub = await res.json();
    const groups = Array.isArray(sub.groups) ? sub.groups.map((g: any) => g.name).sort() : [];

    const phone = sub.phone ?? sub.fields?.phone ?? sub.fields?.Phone ?? "";
    const city = sub.location?.city ?? sub.fields?.city ?? sub.fields?.City ?? "";
    const country = sub.location?.country ?? sub.country ?? sub.fields?.country ?? sub.fields?.Country ?? "";

    return {
      email: normalizeEmail(sub.email ?? ""),
      first_name: sub.fields?.name ?? sub.name ?? sub.fields?.first_name ?? "",
      last_name: sub.fields?.last_name ?? sub.fields?.surname ?? "",
      city: city ?? "",
      phone: phone ?? "",
      country: country ?? "",
      groups
    };
  } catch (e) {
    console.error("MailerLite fetch error:", e);
    return null;
  }
}

// ============================================================================
// Phase 1.2: MailerLite operations with unsubscribed protection
// ============================================================================

async function upsertBNeverBlank(flat: FlatRecord, existing_b_id: string | null, dryRun = false): Promise<string | null> {
  // Phase 1.2: Check if subscriber is unsubscribed/bounced
  if (existing_b_id) {
    const mlStatus = await getMailerLiteStatus(existing_b_id, dryRun);
    if (mlStatus && isProtectedStatus(mlStatus)) {
      console.log(`⚠️ Skipping ML update for ${flat.email} - status: ${mlStatus}`);
      
      // Update Supabase marketing_status instead
      if (!dryRun) {
        await supabase
          .from('clients')
          .update({ marketing_status: mlStatus })
          .eq('email', normalizeEmail(flat.email));
      }
      
      return existing_b_id; // Return existing ID without updating ML
    }
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Would upsert to MailerLite: ${flat.email}`);
    return existing_b_id || 'dry-run-b-id';
  }

  const base = pickNonEmpty(flat, ["first_name", "last_name", "city", "phone", "country"]);
  const asMl: Record<string, string> = {
    ...(base.first_name ? { name: base.first_name } : {}),
    ...(base.last_name ? { last_name: base.last_name } : {}),
    ...(base.city ? { city: base.city } : {}),
    ...(base.phone ? { phone: base.phone } : {}),
    ...(base.country ? { country: base.country } : {}),
  };

  try {
    if (existing_b_id) {
      // Fetch current B to build complete merged fields
      const currentB = await flatFromBById(existing_b_id);
      const merged: Record<string, string> = {
        name: isNonEmpty(flat.first_name) ? flat.first_name : (currentB?.first_name ?? ""),
        last_name: isNonEmpty(flat.last_name) ? flat.last_name : (currentB?.last_name ?? ""),
        city: isNonEmpty(flat.city) ? flat.city : (currentB?.city ?? ""),
        phone: isNonEmpty(flat.phone) ? flat.phone : (currentB?.phone ?? ""),
        country: isNonEmpty(flat.country) ? flat.country : (currentB?.country ?? "")
      };

      // Try PATCH first with non-empty fields
      let res = await retryFetch(`${ML_BASE}/subscribers/${existing_b_id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: flat.email, fields: asMl })
      });

      // Fallback to PUT with complete merged fields on 405/404
      if (res.status === 405 || res.status === 404) {
        res = await retryFetch(`${ML_BASE}/subscribers/${existing_b_id}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: flat.email, fields: merged })
        });
      }

      if (!res.ok) {
        console.error(`MailerLite upsert failed: ${res.status}`);
        return null;
      }
      return existing_b_id;
    } else {
      // Create with non-empty fields only
      const res = await retryFetch(`${ML_BASE}/subscribers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ email: flat.email, fields: asMl })
      });

      if (!res.ok) {
        console.error(`MailerLite create failed: ${res.status}`);
        return null;
      }

      const created = await res.json();
      return created.data?.id ?? created.id ?? null;
    }
  } catch (e) {
    console.error("MailerLite upsert error:", e);
    return null;
  }
}

/**
 * Phase 2.2: Set groups exactly, but only remove managed groups
 */
async function setGroupsBExact(b_id: string, desiredNames: string[], dryRun = false) {
  if (dryRun) {
    console.log(`[DRY-RUN] Would sync groups for subscriber ${b_id}: ${desiredNames.join(', ')}`);
    return;
  }

  try {
    const managedGroups = await getManagedGroups();

    // Fetch all groups
    const listRes = await retryFetch(`${ML_BASE}/groups`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
    });
    if (!listRes.ok) throw new Error(`groups list failed: ${listRes.status}`);
    const list = (await listRes.json()).data ?? [];
    const nameToId = new Map<string, string>(list.map((g: any) => [g.name, g.id]));

    // Fetch current subscriber groups
    const subRes = await retryFetch(`${ML_BASE}/subscribers/${b_id}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
    });
    const sub = await subRes.json();
    const curIds = new Set<string>((sub.groups ?? []).map((g: any) => g.id));
    const desiredIds = new Set<string>(desiredNames.map(n => nameToId.get(n)).filter(Boolean) as string[]);

    // Add missing groups
    for (const gid of desiredIds) {
      if (!curIds.has(gid)) {
        await retryFetch(`${ML_BASE}/groups/${gid}/subscribers/${b_id}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
        });
      }
    }

    // Phase 2.2: Remove extra groups ONLY if they're in managed list
    for (const gid of curIds) {
      if (!desiredIds.has(gid) && managedGroups.has(gid)) {
        console.log(`  Removing managed group ${gid} from subscriber ${b_id}`);
        await retryFetch(`${ML_BASE}/groups/${gid}/subscribers/${b_id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
        });
      } else if (!desiredIds.has(gid)) {
        console.log(`  ⚠️ Keeping unmanaged group ${gid} for subscriber ${b_id}`);
      }
    }
  } catch (e) {
    console.error("setGroupsBExact error:", e);
  }
}

// ============================================================================
// Sync processors
// ============================================================================

async function processAtoB(email: string, dryRun = false): Promise<any> {
  email = normalizeEmail(email);
  const flatA = await flatFromA(email);
  if (!flatA) return { email, skipped: true, reason: "not-in-A" };

  const shadow = await getShadow(email);
  const { changed } = diff(flatA, shadow);

  const { b_id } = await ensureCrosswalk(email);

  // True noop: skip if nothing changed and b_id exists
  if (!changed && b_id) {
    // Verify that the referenced B subscriber actually exists; crosswalk can be stale
    const existsB = await flatFromBById(b_id, dryRun);
    if (!existsB) {
      // Treat as missing in B: recreate and relink b_id
      const new_bid = await upsertBNeverBlank(flatA, null, dryRun);
      if (new_bid) {
        if (!dryRun) await updateCrosswalkB(email, new_bid, false);
        return { email, b_id: new_bid, changed: true, reason: 'recreated-in-B' };
      }
      return { email, skipped: true, reason: 'missing-in-B' };
    }
    return { email, b_id, changed: false };
  }

  let mergedForB = flatA;
  if (b_id) {
    const currentB = await flatFromBById(b_id, dryRun);
    mergedForB = {
      ...currentB,
      email: flatA.email,
      first_name: isNonEmpty(flatA.first_name) ? flatA.first_name : (currentB?.first_name ?? ""),
      last_name: isNonEmpty(flatA.last_name) ? flatA.last_name : (currentB?.last_name ?? ""),
      city: isNonEmpty(flatA.city) ? flatA.city : (currentB?.city ?? ""),
      phone: isNonEmpty(flatA.phone) ? flatA.phone : (currentB?.phone ?? ""),
      country: isNonEmpty(flatA.country) ? flatA.country : (currentB?.country ?? ""),
      groups: flatA.groups
    };
  } else {
    mergedForB = {
      ...flatA,
      first_name: flatA.first_name?.trim() || "",
      last_name: flatA.last_name?.trim() || "",
      city: flatA.city?.trim() || "",
      phone: flatA.phone?.trim() || "",
      country: flatA.country?.trim() || "",
    };
  }

  // Phase 1.1: Deterministic dedupe key
  const dedupeKey = await generateDedupeKey(email, 'AtoB', mergedForB);
  
  // Idempotency check
  if (await alreadyDone(dedupeKey)) {
    return { email, b_id, changed: false };
  }

  const new_bid = await upsertBNeverBlank(mergedForB, b_id, dryRun);
  if (!new_bid) {
    await insertLog({
      email,
      direction: "A→B",
      action: "error",
      result: "mailerlite-upsert-failed",
      dedupe_key: dedupeKey,
      error_type: 'ml_api_error'
    });
    return { email, error: "mailerlite-upsert-failed" };
  }

  if (!b_id || new_bid !== b_id) await updateCrosswalkB(email, new_bid, dryRun);

  // Groups exact sync (only if changed)
  const bNow = await flatFromBById(new_bid, dryRun);
  const groupsChanged = JSON.stringify((bNow?.groups ?? []).sort()) !== JSON.stringify((flatA.groups ?? []).sort());
  if (groupsChanged) await setGroupsBExact(new_bid, flatA.groups, dryRun);

  // Phase 2.3: Shadow update ONLY after successful ML update
  await putShadow(email, { ...mergedForB, groups: flatA.groups }, dryRun);

  if (!dryRun) {
    const oldVal = b_id && bNow ? pickNonEmpty(bNow, ["first_name", "last_name", "city", "phone", "country"] as (keyof FlatRecord)[]) : {};
    const newVal = pickNonEmpty(mergedForB, ["first_name", "last_name", "city", "phone", "country"] as (keyof FlatRecord)[]);
    
    await insertLog({
      email,
      direction: "A→B",
      action: b_id ? "update" : "create",
      result: "ok",
      field: b_id ? "merged-nonblank" : "create-nonblank",
      old_value: b_id ? jsonCompact(oldVal) : null,
      new_value: jsonCompact(newVal),
      dedupe_key: dedupeKey
    });
  }

  return { email, b_id: new_bid, changed: true };
}

async function processBtoA(email: string, repair = false, dryRun = false): Promise<any> {
  email = normalizeEmail(email);
  const { b_id } = await ensureCrosswalk(email);
  if (!b_id) return { email, skipped: true, reason: "no-b-id" };

  const flatB = await flatFromBById(b_id, dryRun);
  if (!flatB) return { email, skipped: true, reason: "missing-in-B" };

  const { data: aRow, error: aErr } = await supabase
    .from("clients")
    .select("first_name,last_name,city,phone,country")
    .eq("email", email)
    .maybeSingle();
  
  if (aErr) throw aErr;
  if (!aRow) return { email, skipped: true, reason: "missing-in-A" };
  
  const flatA = await flatFromA(email);
  const shadow = await getShadow(email);

  // Conflict detection: both-changed per field (skip unless repair)
  const conflictFields: string[] = [];
  const fields: (keyof FlatRecord)[] = ["first_name", "last_name", "city", "phone", "country"];
  
  for (const f of fields) {
    const s = (shadow as any)?.[f] ?? "";
    const a = (aRow as any)[f] ?? "";
    const b = (flatB as any)[f] ?? "";
    const aChanged = isNonEmpty(a) && a !== s;
    const bChanged = isNonEmpty(b) && b !== s;
    if (!repair && aChanged && bChanged && a !== b) {
      conflictFields.push(String(f));
    }
  }

  // Log conflicts
  if (conflictFields.length > 0 && !dryRun) {
    await supabase.from("sync_conflicts").insert(
      conflictFields.map(field => ({
        email,
        field,
        a_value: (aRow as any)[field] ?? "",
        b_value: (flatB as any)[field] ?? "",
        status: "pending"
      }))
    );
  }

  // Build candidate updates
  const changes: Record<string, { old: any; new: any }> = {};
  const candidate: Partial<Record<keyof FlatRecord, string>> = {};

  if (repair) {
    // Repair: fill only empty A fields with non-empty B
    for (const f of fields) {
      const aVal = (aRow as any)[f] ?? "";
      const bVal = (flatB as any)[f] ?? "";
      if (!isNonEmpty(aVal) && isNonEmpty(bVal)) {
        (candidate as any)[f] = bVal;
        changes[f] = { old: aVal, new: bVal };
      }
    }
  } else {
    // Normal: take B→A only if B non-empty and differs from shadow (skip conflicts)
    const { fields: changedFields } = diff(flatB, shadow);
    for (const f of changedFields) {
      if (!conflictFields.includes(String(f))) {
        const bVal = (flatB as any)[f];
        const aCur = (aRow as any)[f] ?? "";
        if (isNonEmpty(bVal) && aCur !== bVal) {
          (candidate as any)[f] = bVal;
          changes[f] = { old: aCur, new: bVal };
        }
      }
    }
  }

  if (Object.keys(candidate).length > 0) {
    const key = await generateDedupeKey(email, 'BtoA', candidate);
    
    // Idempotency check
    if (!(await alreadyDone(key))) {
      if (!dryRun) {
        const { error } = await supabase.from("clients").update(candidate).eq("email", email);
        if (error) throw error;

        await insertLog({
          email,
          direction: "B→A",
          action: repair ? "repair-update" : "update",
          result: "ok",
          field: Object.keys(candidate).join(","),
          old_value: jsonCompact(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, (v as any).old]))),
          new_value: jsonCompact(Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, (v as any).new]))),
          dedupe_key: key
        });
      }
    }
  } else {
    if (!dryRun) {
      await insertLog({
        email,
        direction: "B→A",
        action: repair ? "repair-noop" : "noop",
        result: "ok",
        dedupe_key: await generateDedupeKey(email, 'BtoA-noop', {})
      });
    }
  }

  // Phase 2.3: Shadow rebuild only after successful update
  const aAfter = await flatFromA(email);
  const newShadow: FlatRecord = {
    ...(aAfter ?? { email, first_name: "", last_name: "", city: "", phone: "", country: "", groups: [] }),
    groups: flatB.groups
  };
  await putShadow(email, newShadow, dryRun);

  return { email, changed: Object.keys(candidate).length > 0, repair };
}

// ============================================================================
// Batch State Management
// ============================================================================

async function getFullState() {
  const { data } = await supabase
    .from('sync_state')
    .select('value')
    .eq('key', 'full_sync_state')
    .maybeSingle();
  return data?.value ?? { phase: 'init', idx: 0 };
}

async function putFullState(value: any) {
  await supabase
    .from('sync_state')
    .upsert(
      { key: 'full_sync_state', value, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
}

// ============================================================================
// Phase 3.1 & 3.2: Full Sync with dry-run and enhanced logging
// ============================================================================

async function runFullSync(dryRun = false): Promise<any> {
  console.log(`🔄 Starting FULL bidirectional sync${dryRun ? ' (DRY-RUN)' : ''}...`);

  // Create sync run record
  const runId = dryRun ? null : (await supabase
    .from('sync_runs')
    .insert({
      mode: 'full',
      dry_run: dryRun,
      status: 'running'
    })
    .select('id')
    .single()).data?.id;

  const startTime = Date.now();
  
  try {
  // 1. Fetch all from both systems
    // For runFullSync, always do full sync (no incremental)
    const [mlSubscribers, sbClients] = await Promise.all([
      getAllMailerLiteSubscribers(dryRun, undefined),
      getAllSupabaseClients(dryRun),
    ]);

    const mlEmails = new Set(mlSubscribers.keys());
    const sbEmails = new Set(sbClients.keys());

    // 2. Calculate sets
    const onlyInML: string[] = [];
    const onlyInSB: string[] = [];
    const inBoth: string[] = [];

    for (const email of mlEmails) {
      if (sbEmails.has(email)) {
        inBoth.push(email);
      } else {
        onlyInML.push(email);
      }
    }

    for (const email of sbEmails) {
      if (!mlEmails.has(email)) {
        onlyInSB.push(email);
      }
    }

    console.log(`\n📊 Sync Overview:`);
    console.log(`  - Only in MailerLite: ${onlyInML.length}`);
    console.log(`  - Only in Supabase: ${onlyInSB.length}`);
    console.log(`  - In Both: ${inBoth.length}\n`);

    const results = {
      onlyInML: [] as any[],
      onlyInSB: [] as any[],
      inBoth: [] as any[],
      stats: {
        mlTotal: mlSubscribers.size,
        sbTotal: sbClients.size,
        onlyML: onlyInML.length,
        onlySB: onlyInSB.length,
        both: inBoth.length,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        conflicts: 0
      }
    };

    // 3. Process: Only in MailerLite → Create in Supabase
    console.log(`\n🔵 Processing ${onlyInML.length} contacts only in MailerLite...`);
    for (const email of onlyInML) {
      try {
        const mlSub = mlSubscribers.get(email)!;
        const clientId = await createClientFromMailerLite(mlSub, dryRun);
        results.onlyInML.push({ 
          email, 
          status: clientId ? 'created' : 'failed',
          clientId 
        });
        if (clientId) results.stats.created++;
        else results.stats.errors++;
      } catch (err: any) {
        console.error(`❌ Error creating client for ${email}:`, err.message);
        results.onlyInML.push({ email, status: 'error', error: err.message });
        results.stats.errors++;
      }
    }

    // 4. Process: Only in Supabase → Create in MailerLite
    console.log(`\n🟢 Processing ${onlyInSB.length} contacts only in Supabase...`);
    for (const email of onlyInSB) {
      try {
        const outcome = await processAtoB(email, dryRun);
        results.onlyInSB.push({ email, status: 'synced', ...outcome });
        if (outcome.changed) results.stats.created++;
        else if (outcome.skipped) results.stats.skipped++;
      } catch (err: any) {
        console.error(`❌ Error syncing ${email} to MailerLite:`, err.message);
        results.onlyInSB.push({ email, status: 'error', error: err.message });
        results.stats.errors++;
      }
    }

    // 5. Process: In Both → Bidirectional sync
    console.log(`\n🟡 Processing ${inBoth.length} contacts in both systems...`);
    for (const email of inBoth) {
      try {
        const [aResult, bResult] = await Promise.all([
          processAtoB(email, dryRun),
          processBtoA(email, false, dryRun),
        ]);
        results.inBoth.push({ 
          email, 
          status: 'synced', 
          AtoB: aResult, 
          BtoA: bResult 
        });
        if (aResult.changed || bResult.changed) results.stats.updated++;
        else results.stats.skipped++;
      } catch (err: any) {
        console.error(`❌ Error syncing ${email}:`, err.message);
        results.inBoth.push({ email, status: 'error', error: err.message });
        results.stats.errors++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(`\n✅ Full sync completed in ${(duration / 1000).toFixed(2)}s`);

    // Update sync run record
    if (!dryRun && runId) {
      await supabase.from('sync_runs').update({
        completed_at: new Date().toISOString(),
        status: results.stats.errors > 0 ? 'partial' : 'completed',
        emails_processed: mlEmails.size + sbEmails.size,
        records_created: results.stats.created,
        records_updated: results.stats.updated,
        records_skipped: results.stats.skipped,
        errors_count: results.stats.errors,
        conflicts_detected: results.stats.conflicts,
        summary: results.stats
      }).eq('id', runId);
    }

    return results;
  } catch (err: any) {
    if (!dryRun && runId) {
      await supabase.from('sync_runs').update({
        completed_at: new Date().toISOString(),
        status: 'failed',
        error_details: { message: err.message, stack: err.stack }
      }).eq('id', runId);
    }
    throw err;
  }
}

// ============================================================================
// Batch Full Sync - Stateful, resumes from where it stopped
// ============================================================================

async function runFullSyncBatch(opts: {
  maxItems: number;
  timeBudgetMs: number;
  minRemaining: number;
  dryRun: boolean;
}): Promise<any> {
  const t0 = Date.now();
  
  // Pre-flight health check
  const healthCheck = await checkDatabaseHealth();
  if (!healthCheck.healthy) {
    console.error('❌ Database unhealthy during batch sync:', healthCheck.message);
    throw new Error(`Database health check failed: ${healthCheck.message}`);
  }
  
  // Get adaptive batch multiplier based on DB health
  const batchMultiplier = getAdaptiveBatchMultiplier(healthCheck.healthy);
  
  // Adaptive batch sizing for safety (reduce resource usage)
  const adaptiveMaxItems = Math.max(5, Math.floor(Math.min(opts.maxItems, 200) * batchMultiplier));
  const adaptiveTimeBudget = Math.min(opts.timeBudgetMs, 45000); // Cap at 45s
  
  const tokensAvailable = mlRateLimiter.getAvailable();
  const utilization = mlRateLimiter.getUtilization();
  
  console.log(`🔧 Adaptive limits: maxItems=${adaptiveMaxItems}/${opts.maxItems} (multiplier: ${batchMultiplier.toFixed(2)}), timeBudget=${adaptiveTimeBudget}ms`);
  console.log(`🪣 Rate limit status: ${Math.floor(tokensAvailable)}/${MAILERLITE_RATE_LIMIT} tokens available (${utilization.toFixed(1)}% utilized)`);
  
  let st = await getFullState();

  console.log(`🔄 Batch sync: phase=${st.phase}, idx=${st.idx}, max=${adaptiveMaxItems}, budget=${adaptiveTimeBudget}ms`);

  // Check if we should wait due to rate limit
  if (st.next_run_at && new Date(st.next_run_at) > new Date()) {
    const waitMs = new Date(st.next_run_at).getTime() - Date.now();
    console.log(`⏸️ Rate limit pause active, next run at ${st.next_run_at} (${Math.ceil(waitMs / 1000)}s remaining)`);
    return { ok: true, paused: 'rate-limit', next_run_at: st.next_run_at };
  }

  // Phase: init - build email sets once
  if (st.phase === 'init') {
    console.log('📊 Initializing: fetching all subscribers and clients...');
    
    // Check if incremental sync is possible
    const lastSyncData = await getLastSyncTimestamp();
    const incrementalFrom = shouldUseIncrementalSync(lastSyncData) && lastSyncData.timestamp ? lastSyncData.timestamp : undefined;
    
    const [mlMap, sbMap] = await Promise.all([
      getAllMailerLiteSubscribers(opts.dryRun, incrementalFrom),
      getAllSupabaseClients(opts.dryRun),
    ]);

    const mlEmails = new Set(mlMap.keys());
    const sbEmails = new Set(sbMap.keys());

    const onlyInML: string[] = [];
    const onlyInSB: string[] = [];
    const inBoth: string[] = [];

    for (const e of mlEmails) {
      if (sbEmails.has(e)) inBoth.push(e);
      else onlyInML.push(e);
    }
    for (const e of sbEmails) {
      if (!mlEmails.has(e)) onlyInSB.push(e);
    }

    // Cache the subscriber map for onlyInML phase
    const mlCache: Record<string, any> = {};
    for (const [email, sub] of mlMap.entries()) {
      mlCache[email] = sub;
    }

    st = {
      phase: 'onlyInML',
      idx: 0,
      onlyInML,
      onlyInSB,
      inBoth,
      mlCache,
      stats: { created: 0, updated: 0, skipped: 0, errors: 0 }
    };
    await putFullState(st);
    console.log(`✅ Init complete: ML-only=${onlyInML.length}, SB-only=${onlyInSB.length}, Both=${inBoth.length}`);
  }

  // Process phases
  const phases: Array<'onlyInML' | 'onlyInSB' | 'inBoth'> = ['onlyInML', 'onlyInSB', 'inBoth'];
  
  for (const phase of phases) {
    if (st.phase !== phase) continue;

    const list: string[] = st[phase] ?? [];
    let processed = 0;
    
    // Calculate optimal batch size for this phase based on operation type
    const operationType = phase === 'onlyInSB' ? 'AtoB' : 'BtoA';
    const optimalBatchSize = calculateOptimalBatchSize(operationType);
    const finalBatchSize = Math.min(adaptiveMaxItems, optimalBatchSize);
    
    console.log(`\n🟢 Processing phase: ${phase} (${list.length - st.idx} remaining)`);
    console.log(`📊 Rate limit budget: ${Math.floor(mlRateLimiter.getAvailable())} tokens, processing up to ${finalBatchSize} items`);

    for (let i = st.idx; i < list.length; i++) {
      const email = list[i];

      // Stop condition 1: Proactive rate limit pause (BEFORE hitting limit)
      const tokensLeft = mlRateLimiter.getAvailable();
      if (tokensLeft < 10) {
        // Proactively pause before hitting rate limit
        const nextRunMs = 60000; // Resume in 1 minute when tokens refill
        st.idx = i;
        st.next_run_at = new Date(Date.now() + nextRunMs).toISOString();
        await putFullState(st);
        console.log(`⏸️ Rate limit budget low (${Math.floor(tokensLeft)} tokens), pausing until ${st.next_run_at}`);
        return { 
          ok: true, 
          paused: 'rate-limit-proactive', 
          phase, 
          idx: i, 
          next_run_at: st.next_run_at,
          tokensRemaining: Math.floor(tokensLeft),
          processed
        };
      }

      // Stop condition 2: Daily quota check (every 10 records to avoid too many DB queries)
      if (processed > 0 && processed % 10 === 0) {
        const quota = await checkDailyQuota();
        if (!quota.allowed || quota.remaining < 100) {
          st.idx = i;
          await putFullState(st);
          console.log(`⏸️ Daily quota exhausted: ${quota.processed}/${MAX_DAILY_SYNC_RECORDS} - pausing sync`);
          return { 
            ok: true, 
            paused: 'quota-exhausted', 
            phase, 
            idx: i, 
            quota,
            message: 'Daily sync quota reached. Will resume automatically tomorrow.'
          };
        }
      }

      // Stop condition 3: Batch limits (time/items/rate budget)
      const elapsed = Date.now() - t0;
      if (processed >= finalBatchSize || elapsed > adaptiveTimeBudget) {
        st.idx = i;
        await putFullState(st);
        console.log(`⏸️ Batch limit reached: processed=${processed}/${finalBatchSize}, elapsed=${elapsed}ms, tokens left: ${Math.floor(mlRateLimiter.getAvailable())}`);
        return { ok: true, paused: 'batch-limit', phase, idx: i, processed };
      }

      // Process email based on phase
      try {
        if (phase === 'onlyInML') {
          const mlSub = st.mlCache?.[email];
          if (mlSub) {
            await createClientFromMailerLite(mlSub, opts.dryRun);
            st.stats.created++;
          }
        } else if (phase === 'onlyInSB') {
          const result = await processAtoB(email, opts.dryRun);
          if (result.changed) st.stats.updated++;
          else st.stats.skipped++;
        } else {
          // inBoth: bidirectional
          const [aResult, bResult] = await Promise.all([
            processAtoB(email, opts.dryRun),
            processBtoA(email, false, opts.dryRun),
          ]);
          if (aResult.changed || bResult.changed) st.stats.updated++;
          else st.stats.skipped++;
        }
      } catch (e: any) {
        console.error(`❌ Error ${phase} ${email}:`, e.message);
        st.stats.errors++;
      }

      processed++;
      
      // Log rate limit status every 10 records
      if (processed % 10 === 0) {
        const currentTokens = mlRateLimiter.getAvailable();
        const currentUtil = mlRateLimiter.getUtilization();
        console.log(`  📊 Progress: ${processed} items | Tokens: ${Math.floor(currentTokens)}/${MAILERLITE_RATE_LIMIT} (${currentUtil.toFixed(1)}% used)`);
      }
    }

    // Phase completed - move to next
    console.log(`✅ Phase ${phase} complete`);
    st.phase = phase === 'onlyInML' ? 'onlyInSB' : phase === 'onlyInSB' ? 'inBoth' : 'done';
    st.idx = 0;
    await putFullState(st);
  }

  // All done - update last sync timestamp
  await updateLastSyncTimestamp();
  
  // Calculate and save sync percentage
  await calculateAndSaveSyncPercentage();
  
  // Save persistent statistics
  await saveSyncStatistics(st.stats);
  
  console.log(`\n✅ Batch sync complete: ${JSON.stringify(st.stats)}`);
  return { ok: true, done: true, stats: st.stats };
}

// ============================================================================
// Run orchestrator
// ============================================================================

async function run(mode: SyncMode, emails?: string[], repair = false, dryRun = false, batch = false, batchOpts?: {
  maxItems?: number;
  timeBudgetMs?: number;
  minRemaining?: number;
}): Promise<any> {
  // If mode is 'full' with batch mode, use batch sync
  if (mode === 'full' && batch) {
    return await runFullSyncBatch({
      maxItems: batchOpts?.maxItems ?? 500,
      timeBudgetMs: batchOpts?.timeBudgetMs ?? 45000,
      minRemaining: batchOpts?.minRemaining ?? 60,
      dryRun
    });
  }
  
  // If mode is 'full' without batch, use regular full sync
  if (mode === 'full') {
    return await runFullSync(dryRun);
  }

  let targets = emails && emails.length > 0 ? emails.map(normalizeEmail) : [];
  
  if (targets.length === 0) {
    const { data, error } = await supabase
      .from("clients")
      .select("email")
      .not("email", "is", null)
      .limit(2000);
    
    if (error) {
      console.error("Failed to fetch clients:", error);
      return [];
    }
    
    targets = (data ?? []).map(r => normalizeEmail(r.email)).filter(Boolean);
  }

  const results: any[] = [];
  
  for (const email of targets) {
    try {
      if (mode === "AtoB") {
        results.push(await processAtoB(email, dryRun));
      } else if (mode === "BtoA") {
        results.push(await processBtoA(email, repair, dryRun));
      } else {
        const r1 = await processBtoA(email, repair, dryRun);
        const r2 = await processAtoB(email, dryRun);
        results.push({ email, r1, r2 });
      }
    } catch (e) {
      if (!dryRun) {
        await insertLog({
          email,
          direction: mode === "AtoB" ? "A→B" : "B→A",
          action: "error",
          result: String(e),
          dedupe_key: await generateDedupeKey(email, 'error', {}),
          error_type: 'sync_error'
        });
      }
      results.push({ email, error: String(e) });
    }
    
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  return results;
}

// ============================================================================
// HTTP server
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { 
      mode = "AtoB", 
      emails = [], 
      repair = false,
      dryRun = false, // Phase 3.1: Dry-run mode
      batch = false, // Batch mode for large syncs
      maxItems = 500,
      timeBudgetMs = 45000,
      minRemaining = 60
    } = await req.json().catch(() => ({}));
    
    if (!["AtoB", "BtoA", "bidirectional", "full"].includes(mode)) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid mode (use AtoB, BtoA, bidirectional, or full)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`\n🚀 Smart Sync Request: mode=${mode}, emails=${emails.length || 'all'}, repair=${repair}, dryRun=${dryRun}, batch=${batch}`);
    
    // ─────────────────────────────────────────────────────────────────────────────
    // Restore Rate Limiter State
    // ─────────────────────────────────────────────────────────────────────────────
    
    await mlRateLimiter.restore();
    
    // ─────────────────────────────────────────────────────────────────────────────
    // Resource Protection Checks
    // ─────────────────────────────────────────────────────────────────────────────
    
    console.log('🛡️ Running pre-flight resource checks...');
    
    // 1. Check database health
    const healthCheck = await checkDatabaseHealth();
    if (!healthCheck.healthy) {
      console.error('❌ Database health check failed:', healthCheck.message);
      return new Response(
        JSON.stringify({
          status: 'error',
          message: `Database unhealthy: ${healthCheck.message}. Sync aborted for safety.`,
          timestamp: new Date().toISOString(),
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.log('✅ Database health check passed');
    
    // 2. Check for concurrent syncs
    const concurrencyCheck = await checkConcurrentSyncs();
    if (!concurrencyCheck.canRun) {
      console.warn('⚠️ Concurrent sync check failed:', concurrencyCheck.message);
      return new Response(
        JSON.stringify({
          status: 'skipped',
          message: `${concurrencyCheck.message}. Sync skipped to prevent resource exhaustion.`,
          timestamp: new Date().toISOString(),
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.log('✅ No concurrent syncs detected');
    
    // 3. Check recent error rate (circuit breaker)
    const errorCheck = await checkRecentErrors();
    if (!errorCheck.shouldRun) {
      console.error('🔴 Circuit breaker activated:', errorCheck.message);
      return new Response(
        JSON.stringify({
          status: 'error',
          message: errorCheck.message,
          timestamp: new Date().toISOString(),
        }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.log('✅ Error rate within acceptable limits');
    
    // 4. Check daily quota
    const quota = await checkDailyQuota();
    if (!quota.allowed) {
      console.error(`❌ Daily quota exceeded: ${quota.processed}/${MAX_DAILY_SYNC_RECORDS} records processed in last 24h`);
      return new Response(
        JSON.stringify({
          status: 'quota_exceeded',
          message: `Daily sync quota exceeded: ${quota.processed}/${MAX_DAILY_SYNC_RECORDS} records. Quota resets in ${24 - new Date().getHours()} hours.`,
          quota,
          timestamp: new Date().toISOString(),
        }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.log(`✅ Daily quota OK: ${quota.remaining} records remaining`);
    
    // 5. Cleanup old data before starting
    await cleanupOldLogs();
    await cleanupOldShadows();
    
    console.log('🛡️ All resource checks passed, proceeding with sync\n');
    
    const out = await run(mode as SyncMode, emails, repair, dryRun, batch, { maxItems, timeBudgetMs, minRemaining });
    
    console.log(`\n✅ Completed smart-sync: processed ${Array.isArray(out) ? out.length : 'batch/full sync'} records`);
    
    return new Response(
      JSON.stringify({ 
        ok: true, 
        mode, 
        dryRun,
        batch,
        count: Array.isArray(out) ? out.length : null, 
        out 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Smart-sync error:", e);
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
