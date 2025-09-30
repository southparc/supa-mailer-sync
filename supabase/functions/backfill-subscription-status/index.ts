import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface MailerLiteSubscriber {
  id: string
  email: string
  status: 'active' | 'unsubscribed' | 'unconfirmed' | 'bounced' | 'junk'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY')
    if (!mailerLiteApiKey) {
      throw new Error('MAILERLITE_API_KEY not configured')
    }

    console.log('Starting subscription status backfill...')

    // Get all clients with MailerLite IDs but no subscription status
    const { data: crosswalkData, error: crosswalkError } = await supabaseClient
      .from('integration_crosswalk')
      .select('email, b_id, a_id')
      .not('b_id', 'is', null)

    if (crosswalkError) {
      throw new Error(`Failed to fetch crosswalk: ${crosswalkError.message}`)
    }

    console.log(`Found ${crosswalkData.length} clients with MailerLite IDs`)

    let processed = 0
    let updated = 0
    let errors = 0
    let skipped = 0

    // Process in smaller batches with rate limiting
    const batchSize = 5 // Much smaller to respect MailerLite rate limits
    for (let i = 0; i < crosswalkData.length; i += batchSize) {
      const batch = crosswalkData.slice(i, i + batchSize)
      
      console.log(`Processing batch ${i / batchSize + 1}/${Math.ceil(crosswalkData.length / batchSize)}`)
      
      // Process sequentially within batch to avoid rate limits
      for (const entry of batch) {
        try {
          // Check if subscription status already exists
          const { data: existing } = await supabaseClient
            .from('client_group_mappings')
            .select('*')
            .eq('client_id', entry.a_id)
            .maybeSingle()

          if (existing) {
            skipped++
            processed++
            continue // Already has subscription status
          }

          // Fetch subscriber from MailerLite with retry logic
          let retries = 0
          const maxRetries = 3
          let response: Response | null = null
          
          while (retries < maxRetries) {
            response = await fetch(
              `https://connect.mailerlite.com/api/subscribers/${entry.b_id}`,
              {
                headers: {
                  'Authorization': `Bearer ${mailerLiteApiKey}`,
                  'Content-Type': 'application/json',
                },
              }
            )

            if (response.status === 429) {
              // Rate limited - wait longer
              const waitTime = Math.pow(2, retries) * 2000 // Exponential backoff: 2s, 4s, 8s
              console.log(`Rate limited for ${entry.email}, waiting ${waitTime}ms...`)
              await new Promise(resolve => setTimeout(resolve, waitTime))
              retries++
              continue
            }

            if (response.ok) {
              break
            }

            console.error(`Failed to fetch subscriber ${entry.email}: ${response.status}`)
            errors++
            processed++
            break
          }

          if (!response || !response.ok) {
            continue
          }

          const subscriber: { data: MailerLiteSubscriber } = await response.json()
          const isSubscribed = subscriber.data.status === 'active'

          // Insert subscription status
          const { error: insertError } = await supabaseClient
            .from('client_group_mappings')
            .insert({
              client_id: entry.a_id,
              group_id: 1,
              is_subscribed: isSubscribed,
            })

          if (insertError) {
            console.error(`Failed to insert subscription for ${entry.email}:`, insertError)
            errors++
          } else {
            updated++
            console.log(`Updated ${entry.email}: ${subscriber.data.status} -> ${isSubscribed}`)
          }

          processed++

          // Wait between each request to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 250))
        } catch (error) {
          console.error(`Error processing ${entry.email}:`, error)
          errors++
          processed++
        }
      }

      // Wait between batches
      if (i + batchSize < crosswalkData.length) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    const result = {
      success: true,
      processed,
      updated,
      skipped,
      errors,
      message: `Backfill completed: ${updated} new, ${skipped} skipped, ${errors} errors`
    }

    console.log('Backfill result:', result)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Backfill error:', error)
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
