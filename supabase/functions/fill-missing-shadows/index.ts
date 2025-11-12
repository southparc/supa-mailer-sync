import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper: merge and upsert consolidated sync_status.backfill
async function updateSyncStatus(supabase: any, patch: Record<string, any>) {
  const { data } = await supabase
    .from('sync_state')
    .select('value')
    .eq('key', 'sync_status')
    .maybeSingle();

  const existing = (data?.value as any) || { backfill: {}, fullSync: {}, lastSync: {}, statistics: {} };
  const next = {
    ...existing,
    backfill: {
      ...existing.backfill,
      ...patch,
      lastUpdatedAt: new Date().toISOString(),
    },
  };

  await supabase
    .from('sync_state')
    .upsert({ key: 'sync_status', value: next, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

// Create placeholder shadow record payload
function buildPlaceholderShadow(client: any) {
  const { email, first_name, last_name, phone, city, country } = client || {};
  return {
    email,
    snapshot: {
      mode: 'placeholder',
      source: 'gap-fill',
      createdAt: new Date().toISOString(),
      a: {
        email,
        first_name,
        last_name,
        phone,
        city,
        country,
      },
      b: null,
    },
    validation_status: 'incomplete',
    data_quality: { placeholder: true },
    last_validated_at: new Date().toISOString(),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body.batchSize) || 1000, 100), 2000); // 100-2000
    const dryRun = Boolean(body.dryRun);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Missing Supabase env vars' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const startTime = Date.now();
    await updateSyncStatus(supabase, {
      status: 'running',
      phase: 'Stage 2 gap fill: scanning',
      paused: false,
    });

    // Count totals for progress
    const [{ count: clientsCount }, { count: shadowsCount }] = await Promise.all([
      supabase.from('clients').select('id', { count: 'exact', head: true }),
      supabase.from('sync_shadow').select('id', { count: 'exact', head: true }),
    ]);

    const totalClients = clientsCount || 0;
    const totalShadows = shadowsCount || 0;

    // Iterate clients in pages
    const pageSize = 2000;
    let offset = 0;
    let created = 0;
    let errors = 0;

    const run = async () => {
      while (true) {
        const { data: clientsPage, error: clientsErr } = await supabase
          .from('clients')
          .select('email, first_name, last_name, phone, city, country')
          .order('email', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (clientsErr) {
          console.error('Error fetching clients page:', clientsErr);
          errors += 1;
          break;
        }

        if (!clientsPage || clientsPage.length === 0) break;

        // Collect valid emails and fetch existing shadows for these emails
        const emails = clientsPage.map((c: any) => (c.email || '').toLowerCase()).filter(Boolean);
        const uniqueEmails = Array.from(new Set(emails));
        if (uniqueEmails.length === 0) {
          offset += pageSize;
          continue;
        }

        // Fetch shadows for this chunk
        const { data: chunkShadows, error: shadowErr } = await supabase
          .from('sync_shadow')
          .select('email')
          .in('email', uniqueEmails);

        if (shadowErr) {
          console.error('Error fetching existing shadows chunk:', shadowErr);
          errors += 1;
          break;
        }

        const existingSet = new Set((chunkShadows || []).map((s: any) => (s.email || '').toLowerCase()));
        const missingEmails = uniqueEmails.filter((e) => !existingSet.has(e));

        if (missingEmails.length > 0) {
          // Build lookup for client fields
          const clientByEmail = new Map<string, any>();
          for (const c of clientsPage) {
            const e = (c.email || '').toLowerCase();
            if (e) clientByEmail.set(e, c);
          }

          // Insert in sub-batches
          for (let i = 0; i < missingEmails.length; i += batchSize) {
            const slice = missingEmails.slice(i, i + batchSize);
            const rows = slice.map((e) => buildPlaceholderShadow(clientByEmail.get(e)));

            if (dryRun) {
              console.log(`DRY RUN: would insert ${rows.length} placeholders`);
            } else {
              const { error: insertErr } = await supabase.from('sync_shadow').insert(rows);
              if (insertErr) {
                console.error('Insert error:', insertErr);
                errors += 1;
              } else {
                created += rows.length;
              }
            }

            await updateSyncStatus(supabase, {
              phase: 'Stage 2 gap fill: inserting placeholders',
              shadowsCreated: totalShadows + created,
              errors,
            });
          }
        }

        offset += pageSize;

        await updateSyncStatus(supabase, {
          phase: 'Stage 2 gap fill: scanning',
          shadowsCreated: totalShadows + created,
          errors,
        });
      }

      const durationSec = Math.round((Date.now() - startTime) / 1000);
      await updateSyncStatus(supabase, {
        phase: 'Completed',
        status: 'completed',
        completedAt: new Date().toISOString(),
        shadowsCreated: totalShadows + created,
        errors,
        summary: { created, errors, durationSec },
      });

      console.log(`Gap fill completed. Created ${created} placeholders, errors ${errors}`);
    };

    // Run in background so we can return immediately
    // @ts-ignore
    EdgeRuntime.waitUntil(run());

    return new Response(
      JSON.stringify({ status: 'started', startedAt: new Date().toISOString(), dryRun, batchSize }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  } catch (e: any) {
    console.error('Gap fill error', e);
    return new Response(JSON.stringify({ error: e?.message || 'Unexpected error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
});
