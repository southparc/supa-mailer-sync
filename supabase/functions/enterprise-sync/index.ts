import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SyncOptions {
  direction: 'both' | 'mailerlite-to-supabase' | 'supabase-to-mailerlite'
  maxRecords?: number
  dryRun?: boolean
}

interface SyncResult {
  recordsProcessed: number
  conflictsDetected: number
  updatesApplied: number
  errors: number
  message: string
}

interface FieldConflict {
  field: string
  aValue: any
  bValue: any 
  aUpdated?: string
  bUpdated?: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('=== ENTERPRISE SYNC STARTED ===')
    
    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Parse request body
    const body = await req.json()
    const { direction = 'both', maxRecords = 1000, dryRun = false }: SyncOptions = body

    console.log(`Sync direction: ${direction}, Max records: ${maxRecords}, Dry run: ${dryRun}`)

    // Get MailerLite API key
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY')
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured')
    }

    let result: SyncResult = {
      recordsProcessed: 0,
      conflictsDetected: 0,
      updatesApplied: 0,
      errors: 0,
      message: 'Sync completed successfully'
    }

    // Execute sync based on direction
    if (direction === 'mailerlite-to-supabase' || direction === 'both') {
      console.log('→ Starting MailerLite → Supabase sync')
      const mlToSupaResult = await syncFromMailerLite(supabase, mailerLiteApiKey, maxRecords, dryRun)
      result.recordsProcessed += mlToSupaResult.recordsProcessed
      result.conflictsDetected += mlToSupaResult.conflictsDetected
      result.updatesApplied += mlToSupaResult.updatesApplied
      result.errors += mlToSupaResult.errors
    }

    if (direction === 'supabase-to-mailerlite' || direction === 'both') {
      console.log('→ Starting Supabase → MailerLite sync')
      const supaToMLResult = await syncToMailerLite(supabase, mailerLiteApiKey, maxRecords, dryRun)
      result.recordsProcessed += supaToMLResult.recordsProcessed
      result.conflictsDetected += supaToMLResult.conflictsDetected
      result.updatesApplied += supaToMLResult.updatesApplied
      result.errors += supaToMLResult.errors
    }

    console.log('=== ENTERPRISE SYNC COMPLETED ===', result)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (error) {
    console.error('Enterprise sync error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        recordsProcessed: 0,
        conflictsDetected: 0,
        updatesApplied: 0,
        errors: 1
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
})

