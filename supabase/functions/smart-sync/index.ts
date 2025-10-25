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
  fields?: {
    name?: string;
    last_name?: string;
    city?: string;
    country?: string;
    phone?: string;
  };
  status: string;
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

// Retry with exponential backoff for 429/5xx
async function retryFetch(url: string, init: RequestInit, tries = 4): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status < 500) return res;
    last = res;
    await new Promise(r => setTimeout(r, 250 * Math.pow(2, i)));
  }
  return last!;
}

// Idempotency check
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

// ============================================================================
// New Functions for Full Sync
// ============================================================================

/**
 * Fetch ALL MailerLite subscribers including unsubscribed
 */
async function getAllMailerLiteSubscribers(): Promise<Map<string, MailerLiteSubscriber>> {
  const result = new Map<string, MailerLiteSubscriber>();
  let cursor: string | null = null;
  let page = 0;

  console.log('📥 Fetching all MailerLite subscribers...');

  do {
    const url = new URL(`${ML_BASE}/subscribers`);
    url.searchParams.set('limit', '1000');
    url.searchParams.set('filter[status]', 'all'); // Include ALL statuses
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await retryFetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${ML_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`❌ MailerLite API error: ${res.status} ${err}`);
      throw new Error(`MailerLite subscribers fetch failed: ${res.status}`);
    }

    const json = await res.json();
    const subscribers = json.data || [];
    
    for (const sub of subscribers) {
      const email = sub.email?.toLowerCase();
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
 * Fetch ALL Supabase clients
 */
async function getAllSupabaseClients(): Promise<Map<string, { id: string; email: string }>> {
  const result = new Map<string, { id: string; email: string }>();
  
  console.log('📥 Fetching all Supabase clients...');
  
  const { data, error } = await supabase
    .from('clients')
    .select('id, email');

  if (error) {
    console.error('❌ Supabase clients fetch error:', error);
    throw error;
  }

  for (const client of data || []) {
    const email = client.email?.toLowerCase();
    if (email) {
      result.set(email, client);
    }
  }

  console.log(`✅ Total Supabase clients: ${result.size}`);
  return result;
}

/**
 * Create a new client in Supabase from MailerLite data
 */
async function createClientFromMailerLite(mlSub: MailerLiteSubscriber): Promise<string | null> {
  const email = mlSub.email.toLowerCase();
  
  console.log(`➕ Creating new client from MailerLite: ${email}`);

  // Extract fields from MailerLite
  const firstName = mlSub.fields?.name || null;
  const lastName = mlSub.fields?.last_name || null;
  const city = mlSub.fields?.city || null;
  const country = mlSub.fields?.country || null;
  const phone = mlSub.fields?.phone || null;

  // Insert into clients table
  const { data, error } = await supabase
    .from('clients')
    .insert({
      email,
      first_name: firstName,
      last_name: lastName,
      city,
      country,
      phone,
    })
    .select('id')
    .single();

  if (error) {
    console.error(`❌ Error creating client ${email}:`, error);
    return null;
  }

  const clientId = data.id;
  console.log(`✅ Created client ${email} with id ${clientId}`);

  // Create or update crosswalk with b_id
  await updateCrosswalkB(email, mlSub.id);

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
}) {
  const { error } = await supabase.from("sync_log").insert(row);
  if (error) console.error("Log insert error:", error);
}

async function getShadow(email: string): Promise<FlatRecord | null> {
  const { data, error } = await supabase
    .from("sync_shadow")
    .select("snapshot")
    .eq("email", email)
    .maybeSingle();
  
  if (error) {
    console.error("Shadow fetch error:", error);
    return null;
  }
  return data?.snapshot as FlatRecord | null;
}

async function putShadow(email: string, snapshot: FlatRecord) {
  const { error } = await supabase
    .from("sync_shadow")
    .upsert({ email, snapshot, updated_at: new Date().toISOString() }, { onConflict: "email" });
  
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
    .eq("email", email)
    .maybeSingle();
  
  if (error) {
    console.error("Crosswalk fetch error:", error);
    return { a_id: null, b_id: null };
  }
  
  if (!data) {
    const { error: insErr } = await supabase.from("integration_crosswalk").insert({ email });
    if (insErr) console.error("Crosswalk insert error:", insErr);
    return { a_id: null, b_id: null };
  }
  
  return { a_id: data.a_id ?? null, b_id: data.b_id ?? null };
}

async function updateCrosswalkB(email: string, b_id: string) {
  const { error } = await supabase
    .from("integration_crosswalk")
    .upsert({ email, b_id, updated_at: new Date().toISOString() }, { onConflict: "email" });
  
  if (error) console.error("Crosswalk update error:", error);
}

// ============================================================================
// Data fetchers
// ============================================================================

async function flatFromA(email: string): Promise<FlatRecord | null> {
  const { data, error } = await supabase
    .from("v_clients_for_ml")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  
  if (error) {
    console.error("View fetch error:", error);
    return null;
  }
  
  if (!data) return null;
  
  return {
    email: data.email,
    first_name: data.first_name ?? "",
    last_name: data.last_name ?? "",
    city: data.city ?? "",
    phone: data.phone ?? "",
    country: data.country ?? "",
    groups: Array.isArray(data.groups) ? data.groups : [],
  };
}

async function flatFromBById(b_id: string): Promise<FlatRecord | null> {
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
      email: sub.email ?? "",
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
// MailerLite operations
// ============================================================================

async function upsertBNeverBlank(flat: FlatRecord, existing_b_id: string | null): Promise<string | null> {
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

async function setGroupsBExact(b_id: string, desiredNames: string[]) {
  try {
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

    // Remove extra groups (A is leading)
    for (const gid of curIds) {
      if (!desiredIds.has(gid)) {
        await retryFetch(`${ML_BASE}/groups/${gid}/subscribers/${b_id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" }
        });
      }
    }
  } catch (e) {
    console.error("setGroupsBExact error:", e);
  }
}

// ============================================================================
// Sync processors
// ============================================================================

async function processAtoB(email: string): Promise<any> {
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
    const currentB = await flatFromBById(b_id);
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

  const dedupeKey = crypto.randomUUID();
  
  // Idempotency check
  if (await alreadyDone(dedupeKey)) {
    return { email, b_id, changed: false };
  }

  const new_bid = await upsertBNeverBlank(mergedForB, b_id);
  if (!new_bid) {
    await insertLog({
      email,
      direction: "A→B",
      action: "error",
      result: "mailerlite-upsert-failed",
      dedupe_key: dedupeKey
    });
    return { email, error: "mailerlite-upsert-failed" };
  }

  if (!b_id || new_bid !== b_id) await updateCrosswalkB(email, new_bid);

  // Groups exact sync (only if changed)
  const bNow = await flatFromBById(new_bid);
  const groupsChanged = JSON.stringify((bNow?.groups ?? []).sort()) !== JSON.stringify((flatA.groups ?? []).sort());
  if (groupsChanged) await setGroupsBExact(new_bid, flatA.groups);

  // Shadow = merged with groups from A
  await putShadow(email, { ...mergedForB, groups: flatA.groups });

  await insertLog({
    email,
    direction: "A→B",
    action: b_id ? "update" : "create",
    result: "ok",
    field: b_id ? "merged-nonblank" : "create-nonblank",
    old_value: b_id ? jsonCompact(pickNonEmpty(bNow ?? {}, ["first_name", "last_name", "city", "phone", "country"])) : null,
    new_value: jsonCompact(pickNonEmpty(mergedForB, ["first_name", "last_name", "city", "phone", "country"])),
    dedupe_key: dedupeKey
  });

  return { email, b_id: new_bid, changed: true };
}

async function processBtoA(email: string, repair = false): Promise<any> {
  const { b_id } = await ensureCrosswalk(email);
  if (!b_id) return { email, skipped: true, reason: "no-b-id" };

  const flatB = await flatFromBById(b_id);
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
  if (conflictFields.length > 0) {
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
    const key = crypto.randomUUID();
    
    // Idempotency check
    if (!(await alreadyDone(key))) {
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
  } else {
    await insertLog({
      email,
      direction: "B→A",
      action: repair ? "repair-noop" : "noop",
      result: "ok",
      dedupe_key: crypto.randomUUID()
    });
  }

  // Shadow rebuild: always from fresh flatFromA + groups from B
  const aAfter = await flatFromA(email);
  const newShadow: FlatRecord = {
    ...(aAfter ?? { email, first_name: "", last_name: "", city: "", phone: "", country: "", groups: [] }),
    groups: flatB.groups
  };
  await putShadow(email, newShadow);

  return { email, changed: Object.keys(candidate).length > 0, repair };
}

// ============================================================================
// Full Sync Orchestration (3-way matching)
// ============================================================================

async function runFullSync(): Promise<any> {
  console.log('🔄 Starting FULL bidirectional sync...');

  // 1. Fetch all from both systems
  const [mlSubscribers, sbClients] = await Promise.all([
    getAllMailerLiteSubscribers(),
    getAllSupabaseClients(),
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
    }
  };

  // 3. Process: Only in MailerLite → Create in Supabase
  console.log(`\n🔵 Processing ${onlyInML.length} contacts only in MailerLite...`);
  for (const email of onlyInML) {
    try {
      const mlSub = mlSubscribers.get(email)!;
      const clientId = await createClientFromMailerLite(mlSub);
      results.onlyInML.push({ 
        email, 
        status: clientId ? 'created' : 'failed',
        clientId 
      });
    } catch (err: any) {
      console.error(`❌ Error creating client for ${email}:`, err.message);
      results.onlyInML.push({ email, status: 'error', error: err.message });
    }
  }

  // 4. Process: Only in Supabase → Create in MailerLite
  console.log(`\n🟢 Processing ${onlyInSB.length} contacts only in Supabase...`);
  for (const email of onlyInSB) {
    try {
      const outcome = await processAtoB(email);
      results.onlyInSB.push({ email, status: 'synced', ...outcome });
    } catch (err: any) {
      console.error(`❌ Error syncing ${email} to MailerLite:`, err.message);
      results.onlyInSB.push({ email, status: 'error', error: err.message });
    }
  }

  // 5. Process: In Both → Bidirectional sync
  console.log(`\n🟡 Processing ${inBoth.length} contacts in both systems...`);
  for (const email of inBoth) {
    try {
      const [aResult, bResult] = await Promise.all([
        processAtoB(email),
        processBtoA(email, false),
      ]);
      results.inBoth.push({ 
        email, 
        status: 'synced', 
        AtoB: aResult, 
        BtoA: bResult 
      });
    } catch (err: any) {
      console.error(`❌ Error syncing ${email}:`, err.message);
      results.inBoth.push({ email, status: 'error', error: err.message });
    }
  }

  console.log('\n✅ Full sync completed!');
  return results;
}

// ============================================================================
// Run orchestrator (Legacy modes)
// ============================================================================

async function run(mode: SyncMode, emails?: string[], repair = false): Promise<any[]> {
  // If mode is 'full', use the new full sync
  if (mode === 'full') {
    return await runFullSync();
  }

  let targets = emails && emails.length > 0 ? emails : [];
  
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
    
    targets = (data ?? []).map(r => r.email).filter(Boolean);
  }

  const results: any[] = [];
  
  for (const email of targets) {
    try {
      if (mode === "AtoB") {
        results.push(await processAtoB(email));
      } else if (mode === "BtoA") {
        results.push(await processBtoA(email, repair));
      } else {
        const r1 = await processBtoA(email, repair);
        const r2 = await processAtoB(email);
        results.push({ email, r1, r2 });
      }
    } catch (e) {
      await insertLog({
        email,
        direction: mode === "AtoB" ? "A→B" : "B→A",
        action: "error",
        result: String(e),
        dedupe_key: crypto.randomUUID()
      });
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
    const { mode = "AtoB", emails = [], repair = false } = await req.json().catch(() => ({}));
    
    if (!["AtoB", "BtoA", "bidirectional", "full"].includes(mode)) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid mode (use AtoB, BtoA, bidirectional, or full)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`\n🚀 Smart Sync Request: mode=${mode}, emails=${emails.length || 'all'}, repair=${repair}`);
    
    const out = await run(mode as SyncMode, emails, repair);
    
    console.log(`\n✅ Completed smart-sync: processed ${Array.isArray(out) ? out.length : 'full sync'} records`);
    
    return new Response(
      JSON.stringify({ ok: true, mode, count: Array.isArray(out) ? out.length : null, out }),
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
