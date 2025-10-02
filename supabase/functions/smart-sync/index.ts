// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type FlatRecord = {
  email: string;
  first_name: string;
  last_name: string;
  city: string;
  phone: string;
  country: string;
  groups: string[];
};

type SyncMode = "AtoB" | "BtoA" | "bidirectional";

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

function stableStringify(o: any): string {
  if (Array.isArray(o)) {
    return JSON.stringify([...o].sort());
  }
  return JSON.stringify(o, Object.keys(o).sort());
}

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
    
    return {
      email: sub.email,
      first_name: sub.fields?.name ?? sub.name ?? "",
      last_name: sub.fields?.last_name ?? "",
      city: sub.fields?.city ?? "",
      phone: sub.fields?.phone ?? "",
      country: sub.fields?.country ?? "",
      groups
    };
  } catch (e) {
    console.error("MailerLite fetch error:", e);
    return null;
  }
}

async function upsertB(flat: FlatRecord, existing_b_id: string | null): Promise<string | null> {
  const payload: any = {
    email: flat.email,
    fields: {
      name: flat.first_name,
      last_name: flat.last_name,
      city: flat.city,
      phone: flat.phone,
      country: flat.country
    }
  };
  
  try {
    if (existing_b_id) {
      const res = await fetch(`${ML_BASE}/subscribers/${existing_b_id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) {
        console.error(`MailerLite update failed: ${res.status}`);
        return null;
      }
      return existing_b_id;
    } else {
      const res = await fetch(`${ML_BASE}/subscribers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ML_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
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

async function updateCrosswalkB(email: string, b_id: string) {
  const { error } = await supabase
    .from("integration_crosswalk")
    .upsert({ email, b_id, updated_at: new Date().toISOString() }, { onConflict: "email" });
  
  if (error) console.error("Crosswalk update error:", error);
}

async function processAtoB(email: string): Promise<any> {
  const flatA = await flatFromA(email);
  if (!flatA) return { email, skipped: true, reason: "not-in-A" };

  const shadow = await getShadow(email);
  const { changed, fields } = diff(flatA, shadow);

  const { b_id } = await ensureCrosswalk(email);
  const new_bid = await upsertB(flatA, b_id);
  
  if (!new_bid) {
    await insertLog({
      email,
      direction: "A→B",
      action: "error",
      result: "mailerlite-upsert-failed",
      dedupe_key: crypto.randomUUID()
    });
    return { email, error: "mailerlite-upsert-failed" };
  }
  
  if (!b_id || new_bid !== b_id) await updateCrosswalkB(email, new_bid);

  await putShadow(email, flatA);

  await insertLog({
    email,
    direction: "A→B",
    action: changed ? "update" : "noop",
    result: "ok",
    field: changed ? fields.join(",") : null,
    dedupe_key: crypto.randomUUID()
  });

  return { email, b_id: new_bid, changed };
}

async function processBtoA(email: string): Promise<any> {
  const { b_id } = await ensureCrosswalk(email);
  if (!b_id) return { email, skipped: true, reason: "no-b-id" };

  const flatB = await flatFromBById(b_id);
  if (!flatB) return { email, skipped: true, reason: "missing-in-B" };

  const flatA = await flatFromA(email);
  if (!flatA) {
    await supabase.from("sync_conflicts").insert({
      email,
      field: "record",
      a_value: null,
      b_value: "exists-in-B",
      status: "pending"
    });
    return { email, skipped: true, reason: "missing-in-A" };
  }

  // Update shadow with B groups to prevent unnecessary A→B sync
  if (stableStringify(flatA.groups) !== stableStringify(flatB.groups)) {
    await putShadow(email, { ...flatA, groups: flatB.groups });
    await insertLog({
      email,
      direction: "B→A",
      action: "groups-accept",
      result: "ok",
      dedupe_key: crypto.randomUUID()
    });
  }

  return { email, done: true };
}

async function run(mode: SyncMode, emails?: string[]): Promise<any[]> {
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
        results.push(await processBtoA(email));
      } else {
        const r1 = await processBtoA(email);
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
    
    // Rate limiting: small delay between emails
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  return results;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { mode = "AtoB", emails = [] } = await req.json().catch(() => ({}));
    
    if (!["AtoB", "BtoA", "bidirectional"].includes(mode)) {
      return new Response(
        JSON.stringify({ ok: false, error: "invalid mode" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Starting smart-sync: mode=${mode}, emails=${emails.length || 'all'}`);
    
    const out = await run(mode as SyncMode, emails);
    
    console.log(`Completed smart-sync: processed ${out.length} records`);
    
    return new Response(
      JSON.stringify({ ok: true, mode, count: out.length, out }),
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