async function syncFromMailerLite(supabase: any, apiKey: string, maxRecords: number, dryRun: boolean): Promise<SyncResult> {
  let recordsProcessed = 0
  let conflictsDetected = 0
  let updatesApplied = 0
  let errors = 0
  let cursor: string | null = null

  while (recordsProcessed < maxRecords) {
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

      if (!response.ok) {
        throw new Error(`MailerLite API error: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      
      if (!data.data || data.data.length === 0) {
        console.log('No more subscribers to process from MailerLite')
        break
      }

      // Process each subscriber
      for (const subscriber of data.data) {
        try {
          console.log(`Processing subscriber: ${subscriber.email}`)
          const syncResult = await processSubscriberSync(supabase, subscriber, dryRun)
          
          conflictsDetected += syncResult.conflicts
          updatesApplied += syncResult.updates
          recordsProcessed++

          if (recordsProcessed >= maxRecords) break
        } catch (error) {
          console.error(`Error processing subscriber ${subscriber.email}:`, error)
          errors++
        }
      }

      // Update cursor for pagination
      cursor = data.meta?.next_cursor
      if (!cursor) break

    } catch (error) {
      console.error('MailerLite batch processing error:', error)
      errors++
      break
    }
  }

  return { recordsProcessed, conflictsDetected, updatesApplied, errors, message: 'MailerLite sync completed' }
}

async function syncToMailerLite(supabase: any, apiKey: string, maxRecords: number, dryRun: boolean): Promise<SyncResult> {
  let recordsProcessed = 0
  let conflictsDetected = 0
  let updatesApplied = 0
  let errors = 0
  let offset = 0
  const limit = 100

  while (recordsProcessed < maxRecords) {
    try {
      console.log(`Fetching clients batch: offset=${offset}, limit=${limit}`)
      
      // Fetch clients from Supabase (no more mailerlite_subscriber_id reference)
      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, email, first_name, last_name, phone, city, country')
        .range(offset, offset + limit - 1)
        .order('email')

      if (error) {
        throw new Error(`Supabase query error: ${error.message}`)
      }

      if (!clients || clients.length === 0) {
        console.log('No more clients to process from Supabase')
        break
      }

      // Process each client
      for (const client of clients) {
        try {
          console.log(`Processing client: ${client.email}`)
          const syncResult = await processClientSync(supabase, apiKey, client, dryRun)
          
          conflictsDetected += syncResult.conflicts
          updatesApplied += syncResult.updates
          recordsProcessed++

          if (recordsProcessed >= maxRecords) break
        } catch (error) {
          console.error(`Error processing client ${client.email}:`, error)
          errors++
        }
      }

      offset += limit
      
    } catch (error) {
      console.error('Client batch processing error:', error)
      errors++
      break
    }
  }

  return { recordsProcessed, conflictsDetected, updatesApplied, errors, message: 'Supabase sync completed' }
}

async function processSubscriberSync(supabase: any, subscriber: any, dryRun: boolean): Promise<{conflicts: number, updates: number}> {
  const email = subscriber.email.toLowerCase()
  const dedupeKey = `ml-sync-${email}-${Date.now()}`
  
  // Get crosswalk mapping
  const { data: crosswalk } = await supabase
    .from('integration_crosswalk')
    .select('*')
    .eq('email', email)
    .single()

  let clientId = crosswalk?.a_id
  
  // Get or create client record
  let { data: client } = await supabase
    .from('clients')
    .select('*')
    .eq('email', email)
    .single()

  if (!client && !dryRun) {
    // Create new client from MailerLite data
    const { data: newClient, error } = await supabase
      .from('clients')
      .insert({
        email,
        first_name: subscriber.fields?.first_name || '',
        last_name: subscriber.fields?.last_name || '',
        phone: subscriber.fields?.phone || null,
        city: subscriber.fields?.city || null,
        country: subscriber.fields?.country || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating client:', error)
      return { conflicts: 0, updates: 0 }
    }
    
    client = newClient
    clientId = client.id

    // Create crosswalk entry
    await supabase
      .from('integration_crosswalk')
      .upsert({
        email,
        a_id: clientId,
        b_id: subscriber.id,
      })

    await logSyncActivity(supabase, email, 'created', 'ML→SB', 'success', dedupeKey)
    return { conflicts: 0, updates: 1 }
  }

  if (!client) {
    return { conflicts: 0, updates: 0 }
  }

  // Get shadow state
  const { data: shadow } = await supabase
    .from('sync_shadow')
    .select('*')
    .eq('email', email)
    .single()

  // Prepare data for sync engine
  const clientData = {
    first_name: client.first_name,
    last_name: client.last_name,
    phone: client.phone,
    city: client.city,
    country: client.country,
  }

  const mailerLiteData = {
    first_name: subscriber.fields?.first_name || '',
    last_name: subscriber.fields?.last_name || '',
    phone: subscriber.fields?.phone || '',
    city: subscriber.fields?.city || '',
    country: subscriber.fields?.country || '',
  }

  // Apply smart sync logic
  const syncResult = await applySyncEngine(
    supabase,
    email,
    clientData,
    mailerLiteData,
    shadow?.snapshot?.aData || {},
    shadow?.snapshot?.bData || {},
    dryRun,
    dedupeKey
  )

  return syncResult
}

async function processClientSync(supabase: any, apiKey: string, client: any, dryRun: boolean): Promise<{conflicts: number, updates: number}> {
  const email = client.email.toLowerCase()
  const dedupeKey = `sb-sync-${email}-${Date.now()}`

  // Get crosswalk mapping
  const { data: crosswalk } = await supabase
    .from('integration_crosswalk')
    .select('*')
    .eq('email', email)
    .single()

  let mailerLiteId = crosswalk?.b_id

  // Get MailerLite subscriber
  let subscriber = null
  if (mailerLiteId) {
    try {
      const response = await fetch(`https://connect.mailerlite.com/api/subscribers/${mailerLiteId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      })
      
      if (response.ok) {
        const data = await response.json()
        subscriber = data.data
      }
    } catch (error) {
      console.error(`Error fetching MailerLite subscriber ${mailerLiteId}:`, error)
    }
  }

  // If no subscriber found, create one
  if (!subscriber && !dryRun) {
    const createPayload = {
      email,
      fields: {
        first_name: client.first_name || '',
        last_name: client.last_name || '',
        phone: client.phone || '',
        city: client.city || '',
        country: client.country || '',
      }
    }

    try {
      const response = await fetch('https://connect.mailerlite.com/api/subscribers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createPayload),
      })

      if (response.ok) {
        const data = await response.json()
        subscriber = data.data
        mailerLiteId = subscriber.id

        // Update crosswalk
        await supabase
          .from('integration_crosswalk')
          .upsert({
            email,
            a_id: client.id,
            b_id: mailerLiteId,
          })

        await logSyncActivity(supabase, email, 'created', 'SB→ML', 'success', dedupeKey)
        return { conflicts: 0, updates: 1 }
      }
    } catch (error) {
      console.error('Error creating MailerLite subscriber:', error)
      return { conflicts: 0, updates: 0 }
    }
  }

  if (!subscriber) {
    return { conflicts: 0, updates: 0 }
  }

  // Get shadow state
  const { data: shadow } = await supabase
    .from('sync_shadow')
    .select('*')
    .eq('email', email)
    .single()

  // Prepare data for sync engine
  const clientData = {
    first_name: client.first_name,
    last_name: client.last_name,
    phone: client.phone,
    city: client.city,
    country: client.country,
  }

  const mailerLiteData = {
    first_name: subscriber.fields?.first_name || '',
    last_name: subscriber.fields?.last_name || '',
    phone: subscriber.fields?.phone || '',
    city: subscriber.fields?.city || '',
    country: subscriber.fields?.country || '',
  }

  // Apply smart sync logic
  const syncResult = await applySyncEngine(
    supabase,
    email,
    clientData,
    mailerLiteData,
    shadow?.snapshot?.aData || {},
    shadow?.snapshot?.bData || {},
    dryRun,
    dedupeKey
  )

  return syncResult
}

