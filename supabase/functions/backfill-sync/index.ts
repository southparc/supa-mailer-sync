import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Declare EdgeRuntime for Deno Deploy
declare const EdgeRuntime: {
  waitUntil(promise: Promise<any>): void;
} | undefined;

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ============================================================================
// Rate Limiter - MailerLite allows 120 req/min
// ============================================================================
const MAILERLITE_RATE_LIMIT = 120; // requests per minute
const RATE_WINDOW_MS = 60000; // 1 minute

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
    
    // Refill tokens based on time elapsed
    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + (elapsed * this.tokensPerMs)
    );
    this.lastRefill = now;
    
    // If no tokens available, wait
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.tokensPerMs);
      console.log(`⏳ Rate limit: waiting ${waitMs}ms for token availability...`);
      await new Promise(r => setTimeout(r, waitMs));
      this.tokens = 1;
      this.lastRefill = Date.now();
    }
    
    // Consume one token
    this.tokens -= 1;
  }
  
  getAvailable(): number {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    return Math.min(
      this.maxTokens,
      this.tokens + (elapsed * this.tokensPerMs)
    );
  }
}

const rateLimiter = new TokenBucket(MAILERLITE_RATE_LIMIT, RATE_WINDOW_MS);

// Admin verification helper
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
  // Allow internal self-invocation using service role key
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

  const { data: roleData, error: roleError } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .eq('role', 'admin')
    .maybeSingle();

  if (roleError || !roleData) {
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

interface BackfillResult {
  crosswalkCreated: number
  shadowsCreated: number
  errors: number
  totalClientsProcessed: number
  totalSubscribersProcessed: number
  message: string
}

interface BackfillProgress {
  phase: string
  totalProcessed: number
  crosswalkCreated: number
  shadowsCreated: number
  errors: number
  startedAt: string
  lastUpdatedAt: string
  status: 'running' | 'completed' | 'failed'
  clientOffset: number
  subscriberCursor: string | null
  shadowOffset: number
  continuationCount?: number // Track auto-continuation iterations
}

// Helper to save progress
async function saveProgress(supabase: any, progress: BackfillProgress): Promise<void> {
  await supabase
    .from('sync_state')
    .upsert({
      key: 'backfill_progress',
      value: progress,
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
}

// Process one chunk of the backfill (to avoid CPU timeout)
async function processBackfillChunk(supabase: any, mailerLiteApiKey: string, progress: BackfillProgress): Promise<{ completed: boolean, progress: BackfillProgress }> {
  const RECORDS_PER_CHUNK = 100; // Process 100 records per function call
  
  try {
    // PHASE 1: Build crosswalk from existing clients
    if (progress.phase === 'Phase 1: Building client crosswalk') {
      console.log(`Phase 1: Processing from offset ${progress.clientOffset}`)
      const clientsResult = await buildClientCrosswalkChunk(supabase, mailerLiteApiKey, progress.clientOffset, RECORDS_PER_CHUNK)
      
      progress.crosswalkCreated += clientsResult.crosswalkCreated
      progress.totalProcessed += clientsResult.totalProcessed
      progress.errors += clientsResult.errors
      progress.clientOffset += clientsResult.totalProcessed // Only increment by actual records processed
      progress.lastUpdatedAt = new Date().toISOString()
      
      // Check if phase 1 is complete
      if (clientsResult.hasMore === false) {
        console.log('Phase 1 complete, moving to Phase 2')
        progress.phase = 'Phase 2: Building subscriber crosswalk'
      }
      
      await saveProgress(supabase, progress)
      return { completed: false, progress }
    }

    // PHASE 2: Build crosswalk from MailerLite subscribers
    if (progress.phase === 'Phase 2: Building subscriber crosswalk') {
      console.log(`Phase 2: Processing from cursor ${progress.subscriberCursor || 'start'}`)
      const subscribersResult = await buildSubscriberCrosswalkChunk(supabase, mailerLiteApiKey, progress.subscriberCursor, RECORDS_PER_CHUNK)
      
      progress.crosswalkCreated += subscribersResult.crosswalkCreated
      progress.totalProcessed += subscribersResult.totalProcessed
      progress.errors += subscribersResult.errors
      progress.subscriberCursor = subscribersResult.nextCursor
      progress.lastUpdatedAt = new Date().toISOString()
      
      // Check if phase 2 is complete
      if (subscribersResult.hasMore === false) {
        console.log('Phase 2 complete, moving to Phase 3')
        progress.phase = 'Phase 3: Creating shadow snapshots'
      }
      
      await saveProgress(supabase, progress)
      return { completed: false, progress }
    }

    // PHASE 3: Create shadow snapshots
    if (progress.phase === 'Phase 3: Creating shadow snapshots') {
      console.log(`Phase 3: Processing from offset ${progress.shadowOffset}`)
      const shadowResult = await createInitialShadowsChunk(supabase, mailerLiteApiKey, progress.shadowOffset, RECORDS_PER_CHUNK)
      
      progress.shadowsCreated += shadowResult.shadowsCreated
      progress.errors += shadowResult.errors
      progress.shadowOffset += shadowResult.recordsProcessed // Only increment by actual records processed
      progress.lastUpdatedAt = new Date().toISOString()
      
      // Check if phase 3 is complete
      if (shadowResult.hasMore === false) {
        console.log('Phase 3 complete - backfill finished!')
        progress.phase = 'Completed'
        progress.status = 'completed'
        await saveProgress(supabase, progress)
        return { completed: true, progress }
      }
      
      await saveProgress(supabase, progress)
      return { completed: false, progress }
    }

    // Should not reach here
    throw new Error(`Unknown phase: ${progress.phase}`)
    
  } catch (error) {
    console.error('Chunk processing error:', error)
    progress.errors += 1
    progress.lastUpdatedAt = new Date().toISOString()
    await saveProgress(supabase, progress)
    throw error
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('=== BACKFILL SYNC REQUESTED ===')
    
    // Parse request body for autoContinue flag
    const { autoContinue = false } = await req.json().catch(() => ({}))
    console.log('🔧 Auto-continue mode:', autoContinue)
    
    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Verify admin privileges
    const { userId, error: adminError } = await verifyAdmin(req, supabase);
    if (adminError) {
      console.error('Unauthorized access attempt');
      return adminError;
    }

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'User ID not available' }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 401
        }
      );
    }

    console.log(`Admin user ${userId} initiated backfill sync`);

    // Get MailerLite API key
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY')
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured')
    }

    // Get or initialize progress
    const { data: existingProgress } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'backfill_progress')
      .maybeSingle();

    let progress: BackfillProgress

    if (existingProgress?.value) {
      progress = existingProgress.value as BackfillProgress
      
      // Check for stale runs (no update in >5 minutes)
      const lastUpdateMs = progress.lastUpdatedAt 
        ? (Date.now() - new Date(progress.lastUpdatedAt).getTime()) 
        : Number.MAX_SAFE_INTEGER;
      const isStale = progress.status === 'running' && lastUpdateMs > 5 * 60 * 1000;

      if (isStale) {
        console.warn('Stale backfill detected (no update in 5+ minutes). Restarting...', {
          lastUpdatedAt: progress.lastUpdatedAt,
          minutesAgo: Math.floor(lastUpdateMs / 60000)
        });
        
        // Start fresh from beginning
        progress = {
          phase: 'Phase 1: Building client crosswalk',
          totalProcessed: 0,
          crosswalkCreated: 0,
          shadowsCreated: 0,
          errors: 0,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          status: 'running',
          clientOffset: 0,
          subscriberCursor: null,
          shadowOffset: 0,
          continuationCount: 0
        };
      } else if (progress.status === 'completed') {
        console.log('Previous backfill completed, starting fresh')
        progress = {
          phase: 'Phase 1: Building client crosswalk',
          totalProcessed: 0,
          crosswalkCreated: 0,
          shadowsCreated: 0,
          errors: 0,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          status: 'running',
          clientOffset: 0,
          subscriberCursor: null,
          shadowOffset: 0,
          continuationCount: 0
        }
      } else if (progress.status === 'running') {
        console.log('Resuming existing backfill from:', progress.phase)
      } else {
        console.log('Previous backfill failed, restarting from last checkpoint')
        progress.status = 'running'
        progress.lastUpdatedAt = new Date().toISOString()
      }
    } else {
      console.log('Starting new backfill')
      progress = {
        phase: 'Phase 1: Building client crosswalk',
        totalProcessed: 0,
        crosswalkCreated: 0,
        shadowsCreated: 0,
        errors: 0,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        status: 'running',
        clientOffset: 0,
        subscriberCursor: null,
        shadowOffset: 0,
        continuationCount: 0
      }
    }

    // ========== PREFLIGHT: Fast-forward check ==========
    // Query actual database counts to determine correct phase
    console.log('🔍 Preflight: Checking database state...')
    
    const { count: totalClients } = await supabase
      .from('clients')
      .select('*', { count: 'exact', head: true })
    
    const { count: crosswalkClients } = await supabase
      .from('integration_crosswalk')
      .select('*', { count: 'exact', head: true })
      .not('a_id', 'is', null)
    
    const { count: crosswalkPairs } = await supabase
      .from('integration_crosswalk')
      .select('*', { count: 'exact', head: true })
      .not('a_id', 'is', null)
      .not('b_id', 'is', null)
    
    const { count: existingShadows } = await supabase
      .from('sync_shadow')
      .select('*', { count: 'exact', head: true })

    console.log('📊 Preflight counts:', {
      totalClients,
      crosswalkClients,
      crosswalkPairs,
      existingShadows
    })

    // Decision logic
    if (existingShadows && crosswalkPairs && existingShadows >= crosswalkPairs && crosswalkPairs > 0) {
      // All shadows created - backfill is complete
      console.log('✅ Preflight: All shadows created. Marking as completed.')
      progress.status = 'completed'
      progress.phase = 'Completed'
      progress.shadowsCreated = existingShadows
      progress.crosswalkCreated = crosswalkPairs
      await saveProgress(supabase, progress)
      
      return new Response(
        JSON.stringify({ 
          message: 'Backfill already completed!',
          progress,
          continueBackfill: false
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      )
    } else if (crosswalkClients && totalClients && crosswalkClients >= totalClients) {
      // Phases 1-2 complete, jump to Phase 3
      console.log(`🚀 Preflight: Crosswalk complete (${crosswalkClients}/${totalClients}). Fast-forwarding to Phase 3 from offset ${existingShadows || 0}`)
      progress.phase = 'Phase 3: Creating shadow snapshots'
      progress.status = 'running'
      progress.shadowOffset = existingShadows || 0
      progress.crosswalkCreated = crosswalkClients || 0
      progress.totalProcessed = crosswalkClients || 0
      progress.lastUpdatedAt = new Date().toISOString()
      await saveProgress(supabase, progress)
    } else {
      // Phases 1 or 2 incomplete, proceed as planned
      console.log(`📍 Preflight: Resuming from ${progress.phase}`)
    }

    // Safety check: max continuation limit
    const MAX_CONTINUATIONS = 200
    const currentCount = progress.continuationCount || 0
    
    if (autoContinue && currentCount >= MAX_CONTINUATIONS) {
      console.warn(`⚠️ Max continuation limit reached (${MAX_CONTINUATIONS}). Stopping auto-continue.`)
      return new Response(
        JSON.stringify({ 
          message: `Safety limit reached. Processed ${currentCount} iterations. Click "Start Backfill" to continue manually.`,
          progress,
          continueBackfill: false
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      )
    }

    // Increment continuation count if auto-continuing
    if (autoContinue) {
      progress.continuationCount = currentCount + 1
      console.log(`🔄 Continuation ${progress.continuationCount}/${MAX_CONTINUATIONS}`)
    }

    // Process one chunk
    const result = await processBackfillChunk(supabase, mailerLiteApiKey, progress)
    
    if (result.completed) {
      return new Response(
        JSON.stringify({ 
          message: 'Backfill completed successfully!',
          progress: result.progress
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      )
    } else {
      // Auto-continue in background if enabled
      if (autoContinue && result.progress.status === 'running') {
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
        const projectUrl = Deno.env.get('SUPABASE_URL')
        
        if (EdgeRuntime?.waitUntil && serviceRoleKey && projectUrl) {
          console.log('🔄 Auto-continuing in background...')
          
          EdgeRuntime.waitUntil(
            fetch(`${projectUrl}/functions/v1/backfill-sync`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${serviceRoleKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ autoContinue: true })
            }).catch(err => {
              console.error('❌ Background continuation failed:', err)
            })
          )
          
          return new Response(
            JSON.stringify({ 
              message: `Chunk processed. Auto-continuing in background (${progress.continuationCount}/${MAX_CONTINUATIONS})...`,
              progress: result.progress,
              continueBackfill: true,
              autoContinuing: true
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 200
            }
          )
        }
      }
      
      return new Response(
        JSON.stringify({ 
          message: 'Chunk processed, call again to continue',
          progress: result.progress,
          continueBackfill: true
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      )
    }

  } catch (error) {
    console.error('Backfill initialization error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
});

async function buildClientCrosswalkChunk(supabase: any, apiKey: string, offset: number, limit: number): Promise<{crosswalkCreated: number, totalProcessed: number, errors: number, hasMore: boolean}> {
  let crosswalkCreated = 0
  let totalProcessed = 0
  let errors = 0

  try {
    const { data: clients, error } = await supabase
      .from('clients')
      .select('id, email')
      .range(offset, offset + limit - 1)
      .order('email')

    if (error) throw error
    
    // If no clients returned, phase is complete
    if (!clients || clients.length === 0) {
      console.log(`Phase 1 complete - no more clients at offset ${offset}`)
      return { crosswalkCreated, totalProcessed, errors, hasMore: false }
    }

    console.log(`📦 Processing client batch: ${offset + 1}-${offset + clients.length} (total so far: ${offset + clients.length})`)

    for (const client of clients) {
      try {
        const email = client.email.toLowerCase()
        totalProcessed++

        const { data: existing } = await supabase
          .from('integration_crosswalk')
          .select('id')
          .eq('email', email)
          .maybeSingle()

        if (existing) continue

        await rateLimiter.acquire()
        const subscriber = await findMailerLiteSubscriber(apiKey, email)
        
        const { error: insertError } = await supabase
          .from('integration_crosswalk')
          .insert({
            email,
            a_id: client.id,
            b_id: subscriber?.id || null
          })

        if (insertError) {
          console.error(`Error creating crosswalk for ${email}:`, insertError)
          errors++
        } else {
          crosswalkCreated++
        }
      } catch (error) {
        console.error(`Error processing client ${client.email}:`, error)
        errors++
      }
    }

    return { crosswalkCreated, totalProcessed, errors, hasMore: clients.length === limit }
  } catch (error) {
    console.error('Error in client chunk processing:', error)
    return { crosswalkCreated, totalProcessed, errors: errors + 1, hasMore: false }
  }
}

async function buildSubscriberCrosswalkChunk(supabase: any, apiKey: string, cursor: string | null, limit: number): Promise<{crosswalkCreated: number, totalProcessed: number, errors: number, nextCursor: string | null, hasMore: boolean}> {
  let crosswalkCreated = 0
  let totalProcessed = 0
  let errors = 0

  try {
    await rateLimiter.acquire()
    
    let url = `https://connect.mailerlite.com/api/subscribers?limit=${limit}`
    if (cursor) {
      url += `&cursor=${cursor}`
    }

    console.log(`📦 Fetching subscriber batch`)

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) throw new Error(`MailerLite API error: ${response.status}`)

    const data = await response.json()
    if (!data.data || data.data.length === 0) {
      return { crosswalkCreated, totalProcessed, errors, nextCursor: null, hasMore: false }
    }

    for (const subscriber of data.data) {
      try {
        const email = subscriber.email.toLowerCase()
        totalProcessed++

        const { data: existing } = await supabase
          .from('integration_crosswalk')
          .select('id, a_id')
          .eq('email', email)
          .maybeSingle()

        if (existing?.a_id) continue

        const { data: client } = await supabase
          .from('clients')
          .select('id')
          .eq('email', email)
          .maybeSingle()

        const { error: upsertError } = await supabase
          .from('integration_crosswalk')
          .upsert({
            email,
            a_id: client?.id || null,
            b_id: subscriber.id
          })

        if (upsertError) {
          console.error(`Error upserting crosswalk for ${email}:`, upsertError)
          errors++
        } else {
          crosswalkCreated++
        }
      } catch (error) {
        console.error(`Error processing subscriber ${subscriber.email}:`, error)
        errors++
      }
    }

    const nextCursor = data.meta?.next_cursor || null
    return { crosswalkCreated, totalProcessed, errors, nextCursor, hasMore: !!nextCursor }
  } catch (error) {
    console.error('Error in subscriber chunk processing:', error)
    return { crosswalkCreated, totalProcessed, errors: errors + 1, nextCursor: null, hasMore: false }
  }
}

async function createInitialShadowsChunk(supabase: any, apiKey: string, offset: number, limit: number): Promise<{shadowsCreated: number, errors: number, recordsProcessed: number, hasMore: boolean}> {
  let shadowsCreated = 0
  let errors = 0

  try {
    const { data: crosswalks, error } = await supabase
      .from('integration_crosswalk')
      .select('email, a_id, b_id')
      .not('a_id', 'is', null)
      .not('b_id', 'is', null)
      .range(offset, offset + limit - 1)

    if (error) throw error
    if (!crosswalks || crosswalks.length === 0) {
      return { shadowsCreated, errors, recordsProcessed: 0, hasMore: false }
    }

    console.log(`📦 Creating shadow batch: ${offset + 1}-${offset + crosswalks.length}`)

    for (const crosswalk of crosswalks) {
      try {
        const email = crosswalk.email

        const { data: existingShadow } = await supabase
          .from('sync_shadow')
          .select('id')
          .eq('email', email)
          .maybeSingle()

        if (existingShadow) continue

        const { data: client } = await supabase
          .from('clients')
          .select('first_name, last_name, phone, city, country')
          .eq('id', crosswalk.a_id)
          .maybeSingle()

        await rateLimiter.acquire()
        const subscriber = await getMailerLiteSubscriber(apiKey, crosswalk.b_id)

        if (!client || !subscriber) {
          console.warn(`Missing data for shadow creation: ${email}`)
          continue
        }

        const snapshot = {
          aData: {
            first_name: client.first_name,
            last_name: client.last_name,
            phone: client.phone,
            city: client.city,
            country: client.country,
          },
          bData: {
            first_name: subscriber.fields?.name || '',
            last_name: subscriber.fields?.last_name || '',
            phone: subscriber.fields?.phone || '',
            city: subscriber.fields?.city || '',
            country: subscriber.fields?.country || '',
          }
        }

        const { error: insertError } = await supabase
          .from('sync_shadow')
          .insert({
            email,
            snapshot
          })

        if (insertError) {
          console.error(`Error creating shadow for ${email}:`, insertError)
          errors++
        } else {
          shadowsCreated++
        }
      } catch (error) {
        console.error(`Error processing crosswalk ${crosswalk.email}:`, error)
        errors++
      }
    }

    return { shadowsCreated, errors, recordsProcessed: crosswalks.length, hasMore: crosswalks.length === limit }
  } catch (error) {
    console.error('Error in shadow creation chunk:', error)
    return { shadowsCreated, errors: errors + 1, recordsProcessed: 0, hasMore: false }
  }
}

async function findMailerLiteSubscriber(apiKey: string, email: string): Promise<any | null> {
  try {
    const response = await fetch(`https://connect.mailerlite.com/api/subscribers?filter[email]=${encodeURIComponent(email)}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json()
    return data.data?.[0] || null
  } catch (error) {
    console.error(`Error finding MailerLite subscriber ${email}:`, error)
    return null
  }
}

async function getMailerLiteSubscriber(apiKey: string, subscriberId: string): Promise<any | null> {
  try {
    const response = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriberId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json()
    return data.data || null
  } catch (error) {
    console.error(`Error getting MailerLite subscriber ${subscriberId}:`, error)
    return null
  }
}