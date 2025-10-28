import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

  const token = authHeader.replace('Bearer ', '');
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

// Main background task
async function runBackfillTask(supabase: any, mailerLiteApiKey: string, userId: string): Promise<void> {
  const progress: BackfillProgress = {
    phase: 'Starting',
    totalProcessed: 0,
    crosswalkCreated: 0,
    shadowsCreated: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    status: 'running'
  };

  try {
    await saveProgress(supabase, progress);

    // PHASE 1: Build crosswalk from existing clients
    console.log('Phase 1: Building crosswalk from Supabase clients...')
    progress.phase = 'Phase 1: Building client crosswalk';
    await saveProgress(supabase, progress);
    
    const clientsResult = await buildClientCrosswalk(supabase, mailerLiteApiKey, progress)
    progress.crosswalkCreated += clientsResult.crosswalkCreated
    progress.totalProcessed += clientsResult.totalProcessed
    progress.errors += clientsResult.errors
    await saveProgress(supabase, progress);

    // PHASE 2: Build crosswalk from MailerLite subscribers
    console.log('Phase 2: Building crosswalk from MailerLite subscribers...')
    progress.phase = 'Phase 2: Building subscriber crosswalk';
    await saveProgress(supabase, progress);
    
    const subscribersResult = await buildSubscriberCrosswalk(supabase, mailerLiteApiKey, progress)
    progress.crosswalkCreated += subscribersResult.crosswalkCreated
    progress.totalProcessed += subscribersResult.totalProcessed
    progress.errors += subscribersResult.errors
    await saveProgress(supabase, progress);

    // PHASE 3: Create shadow snapshots for all mapped records
    console.log('Phase 3: Creating initial shadow snapshots...')
    progress.phase = 'Phase 3: Creating shadow snapshots';
    await saveProgress(supabase, progress);
    
    const shadowResult = await createInitialShadows(supabase, mailerLiteApiKey, progress)
    progress.shadowsCreated = shadowResult.shadowsCreated
    progress.errors += shadowResult.errors

    // Mark as completed
    progress.phase = 'Completed';
    progress.status = 'completed';
    progress.lastUpdatedAt = new Date().toISOString();
    await saveProgress(supabase, progress);

    console.log('=== BACKFILL COMPLETED ===', progress)
  } catch (error) {
    console.error('Backfill task error:', error);
    progress.phase = 'Failed';
    progress.status = 'failed';
    progress.errors += 1;
    progress.lastUpdatedAt = new Date().toISOString();
    await saveProgress(supabase, progress);
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('=== BACKFILL SYNC REQUESTED ===')
    
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

    // Check if backfill is already running
    const { data: existingProgress } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'backfill_progress')
      .maybeSingle();

    if (existingProgress?.value) {
      const progress = existingProgress.value as BackfillProgress;
      if (progress.status === 'running') {
        return new Response(
          JSON.stringify({ 
            error: 'Backfill already running',
            progress 
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 409
          }
        );
      }
    }

    // Start background task (Deno Deploy supports this pattern)
    const taskPromise = runBackfillTask(supabase, mailerLiteApiKey, userId);
    
    // Return immediate response
    return new Response(
      JSON.stringify({ 
        message: 'Backfill started in background',
        estimatedDuration: '20-40 minutes',
        checkProgressAt: '/rest/v1/sync_state?key=eq.backfill_progress'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 202
      }
    )

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

async function buildClientCrosswalk(supabase: any, apiKey: string, progress: BackfillProgress): Promise<{crosswalkCreated: number, totalProcessed: number, errors: number}> {
  let crosswalkCreated = 0
  let totalProcessed = 0
  let errors = 0
  let offset = 0
  const batchSize = 20 // Reduced for rate limiting

  while (true) {
    try {
      // Fetch clients batch
      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, email')
        .range(offset, offset + batchSize - 1)
        .order('email')

      if (error) throw error
      if (!clients || clients.length === 0) break

      console.log(`📦 Processing client batch: ${offset + 1}-${offset + clients.length}, rate limit tokens: ${Math.floor(rateLimiter.getAvailable())}`)

      // Process each client with rate limiting
      for (const client of clients) {
        try {
          const email = client.email.toLowerCase()
          totalProcessed++

          // Check if crosswalk already exists
          const { data: existing } = await supabase
            .from('integration_crosswalk')
            .select('id')
            .eq('email', email)
            .single()

          if (existing) continue // Skip if already exists

          // Rate limited API call
          await rateLimiter.acquire();
          const subscriber = await findMailerLiteSubscriber(apiKey, email)
          
          // Create crosswalk entry
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
            if (crosswalkCreated % 10 === 0) {
              console.log(`✅ Created ${crosswalkCreated} crosswalk entries`)
            }
          }

        } catch (error) {
          console.error(`Error processing client ${client.email}:`, error)
          errors++
        }
      }

      offset += batchSize
      
      // Update progress every batch
      progress.totalProcessed = totalProcessed;
      progress.crosswalkCreated = crosswalkCreated;
      progress.errors = errors;
      progress.lastUpdatedAt = new Date().toISOString();
      await saveProgress(supabase, progress);

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (error) {
      console.error('Error in client batch processing:', error)
      errors++
      break
    }
  }

  return { crosswalkCreated, totalProcessed, errors }
}

async function buildSubscriberCrosswalk(supabase: any, apiKey: string, progress: BackfillProgress): Promise<{crosswalkCreated: number, totalProcessed: number, errors: number}> {
  let crosswalkCreated = 0
  let totalProcessed = 0
  let errors = 0
  let cursor: string | null = null

  while (true) {
    try {
      // Rate limited API call
      await rateLimiter.acquire();
      
      // Fetch MailerLite subscribers
      let url = `https://connect.mailerlite.com/api/subscribers?limit=50` // Reduced batch size
      if (cursor) {
        url += `&cursor=${cursor}`
      }

      console.log(`📦 Fetching subscriber batch, rate limit tokens: ${Math.floor(rateLimiter.getAvailable())}`)

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })

      if (!response.ok) throw new Error(`MailerLite API error: ${response.status}`)

      const data = await response.json()
      if (!data.data || data.data.length === 0) break

      // Process each subscriber
      for (const subscriber of data.data) {
        try {
          const email = subscriber.email.toLowerCase()
          totalProcessed++

          // Check if crosswalk already exists
          const { data: existing } = await supabase
            .from('integration_crosswalk')
            .select('id, a_id')
            .eq('email', email)
            .single()

          if (existing?.a_id) continue // Skip if client ID already mapped

          // Find client by email
          const { data: client } = await supabase
            .from('clients')
            .select('id')
            .eq('email', email)
            .single()

          // Upsert crosswalk entry
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
            if (crosswalkCreated % 10 === 0) {
              console.log(`✅ Upserted ${crosswalkCreated} crosswalk entries from subscribers`)
            }
          }

        } catch (error) {
          console.error(`Error processing subscriber ${subscriber.email}:`, error)
          errors++
        }
      }

      // Update progress
      progress.totalProcessed += totalProcessed;
      progress.crosswalkCreated += crosswalkCreated;
      progress.errors = errors;
      progress.lastUpdatedAt = new Date().toISOString();
      await saveProgress(supabase, progress);

      cursor = data.meta?.next_cursor || null
      if (!cursor) break

      // Delay between batches
      await new Promise(resolve => setTimeout(resolve, 500))

    } catch (error) {
      console.error('Error in subscriber batch processing:', error)
      errors++
      break
    }
  }

  return { crosswalkCreated, totalProcessed, errors }
}

