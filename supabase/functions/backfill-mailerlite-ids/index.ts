import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface BackfillResult {
  recordsUpdated: number
  errors: number
  message: string
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    console.log('=== MAILERLITE ID BACKFILL STARTED ===')
    
    // Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const result: BackfillResult = {
      recordsUpdated: 0,
      errors: 0,
      message: 'Backfill completed successfully'
    }

    let offset = 0
    const limit = 100 // Process max 100 records per run (takes ~2 min with rate limiting)
    const delayMs = 500 // 500ms delay = 2 requests/sec (within MailerLite limits)
    
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    // Single batch processing - function can be called multiple times
    try {
      console.log(`Processing batch: offset ${offset}, limit ${limit}`)
      
      // Get crosswalk entries WITHOUT MailerLite IDs (b_id is null)
      const { data: crosswalks, error } = await supabase
        .from('integration_crosswalk')
        .select('email')
        .is('b_id', null)
        .limit(limit)

      if (error) throw error
      
      if (!crosswalks || crosswalks.length === 0) {
        result.message = 'All records processed - backfill complete!'
        console.log('✅ No more records to process')
        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        })
      }

      console.log(`Found ${crosswalks.length} records without b_id`)

      // Process each crosswalk entry
      for (const crosswalk of crosswalks) {
        try {
          const email = crosswalk.email

          if (!email) {
            console.log(`Skipping record - no email`)
            continue
          }

            // Lookup in MailerLite by email
            const lookupUrl = `https://connect.mailerlite.com/api/subscribers?filter[email]=${encodeURIComponent(email.toLowerCase().trim())}`
            const mlResponse = await fetch(lookupUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${Deno.env.get('MAILERLITE_API_KEY')}`,
                'Content-Type': 'application/json',
              },
            })

            // Rate limit: wait before next request
            await sleep(delayMs)

            if (!mlResponse.ok) {
              // Handle rate limiting with exponential backoff
              if (mlResponse.status === 429) {
                console.log(`⚠️ Rate limited for ${email}, waiting 10s...`)
                await sleep(10000)
                result.errors++
                continue
              }
              console.log(`MailerLite lookup failed for ${email}: ${mlResponse.status}`)
              result.errors++
              continue
            }

            const mlData = await mlResponse.json()
            
            if (mlData.data && mlData.data.length > 0) {
              const subscriber = mlData.data[0]
              const mailerLiteId = subscriber.id

              // Update crosswalk with found b_id
              const { error: updateError } = await supabase
                .from('integration_crosswalk')
                .update({ b_id: mailerLiteId })
                .eq('email', email)

              if (updateError) {
                console.error(`Error updating crosswalk ${email}:`, updateError)
                result.errors++
              } else {
                result.recordsUpdated++
                console.log(`✅ Updated crosswalk ${email} → ML ID ${mailerLiteId}`)
              }
            } else {
              console.log(`⚠️ Email ${email} not found in MailerLite`)
            }

          } catch (error) {
            console.error(`Error processing crosswalk ${crosswalk.email}:`, error)
            result.errors++
          }
        }

      // Get remaining count
      const { count } = await supabase
        .from('integration_crosswalk')
        .select('*', { count: 'exact', head: true })
        .is('b_id', null)

      result.message = `Batch complete. Updated: ${result.recordsUpdated}, Errors: ${result.errors}, Remaining: ${count || 0}`
      
    } catch (error) {
      console.error('Error in batch processing:', error)
      result.errors++
    }

    console.log('=== MAILERLITE ID BACKFILL COMPLETED ===', result)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (error) {
    console.error('Backfill error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        recordsUpdated: 0,
        errors: 1
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
})
