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
  cursor?: string
  maxDurationMs?: number
}

interface SyncResult {
  recordsProcessed: number
  conflictsDetected: number
  updatesApplied: number
  errors: number
  message: string
  done: boolean
  nextCursor?: string
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
    let { direction = 'both', maxRecords = 300, dryRun = false, cursor, maxDurationMs = 120000 } = body

    // Map synonym directions from UI
    const directionMap: Record<string, string> = {
      'bidirectional': 'both',
      'from_mailerlite': 'mailerlite-to-supabase', 
      'to_mailerlite': 'supabase-to-mailerlite'
    }
    
    if (directionMap[direction]) {
      direction = directionMap[direction]
    }
    
    // Validate direction
    const validDirections = ['both', 'mailerlite-to-supabase', 'supabase-to-mailerlite']
    if (!validDirections.includes(direction)) {
      console.error(`Invalid sync direction received: ${direction}. Valid options: ${validDirections.join(', ')}`)
      return new Response(
        JSON.stringify({ 
          error: `Invalid sync direction: ${direction}. Valid options: ${validDirections.join(', ')}`,
          recordsProcessed: 0,
          conflictsDetected: 0,
          updatesApplied: 0,
          errors: 1
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400
        }
      )
    }

    console.log(`Sync direction: ${direction}, Max records: ${maxRecords}, Dry run: ${dryRun}`)
    console.log(`→ Will execute branches: ${
      direction === 'both' ? 'MailerLite→Supabase + Supabase→MailerLite' :
      direction === 'mailerlite-to-supabase' ? 'MailerLite→Supabase only' :
      'Supabase→MailerLite only'
    }`)

    // Get MailerLite API key
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY')
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured')
    }

    // Test MailerLite API connection first
    console.log('Testing MailerLite API connection...')
    try {
      const testResponse = await fetch('https://connect.mailerlite.com/api/subscribers?limit=1', {
        headers: {
          'Authorization': `Bearer ${mailerLiteApiKey}`,
          'Content-Type': 'application/json',
        },
      })
      
      if (!testResponse.ok) {
        throw new Error(`MailerLite API test failed: ${testResponse.status} ${testResponse.statusText}`)
      }
      
      const testData = await testResponse.json()
      console.log(`MailerLite API connection successful. Total subscribers available: ${testData.meta?.total || 'unknown'}`)
    } catch (error) {
      console.error('MailerLite API connection failed:', error)
      throw new Error(`Cannot connect to MailerLite API: ${error instanceof Error ? error.message : 'unknown error'}`)
    }

    let result: SyncResult = {
      recordsProcessed: 0,
      conflictsDetected: 0,
      updatesApplied: 0,
      errors: 0,
      message: 'Sync completed successfully',
      done: true,
      nextCursor: undefined
    }

    // Execute sync based on direction with time-bounded execution
    const startTime = Date.now()
    if (direction === 'mailerlite-to-supabase' || direction === 'both') {
      console.log('→ Starting MailerLite → Supabase sync')
      const mlToSupaResult = await syncFromMailerLite(supabase, mailerLiteApiKey, maxRecords, dryRun, cursor, maxDurationMs, startTime)
      result.recordsProcessed += mlToSupaResult.recordsProcessed
      result.conflictsDetected += mlToSupaResult.conflictsDetected
      result.updatesApplied += mlToSupaResult.updatesApplied
      result.errors += mlToSupaResult.errors
      result.done = mlToSupaResult.done
      result.nextCursor = mlToSupaResult.nextCursor
    }

    if (direction === 'supabase-to-mailerlite' || direction === 'both') {
      console.log('→ Starting Supabase → MailerLite sync')
      const supaToMLResult = await syncToMailerLite(supabase, mailerLiteApiKey, maxRecords, dryRun, maxDurationMs, startTime)
      result.recordsProcessed += supaToMLResult.recordsProcessed
      result.conflictsDetected += supaToMLResult.conflictsDetected
      result.updatesApplied += supaToMLResult.updatesApplied
      result.errors += supaToMLResult.errors
      // Only update done/cursor if we're not doing bidirectional or if MailerLite sync is done
      if (direction === 'supabase-to-mailerlite' || result.done) {
        result.done = supaToMLResult.done
        result.nextCursor = supaToMLResult.nextCursor
      }
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

async function syncFromMailerLite(supabase: any, apiKey: string, maxRecords: number, dryRun: boolean, startCursor?: string, maxDurationMs: number = 120000, startTime: number = Date.now()): Promise<SyncResult> {
  let recordsProcessed = 0
  let conflictsDetected = 0
  let updatesApplied = 0
  let errors = 0
  let cursor: string | null = startCursor || null

  // Get persisted cursor if not provided
  if (!cursor) {
    const { data: syncState } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'mailerlite:import:cursor')
      .single()
    
    cursor = syncState?.value?.cursor || null
    console.log(`Retrieved cursor from sync_state: ${cursor}`)
  }

  while (recordsProcessed < maxRecords) {
    // Check time bounds - leave 10s buffer for final operations
    if (Date.now() - startTime > maxDurationMs - 10000) {
      console.log(`Time bound reached (${Date.now() - startTime}ms), stopping early`)
      break
    }
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

      // Update cursor for pagination and save progress
      cursor = data.meta?.next_cursor
      
      if (cursor) {
        // Save cursor to sync_state for resume capability
        await supabase
          .from('sync_state')
          .upsert({
            key: 'mailerlite:import:cursor',
            value: { cursor, recordsProcessed, updatedAt: new Date().toISOString() }
          })
      }
      
      if (!cursor) break

    } catch (error) {
      console.error('MailerLite batch processing error:', error)
      errors++
      break
    }
  }

