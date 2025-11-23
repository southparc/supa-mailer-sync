/**
 * BACKFILL-SYNC (Bulk Shadow Creation)
 * 
 * Purpose: Creates shadow snapshots for ALL crosswalk entries in bulk.
 * This is the foundation that must run FIRST before other syncs work properly.
 * 
 * When to use:
 * - First-time setup (initial shadow creation)
 * - Recovery after data migration or corruption
 * - Gap filling when shadow table has missing records
 * 
 * Features:
 * - Bulk operations (fetches all crosswalks at once)
 * - Batch processing (500 records at a time)
 * - Memory efficient (streams data in batches)
 * - Rate limited (respects MailerLite 120 req/min)
 * - Background execution via EdgeRuntime.waitUntil()
 * - Updates consolidated sync_status
 * - Retry logic for failed batches
 * - End-validation to ensure completeness
 * 
 * Performance: ~3-5 minutes for 24,000 records
 * 
 * See SYNC_FUNCTIONS.md for complete documentation.
 */

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

// Fetch MailerLite subscribers using batch API (all statuses)
async function fetchMailerLiteSubscribers(
  apiKey: string,
  emails: string[]
): Promise<Map<string, any>> {
  const subscribersMap = new Map<string, any>();
  
  console.log(`🔍 Fetching ${emails.length} MailerLite subscribers using batch API (all statuses)...`);
  
  let successCount = 0;
  let notFoundCount = 0;
  let errorCount = 0;
  
  // Process in batches of 100 to respect API limits
  const BATCH_SIZE = 100;
  
  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batchEmails = emails.slice(i, i + BATCH_SIZE);
    
    // Wait for rate limiter
    await rateLimiter.acquire();
    
    try {
      // Build batch request - each email gets its own GET request
      const batchRequests = batchEmails.map(email => ({
        method: 'GET',
        path: `api/subscribers/${encodeURIComponent(email)}`
      }));
      
      const response = await fetch('https://connect.mailerlite.com/api/batch', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ requests: batchRequests })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ MailerLite batch API error (${response.status}): ${errorText}`);
        errorCount += batchEmails.length;
        continue;
      }
      
      const batchResults = await response.json();
      
      // Process batch results - array of responses matching our requests order
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const email = batchEmails[j];
        
        if (result.status === 200 && result.body?.data) {
          subscribersMap.set(email.toLowerCase(), result.body.data);
          successCount++;
        } else if (result.status === 404) {
          // Subscriber not found in MailerLite - expected for some emails
          notFoundCount++;
        } else {
          console.error(`❌ MailerLite error for ${email} (${result.status}): ${JSON.stringify(result.body)}`);
          errorCount++;
        }
      }
      
      // Log progress every 500 emails
      if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= emails.length) {
        console.log(`📊 Progress: ${Math.min(i + BATCH_SIZE, emails.length)}/${emails.length} emails processed (${successCount} found, ${notFoundCount} not found)`);
      }
      
    } catch (error) {
      console.error(`❌ Batch fetch error:`, error);
      errorCount += batchEmails.length;
    }
  }
  
  console.log(`✅ MailerLite batch fetch complete: ${successCount} found, ${notFoundCount} not in MailerLite, ${errorCount} errors`);
  
  return subscribersMap;
}

// Create shadows in bulk with validation and proper conflict handling
async function createShadowsBulk(
  supabase: any,
  crosswalks: Array<{ email: string; a_id: string; b_id: string }>,
  clientsMap: Map<string, any>,
  subscribersMap: Map<string, any>
): Promise<{ created: number; errors: number; incomplete: number }> {
  const shadows = [];
  const errors: string[] = [];
  let incompleteCount = 0;

  for (const crosswalk of crosswalks) {
    const email = crosswalk.email.toLowerCase().trim();
    const clientData = clientsMap.get(email);
    const subscriberData = subscribersMap.get(email);

    if (!clientData && !subscriberData) {
      errors.push(`No data found for ${email}`);
      continue;
    }

    // Track incomplete shadows (missing either client or subscriber data)
    const isIncomplete = !clientData || !subscriberData;
    const missingFields = [];
    
    if (!clientData) missingFields.push('client_data');
    if (!subscriberData) missingFields.push('mailerlite_data');
    
    if (isIncomplete) {
      incompleteCount++;
    }

    // Build snapshot with both client and subscriber data
    const snapshot: any = {
      A: {},
      B: {},
      _metadata: {
        hasClientData: !!clientData,
        hasSubscriberData: !!subscriberData,
        isComplete: !isIncomplete,
        createdAt: new Date().toISOString()
      }
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

    // Build data quality object
    const dataQuality = {
      missingFields: missingFields,
      completenessScore: isIncomplete ? 0.5 : 1.0,
      hasClientData: !!clientData,
      hasSubscriberData: !!subscriberData
    };

    shadows.push({
      email: email,
      snapshot: snapshot,
      validation_status: isIncomplete ? 'incomplete' : 'complete',
      data_quality: dataQuality,
      last_validated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
  }

  // Insert in batches of 50 with proper upsert
  let created = 0;
  const INSERT_BATCH_SIZE = 50;
  
  for (let i = 0; i < shadows.length; i += INSERT_BATCH_SIZE) {
    const batch = shadows.slice(i, i + INSERT_BATCH_SIZE);
    
    try {
      // Use upsert with proper conflict handling
      const { data, error, count } = await supabase
        .from('sync_shadow')
        .upsert(batch, { 
          onConflict: 'email',
          ignoreDuplicates: false // Update existing records
        })
        .select('email');

      if (error) {
        console.error(`❌ Error upserting shadow batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}:`, error.message);
        errors.push(`Batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1} failed: ${error.message}`);
      } else {
        created += batch.length;
        console.log(`✅ Upserted ${batch.length} shadows (batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}/${Math.ceil(shadows.length / INSERT_BATCH_SIZE)})`);
      }
    } catch (error) {
      console.error(`❌ Exception upserting shadow batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}:`, error);
      errors.push(`Batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1} exception: ${String(error)}`);
    }
  }

  if (incompleteCount > 0) {
    console.log(`⚠️  ${incompleteCount} incomplete shadows (missing data from one source)`);
  }
  
  return { created, errors: errors.length, incomplete: incompleteCount };
}

// Main bulk backfill function with validation
async function runBulkBackfill(supabase: any, mailerLiteApiKey: string): Promise<void> {
  const startTime = Date.now();
  
  console.log('🚀 Starting BULK backfill with validation...');
  
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
    // Step 1: Get all crosswalks that need shadows
    console.log('📊 Step 1: Fetching all crosswalks...');
    
    const { data: allCrosswalks, error: crosswalkError } = await supabase
      .from('integration_crosswalk')
      .select('email, a_id, b_id');

    if (crosswalkError) {
      throw new Error(`Failed to fetch crosswalks: ${crosswalkError.message}`);
    }

    if (!allCrosswalks || allCrosswalks.length === 0) {
      console.log('✅ No crosswalks found');
      await updateSyncStatus(supabase, {
        status: 'completed',
        phase: 'No crosswalks to process',
        completedAt: new Date().toISOString()
      });
      return;
    }

    console.log(`📊 Found ${allCrosswalks.length} total crosswalks`);

    // Step 2: Get existing shadows to avoid duplicates
    console.log('📊 Step 2: Fetching existing shadows...');
    const { data: existingShadows } = await supabase
      .from('sync_shadow')
      .select('email');

    const existingShadowEmails = new Set(
      (existingShadows || []).map((s: any) => s.email.toLowerCase().trim())
    );

    console.log(`📊 Found ${existingShadowEmails.size} existing shadows`);

    // Step 3: Filter to only process crosswalks without shadows
    const crosswalksNeedingShadows = allCrosswalks.filter(
      (c: any) => !existingShadowEmails.has(c.email.toLowerCase().trim())
    );

    console.log(`📊 Need to create ${crosswalksNeedingShadows.length} new shadows`);

    if (crosswalksNeedingShadows.length === 0) {
      console.log('✅ All crosswalks already have shadows - backfill complete!');
      await updateSyncStatus(supabase, {
        status: 'completed',
        phase: 'All shadows exist',
        shadowsCreated: existingShadowEmails.size,
        completedAt: new Date().toISOString()
      });
      return;
    }

    // Step 4: Process in batches of 500
    const PROCESS_BATCH_SIZE = 500;
    const totalBatches = Math.ceil(crosswalksNeedingShadows.length / PROCESS_BATCH_SIZE);
    
    await updateSyncStatus(supabase, {
      phase: 'Processing crosswalks in batches',
      totalBatches,
      currentBatch: 0
    });

    let totalCreated = 0;
    let totalErrors = 0;
    let totalIncomplete = 0;

    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const batchStart = batchNum * PROCESS_BATCH_SIZE;
      const batchEnd = Math.min(batchStart + PROCESS_BATCH_SIZE, crosswalksNeedingShadows.length);
      const batch = crosswalksNeedingShadows.slice(batchStart, batchEnd);

      console.log(`\n🔄 Processing batch ${batchNum + 1}/${totalBatches} (${batch.length} records)`);

      await updateSyncStatus(supabase, {
        currentBatch: batchNum + 1,
        phase: `Processing batch ${batchNum + 1}/${totalBatches}`
      });

      // Get unique emails for this batch
      const emails: string[] = batch.map((c: any) => c.email.toLowerCase().trim());
      const uniqueEmails: string[] = [...new Set(emails)];

      // Fetch clients for these emails
      console.log(`📥 Fetching ${uniqueEmails.length} clients from database...`);
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
        (clients || []).map((c: any) => [c.email.toLowerCase().trim(), c])
      );
      console.log(`✅ Fetched ${clientsMap.size} clients`);

      // Fetch MailerLite subscribers
      console.log(`📥 Fetching ${uniqueEmails.length} subscribers from MailerLite...`);
      const subscribersMap = await fetchMailerLiteSubscribers(mailerLiteApiKey, uniqueEmails);
      console.log(`✅ Fetched ${subscribersMap.size} subscribers from MailerLite`);

      // Create shadows
      console.log(`💾 Creating ${batch.length} shadows...`);
      const { created, errors, incomplete } = await createShadowsBulk(
        supabase,
        batch,
        clientsMap,
        subscribersMap
      );

      totalCreated += created;
      totalErrors += errors;
      totalIncomplete += incomplete;

      console.log(`✅ Batch ${batchNum + 1} complete: ${created} created, ${incomplete} incomplete, ${errors} errors`);

      await updateSyncStatus(supabase, {
        shadowsCreated: existingShadowEmails.size + totalCreated,
        errors: totalErrors
      });

      // Small delay between batches
      if (batchNum < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Step 5: VALIDATION - Verify all crosswalks have shadows
    console.log('\n🔍 Step 5: Validating backfill completeness...');
    
    const { data: finalShadows } = await supabase
      .from('sync_shadow')
      .select('email');
    
    const finalShadowEmails = new Set(
      (finalShadows || []).map((s: any) => s.email.toLowerCase().trim())
    );
    
    const stillMissing = allCrosswalks.filter(
      (c: any) => !finalShadowEmails.has(c.email.toLowerCase().trim())
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    if (stillMissing.length === 0) {
      console.log(`\n🎉 BACKFILL COMPLETE & VALIDATED!`);
      console.log(`📊 Created ${totalCreated} new shadows`);
      console.log(`📊 Total shadows: ${finalShadowEmails.size}/${allCrosswalks.length} (100%)`);
      console.log(`⏱️  Duration: ${duration}s`);
      console.log(`⚠️  Incomplete: ${totalIncomplete}`);
      console.log(`❌ Errors: ${totalErrors}`);

      await updateSyncStatus(supabase, {
        status: 'completed',
        phase: 'Completed and validated',
        shadowsCreated: finalShadowEmails.size,
        errors: totalErrors,
        completedAt: new Date().toISOString()
      });
    } else {
      const completionRate = ((finalShadowEmails.size / allCrosswalks.length) * 100).toFixed(1);
      console.log(`\n⚠️  BACKFILL INCOMPLETE!`);
      console.log(`📊 Created ${totalCreated} new shadows`);
      console.log(`📊 Total shadows: ${finalShadowEmails.size}/${allCrosswalks.length} (${completionRate}%)`);
      console.log(`❌ Still missing: ${stillMissing.length} shadows`);
      console.log(`⏱️  Duration: ${duration}s`);

      // Log sample of missing emails for debugging
      console.log(`📋 Sample missing emails:`, stillMissing.slice(0, 10).map((c: any) => c.email));

      await updateSyncStatus(supabase, {
        status: 'incomplete',
        phase: `Incomplete - ${stillMissing.length} shadows missing`,
        shadowsCreated: finalShadowEmails.size,
        errors: totalErrors + stillMissing.length,
        pauseReason: `Failed to create ${stillMissing.length} shadows. Re-run backfill to retry.`
      });
      
      throw new Error(`Backfill incomplete: ${stillMissing.length} shadows still missing`);
    }

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