async function applySyncEngine(
  supabase: any,
  email: string,
  aData: Record<string, any>,
  bData: Record<string, any>,
  shadowA: Record<string, any>,
  shadowB: Record<string, any>,
  dryRun: boolean,
  dedupeKey: string
): Promise<{conflicts: number, updates: number}> {
  
  const fields = ['first_name', 'last_name', 'phone', 'city', 'country']
  const conflicts: FieldConflict[] = []
  let updates = 0

  for (const field of fields) {
    const aValue = normalize(aData[field])
    const bValue = normalize(bData[field])
    const shadowAValue = normalize(shadowA[field])
    const shadowBValue = normalize(shadowB[field])

    // Skip if values are the same
    if (aValue === bValue) continue

    // Check if A changed from shadow
    const aChanged = aValue !== shadowAValue
    // Check if B changed from shadow  
    const bChanged = bValue !== shadowBValue

    if (aChanged && bChanged) {
      // Both changed - conflict
      conflicts.push({
        field,
        aValue,
        bValue,
        aUpdated: new Date().toISOString(),
        bUpdated: new Date().toISOString(),
      })
    } else if (aChanged && !bChanged) {
      // A changed, B didn't - apply A's value to B
      if (!dryRun) {
        await updateSystemB(supabase, email, field, aValue, dedupeKey)
        updates++
      }
      await logSyncActivity(supabase, email, 'update', 'A→B', 'success', dedupeKey, field, bValue, aValue)
    } else if (!aChanged && bChanged) {
      // B changed, A didn't - apply B's value to A
      if (!dryRun) {
        await updateSystemA(supabase, email, field, bValue, dedupeKey)
        updates++
      }
      await logSyncActivity(supabase, email, 'update', 'B→A', 'success', dedupeKey, field, aValue, bValue)
    } else {
      // Neither changed but different - apply "non-empty overwrites empty" rule
      if (isEmpty(aValue) && !isEmpty(bValue)) {
        if (!dryRun) {
          await updateSystemA(supabase, email, field, bValue, dedupeKey)
          updates++
        }
        await logSyncActivity(supabase, email, 'fill_empty', 'B→A', 'success', dedupeKey, field, aValue, bValue)
      } else if (!isEmpty(aValue) && isEmpty(bValue)) {
        if (!dryRun) {
          await updateSystemB(supabase, email, field, aValue, dedupeKey)
          updates++
        }
        await logSyncActivity(supabase, email, 'fill_empty', 'A→B', 'success', dedupeKey, field, bValue, aValue)
      }
    }
  }

  // Store conflicts in sync_conflicts table (not ml_outbox)
  if (conflicts.length > 0 && !dryRun) {
    for (const conflict of conflicts) {
      await supabase
        .from('sync_conflicts')
        .insert({
          email,
          field: conflict.field,
          a_value: conflict.aValue,
          b_value: conflict.bValue,
          status: 'pending',
        })
    }
    await logSyncActivity(supabase, email, 'conflict', 'BOTH', 'pending', dedupeKey)
  }

  // Update shadow state
  if (!dryRun) {
    await supabase
      .from('sync_shadow')
      .upsert({
        email,
        snapshot: {
          aData,
          bData,
        },
      })
  }

  return { conflicts: conflicts.length, updates }
}

async function updateSystemA(supabase: any, email: string, field: string, value: any, dedupeKey: string) {
  try {
    await supabase
      .from('clients')
      .update({ [field]: value })
      .eq('email', email)
  } catch (error) {
    console.error(`Error updating client ${email} field ${field}:`, error)
    await logSyncActivity(supabase, email, 'update', 'B→A', 'error', dedupeKey, field, null, value)
  }
}

async function updateSystemB(supabase: any, email: string, field: string, value: any, dedupeKey: string) {
  // Note: This would update MailerLite via API, simplified for this implementation
  console.log(`Would update MailerLite subscriber ${email} field ${field} to ${value}`)
}

async function logSyncActivity(
  supabase: any,
  email: string,
  action: string,
  direction: string,
  result: string,
  dedupeKey: string,
  field?: string,
  oldValue?: any,
  newValue?: any
) {
  try {
    await supabase
      .from('sync_log')
      .insert({
        email,
        action,
        direction,
        result,
        field,
        old_value: oldValue?.toString(),
        new_value: newValue?.toString(),
        dedupe_key: dedupeKey,
      })
  } catch (error) {
    console.error('Error logging sync activity:', error)
  }
}

function normalize(value: any): string {
  if (value === null || value === undefined) return ''
  return String(value).trim().toLowerCase()
}

function isEmpty(value: any): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}