// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const supabase = createClient(SB_URL, SB_KEY, { 
  auth: { persistSession: false },
  global: { headers: { 'x-client-info': 'smart-sync' } }
});

// Managed groups that we're allowed to remove (others stay untouched)
let MANAGED_GROUPS_CACHE: Set<string> | null = null;

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
 * Phase 2.1: Retry with exponential backoff + rate limit tracking
 */
async function retryFetch(url: string, init: RequestInit, tries = 4, dryRun = false): Promise<Response> {
  if (dryRun) {
    console.log(`[DRY-RUN] Would fetch: ${init.method || 'GET'} ${url}`);
    return new Response(JSON.stringify({ data: { id: 'dry-run-id' } }), { status: 200 });
  }

  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init);
    
    // Track rate limits
    const rateLimitRemaining = res.headers.get('X-RateLimit-Remaining');
    if (rateLimitRemaining) {
      const remaining = parseInt(rateLimitRemaining, 10);
      if (remaining < 100) {
        console.warn(`⚠️ Rate limit low: ${remaining} requests remaining`);
        // Log to sync_state for monitoring
        await supabase.from('sync_state').upsert({
          key: 'mailerlite_rate_limit',
          value: { remaining, timestamp: new Date().toISOString() },
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
      }
    }
    
    if (res.status !== 429 && res.status < 500) return res;
    
    last = res;
    const backoff = 250 * Math.pow(2, i);
    console.log(`  ⏳ Retry ${i + 1}/${tries} after ${backoff}ms (status: ${res.status})`);
    await new Promise(r => setTimeout(r, backoff));
  }
  return last!;
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
async function getAllMailerLiteSubscribers(dryRun = false): Promise<Map<string, MailerLiteSubscriber>> {
  const result = new Map<string, MailerLiteSubscriber>();
  
  if (dryRun) {
    console.log('[DRY-RUN] Would fetch all MailerLite subscribers');
    return result;
  }

  let cursor: string | null = null;
  let page = 0;

  console.log('📥 Fetching all MailerLite subscribers...');

  do {
    const url = new URL(`${ML_BASE}/subscribers`);
    url.searchParams.set('limit', '1000');
    // Don't filter by status - this returns all subscribers regardless of status
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await retryFetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${ML_KEY}`,
        'Content-Type': 'application/json',
      },
    }, 4, dryRun);

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
    const [mlSubscribers, sbClients] = await Promise.all([
      getAllMailerLiteSubscribers(dryRun),
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
// Run orchestrator
// ============================================================================

async function run(mode: SyncMode, emails?: string[], repair = false, dryRun = false): Promise<any[]> {
  // If mode is 'full', use the new full sync
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
      dryRun = false // Phase 3.1: Dry-run mode
    } = await req.json().catch(() => ({}));
    
    if (!["AtoB", "BtoA", "bidirectional", "full"].includes(mode)) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid mode (use AtoB, BtoA, bidirectional, or full)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`\n🚀 Smart Sync Request: mode=${mode}, emails=${emails.length || 'all'}, repair=${repair}, dryRun=${dryRun}`);
    
    const out = await run(mode as SyncMode, emails, repair, dryRun);
    
    console.log(`\n✅ Completed smart-sync: processed ${Array.isArray(out) ? out.length : 'full sync'} records`);
    
    return new Response(
      JSON.stringify({ 
        ok: true, 
        mode, 
        dryRun,
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
