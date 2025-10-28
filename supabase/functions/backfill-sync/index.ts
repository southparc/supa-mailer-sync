import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('=== ENTERPRISE BACKFILL SYNC STARTED ===')
    
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

    console.log(`Admin user ${userId} initiated backfill sync`);

    // Get MailerLite API key
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY')
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured')
    }

    const result: BackfillResult = {
      crosswalkCreated: 0,
      shadowsCreated: 0,
      errors: 0,
      totalClientsProcessed: 0,
      totalSubscribersProcessed: 0,
      message: 'Backfill completed successfully'
    }

    // PHASE 1: Build crosswalk from existing clients
    console.log('Phase 1: Building crosswalk from Supabase clients...')
    const clientsResult = await buildClientCrosswalk(supabase, mailerLiteApiKey)
    result.crosswalkCreated += clientsResult.crosswalkCreated
    result.totalClientsProcessed += clientsResult.totalProcessed
    result.errors += clientsResult.errors

    // PHASE 2: Build crosswalk from MailerLite subscribers
    console.log('Phase 2: Building crosswalk from MailerLite subscribers...')
    const subscribersResult = await buildSubscriberCrosswalk(supabase, mailerLiteApiKey)
    result.crosswalkCreated += subscribersResult.crosswalkCreated
    result.totalSubscribersProcessed += subscribersResult.totalProcessed
    result.errors += subscribersResult.errors

    // PHASE 3: Create shadow snapshots for all mapped records
    console.log('Phase 3: Creating initial shadow snapshots...')
    const shadowResult = await createInitialShadows(supabase, mailerLiteApiKey)
    result.shadowsCreated = shadowResult.shadowsCreated
    result.errors += shadowResult.errors

    console.log('=== ENTERPRISE BACKFILL SYNC COMPLETED ===', result)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (error) {
    console.error('Enterprise backfill error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        crosswalkCreated: 0,
        shadowsCreated: 0,
        errors: 1
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
})

async function buildClientCrosswalk(supabase: any, apiKey: string): Promise<{crosswalkCreated: number, totalProcessed: number, errors: number}> {
  let crosswalkCreated = 0
  let totalProcessed = 0
  let errors = 0
  let offset = 0
  const limit = 100

  while (true) {
    try {
      // Fetch clients batch
      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, email')
        .range(offset, offset + limit - 1)
        .order('email')

      if (error) throw error
      if (!clients || clients.length === 0) break

      // Process each client
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

          // Find MailerLite subscriber by email
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
            console.log(`Created crosswalk for client ${email}`)
          }

        } catch (error) {
          console.error(`Error processing client ${client.email}:`, error)
          errors++
        }
      }

      offset += limit
    } catch (error) {
      console.error('Error in client batch processing:', error)
      errors++
      break
    }
  }

  return { crosswalkCreated, totalProcessed, errors }
}

async function buildSubscriberCrosswalk(supabase: any, apiKey: string): Promise<{crosswalkCreated: number, totalProcessed: number, errors: number}> {
  let crosswalkCreated = 0
  let totalProcessed = 0
  let errors = 0
  let cursor: string | null = null

  while (true) {
    try {
      // Fetch MailerLite subscribers
      let url = `https://connect.mailerlite.com/api/subscribers?limit=100`
      if (cursor) {
        url += `&cursor=${cursor}`
      }

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
            console.log(`Updated crosswalk for subscriber ${email}`)
          }

        } catch (error) {
          console.error(`Error processing subscriber ${subscriber.email}:`, error)
          errors++
        }
      }

      cursor = data.meta?.next_cursor
      if (!cursor) break

    } catch (error) {
      console.error('Error in subscriber batch processing:', error)
      errors++
      break
    }
  }

  return { crosswalkCreated, totalProcessed, errors }
}

async function createInitialShadows(supabase: any, apiKey: string): Promise<{shadowsCreated: number, errors: number}> {
  let shadowsCreated = 0
  let errors = 0
  let offset = 0
  const limit = 100

  while (true) {
    try {
      // Get all crosswalk entries with both IDs
      const { data: crosswalks, error } = await supabase
        .from('integration_crosswalk')
        .select('email, a_id, b_id')
        .not('a_id', 'is', null)
        .not('b_id', 'is', null)
        .range(offset, offset + limit - 1)

      if (error) throw error
      if (!crosswalks || crosswalks.length === 0) break

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

          // Get MailerLite subscriber data
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
            console.log(`Created shadow for ${email}`)
          }

        } catch (error) {
          console.error(`Error processing crosswalk ${crosswalk.email}:`, error)
          errors++
        }
      }

      offset += limit
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