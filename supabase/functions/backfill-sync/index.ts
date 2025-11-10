import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Declare EdgeRuntime for background tasks
declare const EdgeRuntime: {
  waitUntil(promise: Promise<any>): void;
} | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Rate limiter for MailerLite API (120 req/min)
class TokenBucket {
  tokens: number;
  lastRefill: number;
  tokensPerMs: number;
  maxTokens: number;
  
  constructor(maxTokens: number, windowMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.tokensPerMs = maxTokens / windowMs;
  }
  
  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    
    this.tokens = Math.min(this.maxTokens, this.tokens + (elapsed * this.tokensPerMs));
    this.lastRefill = now;
    
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.tokensPerMs);
      await new Promise(r => setTimeout(r, waitMs));
      this.tokens = 1;
      this.lastRefill = Date.now();
    }
    
    this.tokens -= 1;
  }
}

const rateLimiter = new TokenBucket(120, 60000);

// Admin verification
async function verifyAdmin(req: Request, supabase: any): Promise<{ userId: string | null, error: Response | null }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return {
      userId: null,
      error: new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    };
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (serviceKey && token === serviceKey) {
    return { userId: 'service_role', error: null };
  }

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  
  if (authError || !user) {
    return {
      userId: null,
      error: new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    };
  }

  const { data: roleData } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle();

  if (!roleData) {
    return {
      userId: null,
      error: new Response(
        JSON.stringify({ error: 'Access denied. Admin privileges required.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    };
  }

  return { userId: user.id, error: null };
}

// Update sync_status with backfill progress
async function updateSyncStatus(
  supabase: any,
  updates: {
    status?: string;
    phase?: string;
    currentBatch?: number;
    totalBatches?: number;
    shadowsCreated?: number;
    errors?: number;
    startedAt?: string;
    completedAt?: string;
    paused?: boolean;
    pauseReason?: string;
  }
): Promise<void> {
  const { data: currentStatus } = await supabase
    .from('sync_state')
    .select('value')
    .eq('key', 'sync_status')
    .maybeSingle();

  const status = currentStatus?.value || {
    backfill: {},
    fullSync: {},
    lastSync: {},
    statistics: {}
  };

  status.backfill = {
    ...status.backfill,
    ...updates,
    lastUpdatedAt: new Date().toISOString()
  };

  await supabase
    .from('sync_state')
    .upsert({
      key: 'sync_status',
      value: status,
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
}

// Fetch MailerLite subscribers in bulk
async function fetchMailerLiteSubscribers(
  apiKey: string,
  emails: string[]
): Promise<Map<string, any>> {
  const subscriberMap = new Map<string, any>();
  
  // Fetch subscribers in batches of 100 (MailerLite limit)
  for (let i = 0; i < emails.length; i += 100) {
    const batch = emails.slice(i, i + 100);
    
    await rateLimiter.acquire();
    
    try {
      const response = await fetch(
        `https://connect.mailerlite.com/api/subscribers?filter[email]=${batch.map(e => encodeURIComponent(e)).join(',')}`,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );

      if (!response.ok) {
        console.error(`❌ MailerLite API error for batch ${i / 100 + 1}: ${response.status}`);
        continue;
      }

      const result = await response.json();
      const subscribers = result.data || [];
      
      for (const subscriber of subscribers) {
        if (subscriber.email) {
          subscriberMap.set(subscriber.email.toLowerCase(), subscriber);
        }
      }

      console.log(`✅ Fetched ${subscribers.length} subscribers from MailerLite (batch ${i / 100 + 1}/${Math.ceil(emails.length / 100)})`);
      
    } catch (error) {
      console.error(`❌ Error fetching MailerLite batch ${i / 100 + 1}:`, error);
    }
  }
  
  return subscriberMap;
}

// Create shadows in bulk
async function createShadowsBulk(
  supabase: any,
  crosswalks: Array<{ email: string; a_id: string; b_id: string }>,
  clientsMap: Map<string, any>,
  subscribersMap: Map<string, any>
): Promise<{ created: number; errors: number }> {
  const shadows = [];
  const errors: string[] = [];

  for (const crosswalk of crosswalks) {
    const email = crosswalk.email.toLowerCase();
    const clientData = clientsMap.get(email);
    const subscriberData = subscribersMap.get(email);

    if (!clientData && !subscriberData) {
      errors.push(`No data found for ${email}`);
      continue;
    }

    // Build snapshot with both client and subscriber data
    const snapshot: any = {
      A: {},
      B: {}
    };

    if (clientData) {
      snapshot.A = {
        email: clientData.email,
        first_name: clientData.first_name,
        last_name: clientData.last_name,
        phone: clientData.phone,
        city: clientData.city,
        country: clientData.country,
        mailerlite_id: clientData.mailerlite_id
      };
    }

    if (subscriberData) {
      snapshot.B = {
        email: subscriberData.email,
        name: `${subscriberData.fields?.name || ''} ${subscriberData.fields?.last_name || ''}`.trim(),
        first_name: subscriberData.fields?.name || '',
        last_name: subscriberData.fields?.last_name || '',
        phone: subscriberData.fields?.phone || '',
        city: subscriberData.fields?.city || '',
        country: subscriberData.fields?.country || '',
        status: subscriberData.status,
        subscribed_at: subscriberData.subscribed_at
      };
    }

    shadows.push({
      email: email,
      snapshot: snapshot,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  // Insert in batches of 50 to avoid query size limits
  let created = 0;
  for (let i = 0; i < shadows.length; i += 50) {
    const batch = shadows.slice(i, i + 50);
    
    try {
      const { error } = await supabase
        .from('sync_shadow')
        .upsert(batch, { onConflict: 'email' });

      if (error) {
        console.error(`❌ Error inserting shadow batch ${i / 50 + 1}:`, error);
        errors.push(`Batch ${i / 50 + 1} failed: ${error.message}`);
      } else {
        created += batch.length;
        console.log(`✅ Inserted ${batch.length} shadows (batch ${i / 50 + 1}/${Math.ceil(shadows.length / 50)})`);
      }
    } catch (error) {
      console.error(`❌ Exception inserting shadow batch ${i / 50 + 1}:`, error);
      errors.push(`Batch ${i / 50 + 1} exception: ${String(error)}`);
    }
  }

  return { created, errors: errors.length };
}

// Main bulk backfill function
async function runBulkBackfill(supabase: any, mailerLiteApiKey: string): Promise<void> {
  const startTime = Date.now();
  
  console.log('🚀 Starting BULK backfill redesign...');
  
  await updateSyncStatus(supabase, {
    status: 'running',
    phase: 'Initializing bulk backfill',
    currentBatch: 0,
    totalBatches: 0,
    shadowsCreated: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
    paused: false
  });

  try {
    // Step 1: Get all crosswalks without shadows
    console.log('📊 Step 1: Fetching crosswalks without shadows...');
    
    const { data: crosswalks, error: crosswalkError } = await supabase
      .from('integration_crosswalk')
      .select('email, a_id, b_id')
      .not('a_id', 'is', null)
      .not('b_id', 'is', null);

    if (crosswalkError) {
      throw new Error(`Failed to fetch crosswalks: ${crosswalkError.message}`);
    }

    if (!crosswalks || crosswalks.length === 0) {
      console.log('✅ No crosswalks found - backfill may be complete or no data to sync');
      await updateSyncStatus(supabase, {
        status: 'completed',
        phase: 'Completed',
        completedAt: new Date().toISOString()
      });
      return;
    }

    console.log(`📊 Found ${crosswalks.length} total crosswalks`);

    // Filter out crosswalks that already have shadows
    const { data: existingShadows } = await supabase
      .from('sync_shadow')
      .select('email');

    const existingShadowEmails = new Set(
      (existingShadows || []).map((s: any) => s.email.toLowerCase())
    );

    const crosswalksWithoutShadows = crosswalks.filter(
      (c: any) => !existingShadowEmails.has(c.email.toLowerCase())
    );

    console.log(`📊 Found ${crosswalksWithoutShadows.length} crosswalks without shadows`);
    console.log(`✅ Already have ${existingShadowEmails.size} existing shadows`);

    if (crosswalksWithoutShadows.length === 0) {
      console.log('✅ All crosswalks already have shadows - backfill complete!');
      await updateSyncStatus(supabase, {
        status: 'completed',
        phase: 'Completed',
        shadowsCreated: existingShadowEmails.size,
        completedAt: new Date().toISOString()
      });
      return;
    }

    const totalBatches = Math.ceil(crosswalksWithoutShadows.length / 500);
    await updateSyncStatus(supabase, {
      phase: 'Bulk processing crosswalks',
      totalBatches,
      currentBatch: 0
    });

    // Process in batches of 500 to manage memory
    let totalCreated = 0;
    let totalErrors = 0;

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const batchStart = batchNum * 500;
      const batchEnd = Math.min(batchStart + 500, crosswalksWithoutShadows.length);
      const batch = crosswalksWithoutShadows.slice(batchStart, batchEnd);

      console.log(`\n🔄 Processing batch ${batchNum + 1}/${totalBatches} (${batch.length} records)`);

      await updateSyncStatus(supabase, {
        currentBatch: batchNum + 1,
        phase: `Processing batch ${batchNum + 1}/${totalBatches}`
      });

      // Step 2: Get all emails in this batch
      const emails: string[] = batch.map((c: any) => c.email);
      const uniqueEmails: string[] = [...new Set(emails.map((e: string) => e.toLowerCase()))];

      // Step 3: Fetch all clients for these emails in ONE query
      console.log(`📥 Step 2: Fetching ${uniqueEmails.length} clients from database...`);
      const { data: clients, error: clientError } = await supabase
        .from('clients')
        .select('email, first_name, last_name, phone, city, country, mailerlite_id')
        .in('email', uniqueEmails);

      if (clientError) {
        console.error('❌ Error fetching clients:', clientError);
        totalErrors += uniqueEmails.length;
        continue;
      }

      const clientsMap: Map<string, any> = new Map(
        (clients || []).map((c: any) => [c.email.toLowerCase(), c])
      );
      console.log(`✅ Fetched ${clientsMap.size} clients`);

      // Step 4: Fetch MailerLite subscribers in bulk
      console.log(`📥 Step 3: Fetching ${uniqueEmails.length} subscribers from MailerLite...`);
      const subscribersMap = await fetchMailerLiteSubscribers(mailerLiteApiKey, uniqueEmails);
      console.log(`✅ Fetched ${subscribersMap.size} subscribers from MailerLite`);

      // Step 5: Create shadows in bulk
      console.log(`💾 Step 4: Creating ${batch.length} shadows in bulk...`);
      const { created, errors } = await createShadowsBulk(
        supabase,
        batch,
        clientsMap,
        subscribersMap
      );

      totalCreated += created;
      totalErrors += errors;

      console.log(`✅ Batch ${batchNum + 1} complete: ${created} created, ${errors} errors`);

      await updateSyncStatus(supabase, {
        shadowsCreated: existingShadowEmails.size + totalCreated,
        errors: totalErrors
      });

      // Small delay between batches to avoid overwhelming the system
      if (batchNum < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n🎉 BULK BACKFILL COMPLETE!`);
    console.log(`📊 Created ${totalCreated} new shadows`);
    console.log(`📊 Total shadows: ${existingShadowEmails.size + totalCreated}`);
    console.log(`⏱️  Duration: ${duration}s`);
    console.log(`❌ Errors: ${totalErrors}`);

    await updateSyncStatus(supabase, {
      status: 'completed',
      phase: 'Completed',
      shadowsCreated: existingShadowEmails.size + totalCreated,
      errors: totalErrors,
      completedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Bulk backfill failed:', error);
    await updateSyncStatus(supabase, {
      status: 'failed',
      phase: 'Failed',
      errors: 1,
      pauseReason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('=== BULK BACKFILL SYNC REQUESTED ===');
    
    const { autoContinue = false } = await req.json().catch(() => ({}));
    console.log('🔧 Auto-continue mode:', autoContinue);
    
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { userId, error: adminError } = await verifyAdmin(req, supabase);
    if (adminError) {
      return adminError;
    }

    console.log(`✅ Admin user ${userId} initiated bulk backfill sync`);

    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY');
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured');
    }

    // Check for pause flag
    const { data: pauseState } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'sync_status')
      .maybeSingle();
    
    if (pauseState?.value?.backfill?.paused === true) {
      console.log('⏸️ Backfill is paused');
      return new Response(
        JSON.stringify({ 
          message: 'Backfill is paused',
          paused: true
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    }

    // Check if already running
    const status = pauseState?.value?.backfill?.status;
    if (status === 'running') {
      const lastUpdated = pauseState?.value?.backfill?.lastUpdatedAt;
      const lastUpdateAge = lastUpdated 
        ? (Date.now() - new Date(lastUpdated).getTime()) / 1000
        : 999999;

      if (lastUpdateAge < 90) {
        console.log('⏳ Backfill is already running (fresh)');
        return new Response(
          JSON.stringify({ 
            message: 'Backfill is already running',
            running: true,
            lastUpdatedAgo: lastUpdateAge
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200
          }
        );
      } else {
        console.log('⚠️ Stale run detected, resuming...');
      }
    }

    // Run the bulk backfill
    if (typeof EdgeRuntime !== 'undefined') {
      // Run in background for immediate response
      EdgeRuntime.waitUntil(runBulkBackfill(supabase, mailerLiteApiKey));
      
      return new Response(
        JSON.stringify({ 
          message: 'Bulk backfill started in background',
          started: true
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    } else {
      // Run synchronously (for testing)
      await runBulkBackfill(supabase, mailerLiteApiKey);
      
      return new Response(
        JSON.stringify({ 
          message: 'Bulk backfill completed',
          completed: true
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      );
    }

  } catch (error) {
    console.error('❌ Edge function error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : String(error)
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    );
  }
});
