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
    const limit = 100

    while (true) {
      try {
        // Get all crosswalk entries with MailerLite IDs
        const { data: crosswalks, error } = await supabase
          .from('integration_crosswalk')
          .select('email, a_id, b_id')
          .not('b_id', 'is', null)
          .range(offset, offset + limit - 1)

        if (error) throw error
        if (!crosswalks || crosswalks.length === 0) break

        // Process each crosswalk entry
        for (const crosswalk of crosswalks) {
          try {
            const email = crosswalk.email
            const clientId = crosswalk.a_id
            const mailerLiteId = crosswalk.b_id

            if (!clientId) {
              console.log(`Skipping ${email} - no client ID in crosswalk`)
              continue
            }

            // Update client with mailerlite_id
            const { error: updateError } = await supabase
              .from('clients')
              .update({ 
                mailerlite_id: mailerLiteId,
              })
              .eq('id', clientId)

            if (updateError) {
              console.error(`Error updating client ${email}:`, updateError)
              result.errors++
            } else {
              result.recordsUpdated++
              console.log(`Updated client ${email} with MailerLite ID ${mailerLiteId}`)
            }

          } catch (error) {
            console.error(`Error processing crosswalk ${crosswalk.email}:`, error)
            result.errors++
          }
        }

        offset += limit
      } catch (error) {
        console.error('Error in batch processing:', error)
        result.errors++
        break
      }
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