async function createInitialShadows(supabase: any, apiKey: string, progress: BackfillProgress): Promise<{shadowsCreated: number, errors: number}> {
  let shadowsCreated = 0
  let errors = 0
  let offset = 0
  const batchSize = 20 // Reduced for rate limiting

  while (true) {
    try {
      // Get all crosswalk entries with both IDs
      const { data: crosswalks, error } = await supabase
        .from('integration_crosswalk')
        .select('email, a_id, b_id')
        .not('a_id', 'is', null)
        .not('b_id', 'is', null)
        .range(offset, offset + batchSize - 1)

      if (error) throw error
      if (!crosswalks || crosswalks.length === 0) break

      console.log(`📦 Creating shadow batch: ${offset + 1}-${offset + crosswalks.length}, rate limit tokens: ${Math.floor(rateLimiter.getAvailable())}`)

      // Process each crosswalk entry
      for (const crosswalk of crosswalks) {
        try {
          const email = crosswalk.email

          // Check if shadow already exists
          const { data: existingShadow } = await supabase
            .from('sync_shadow')
            .select('id')
            .eq('email', email)
            .single()

          if (existingShadow) continue // Skip if shadow already exists

          // Get client data
          const { data: client } = await supabase
            .from('clients')
            .select('first_name, last_name, phone, city, country')
            .eq('id', crosswalk.a_id)
            .single()

          // Rate limited API call
          await rateLimiter.acquire();
          const subscriber = await getMailerLiteSubscriber(apiKey, crosswalk.b_id)

          if (!client || !subscriber) {
            console.warn(`Missing data for shadow creation: ${email}`)
            continue
          }

          // Create shadow snapshot
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
            if (shadowsCreated % 10 === 0) {
              console.log(`✅ Created ${shadowsCreated} shadows`)
            }
          }

        } catch (error) {
          console.error(`Error processing crosswalk ${crosswalk.email}:`, error)
          errors++
        }
      }

      offset += batchSize
      
      // Update progress
      progress.shadowsCreated = shadowsCreated;
      progress.errors = errors;
      progress.lastUpdatedAt = new Date().toISOString();
      await saveProgress(supabase, progress);

      // Delay between batches
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (error) {
      console.error('Error in shadow creation batch:', error)
      errors++
      break
    }
  }

  return { shadowsCreated, errors }
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