  // Clear cursor if completed
  const done = !cursor || recordsProcessed < maxRecords
  if (done) {
    await supabase
      .from('sync_state')
      .delete()
      .eq('key', 'mailerlite:import:cursor')
    console.log('Import completed, cursor cleared')
  }

  return { 
    recordsProcessed, 
    conflictsDetected, 
    updatesApplied, 
    errors, 
    message: done ? 'MailerLite sync completed' : 'MailerLite sync partial (time bounded)',
    done,
    nextCursor: cursor || undefined
  }
}

async function syncToMailerLite(supabase: any, apiKey: string, maxRecords: number, dryRun: boolean, maxDurationMs: number = 120000, startTime: number = Date.now()): Promise<SyncResult> {
  let recordsProcessed = 0
  let conflictsDetected = 0
  let updatesApplied = 0
  let errors = 0
  let offset = 0
  const limit = 100

  while (recordsProcessed < maxRecords) {
    // Check time bounds
    if (Date.now() - startTime > maxDurationMs - 10000) {
      console.log(`Time bound reached for Supabase sync (${Date.now() - startTime}ms), stopping early`)
      break
    }
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

  const done = recordsProcessed < maxRecords
  return { 
    recordsProcessed, 
    conflictsDetected, 
    updatesApplied, 
    errors, 
    message: done ? 'Supabase sync completed' : 'Supabase sync partial (time bounded)',
    done,
    nextCursor: undefined // Supabase sync doesn't use cursors, uses offset
  }
}

async function processSubscriberSync(supabase: any, subscriber: any, dryRun: boolean): Promise<{conflicts: number, updates: number}> {
  const email = subscriber.email.toLowerCase()
  const dedupeKey = `ml-sync-${email}-${Date.now()}`
  
  // ENTERPRISE FEATURE: Per-email locking to prevent concurrent syncs
  await supabase.rpc('pg_advisory_xact_lock', { 
    key: `hashtext('sync_${email}'::text)` 
  })
  
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
        mailerlite_id: subscriber.id,
        first_name: subscriber.fields?.name || '',
        last_name: subscriber.fields?.last_name || '',
        initials: subscriber.fields?.initials || null,
        prefix: subscriber.fields?.prefix || null,
        phone: subscriber.fields?.phone || null,
        company: subscriber.fields?.company || null,
        city: subscriber.fields?.city || null,
        zip: subscriber.fields?.zip || subscriber.fields?.z_i_p || null,
        location: subscriber.fields?.location || null,
        country: subscriber.fields?.country || null,
        gender: subscriber.fields?.gender || null,
        age: subscriber.fields?.leeftijd ? parseInt(subscriber.fields.leeftijd) : null,
        planning_status: subscriber.fields?.planning_status || null,
        referer: subscriber.fields?.doorverwijzer || null,
        figlorawsnapshot: subscriber, // Store complete MailerLite data
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

    // Map MailerLite status to subscription status
    const isSubscribed = mapMailerLiteStatusToSubscribed(subscriber.status)
    
    // Create client group mapping with subscription status
    await supabase
      .from('client_group_mappings')
      .upsert({
        client_id: clientId,
        group_id: 1, // Default group - you may want to make this configurable
        is_subscribed: isSubscribed,
      })

    // Sync partner data if present
    if (subscriber.fields?.partner_email || subscriber.fields?.partner_first_name) {
      await supabase
        .from('partners')
        .upsert({
          client_id: clientId,
          figlosourceid: `ml_partner_${subscriber.id}`,
          email: subscriber.fields?.partner_email || null,
          first_name: subscriber.fields?.partner_first_name || '',
          last_name: subscriber.fields?.partner_last_name || '',
          initials: subscriber.fields?.partner_initials || null,
          prefix: subscriber.fields?.partner_prefix || null,
          gender: subscriber.fields?.partner_gender || null,
        }, {
          onConflict: 'client_id,figlosourceid'
        })
    }

    // Link to existing advisor by name
    if (subscriber.fields?.advisor) {
      const { data: advisor } = await supabase
        .from('advisors')
        .select('id')
        .ilike('name', subscriber.fields.advisor)
        .maybeSingle()
      
      if (advisor) {
        await supabase
          .from('clients')
          .update({ advisor_id: advisor.id })
          .eq('id', clientId)
      }
    }

    // Sync contract data if present
    if (subscriber.fields?.dvo || subscriber.fields?.schadeklant) {
      await supabase
        .from('contracts')
        .upsert({
          client_id: clientId,
          dvo: subscriber.fields?.dvo ? parseFloat(subscriber.fields.dvo) : null,
          is_damage_client: subscriber.fields?.schadeklant === 'ja' || subscriber.fields?.schadeklant === 'true',
        })
    }

    await logSyncActivity(supabase, email, 'created', 'ML→SB', 'success', dedupeKey)
    console.log(`Created client ${email} with subscription status: ${subscriber.status} -> ${isSubscribed}`)
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
    first_name: subscriber.fields?.name || '',
    last_name: subscriber.fields?.last_name || '',
    phone: subscriber.fields?.phone || '',
    city: subscriber.fields?.city || '',
    country: subscriber.fields?.country || '',
  }

  // Update stored MailerLite snapshot if not dry run
  if (!dryRun) {
    await supabase
      .from('clients')
      .update({ figlorawsnapshot: subscriber })
      .eq('email', email)
  }

  // Update subscription status in client_group_mappings
  const isSubscribed = mapMailerLiteStatusToSubscribed(subscriber.status)
  
  if (!dryRun) {
    await supabase
      .from('client_group_mappings')
      .upsert({
        client_id: clientId,
        group_id: 1, // Default group - you may want to make this configurable
        is_subscribed: isSubscribed,
      })
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

  console.log(`Updated subscription status for ${email}: ${subscriber.status} -> ${isSubscribed}`)
  return syncResult
}

async function processClientSync(supabase: any, apiKey: string, client: any, dryRun: boolean): Promise<{conflicts: number, updates: number}> {
  const email = client.email.toLowerCase()
  const dedupeKey = `sb-sync-${email}-${Date.now()}`

  // ENTERPRISE FEATURE: Per-email locking to prevent concurrent syncs
  await supabase.rpc('pg_advisory_xact_lock', { 
    key: `hashtext('sync_${email}'::text)` 
  })

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
        name: client.first_name || '',
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
    first_name: subscriber.fields?.name || '',
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
    } else if (aChanged && bChanged) {
      // ENTERPRISE FEATURE: Both changed - apply "non-empty overwrites empty" rule
      if (isEmpty(aValue) && !isEmpty(bValue)) {
        // B overwrites empty A
        if (!dryRun) {
          await updateSystemA(supabase, email, field, bValue, dedupeKey)
          updates++
        }
        await logSyncActivity(supabase, email, 'fill_empty', 'B→A', 'success', dedupeKey, field, aValue, bValue)
      } else if (!isEmpty(aValue) && isEmpty(bValue)) {
        // A overwrites empty B
        if (!dryRun) {
          await updateSystemB(supabase, email, field, aValue, dedupeKey)
          updates++
        }
        await logSyncActivity(supabase, email, 'fill_empty', 'A→B', 'success', dedupeKey, field, bValue, aValue)
      } else {
        // Both filled and different = conflict
        conflicts.push({
          field,
          aValue,
          bValue,
          aUpdated: new Date().toISOString(),
          bUpdated: new Date().toISOString(),
        })
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
  const apiKey = Deno.env.get('MAILERLITE_API_KEY')
  if (!apiKey) {
    console.error('MailerLite API key not available for updateSystemB')
    return
  }

  try {
    // Get MailerLite subscriber ID from crosswalk
    const { data: crosswalk } = await supabase
      .from('integration_crosswalk')
      .select('b_id')
      .eq('email', email)
      .single()

    if (!crosswalk?.b_id) {
      console.error(`No MailerLite ID found in crosswalk for ${email}`)
      return
    }

    // ENTERPRISE FEATURE: Retry logic with exponential backoff
    await withRetry(async () => {
      const response = await fetch(`https://connect.mailerlite.com/api/subscribers/${crosswalk.b_id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: { [field]: value }
        })
      })

      if (!response.ok) {
        throw new Error(`MailerLite API error: ${response.status} ${response.statusText}`)
      }

      console.log(`Successfully updated MailerLite subscriber ${email} field ${field} to ${value}`)
    })

  } catch (error) {
    console.error(`Error updating MailerLite subscriber ${email} field ${field}:`, error)
    await logSyncActivity(supabase, email, 'update', 'A→B', 'error', dedupeKey, field, null, value)
    throw error
  }
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

// Map MailerLite subscription status to boolean
function mapMailerLiteStatusToSubscribed(status: string): boolean {
  // MailerLite statuses: active, unsubscribed, bounced, junk, unconfirmed
  return status === 'active'
}

// ENTERPRISE FEATURE: Retry logic with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (attempt === maxAttempts) {
        console.error(`Final retry attempt failed:`, error)
        throw error
      }
      
      const delay = Math.pow(2, attempt) * 1000 // Exponential backoff: 2s, 4s, 8s
      console.log(`Retry attempt ${attempt} failed, retrying in ${delay}ms:`, error)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable code')
}