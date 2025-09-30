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

    // Process in batches to avoid overwhelming MailerLite API
    const batchSize = 50
    for (let i = 0; i < crosswalkData.length; i += batchSize) {
      const batch = crosswalkData.slice(i, i + batchSize)
      
      await Promise.all(
        batch.map(async (entry) => {
          try {
            // Check if subscription status already exists
            const { data: existing } = await supabaseClient
              .from('client_group_mappings')
              .select('*')
              .eq('client_id', entry.a_id)
              .maybeSingle()

            if (existing) {
              processed++
              return // Already has subscription status
            }

            // Fetch subscriber from MailerLite
            const response = await fetch(
              `https://connect.mailerlite.com/api/subscribers/${entry.b_id}`,
              {
                headers: {
                  'Authorization': `Bearer ${mailerLiteApiKey}`,
                  'Content-Type': 'application/json',
                },
              }
            )

            if (!response.ok) {
              console.error(`Failed to fetch subscriber ${entry.email}: ${response.status}`)
              errors++
              return
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
          } catch (error) {
            console.error(`Error processing ${entry.email}:`, error)
            errors++
          }
        })
      )

      // Rate limiting: wait 100ms between batches
      if (i + batchSize < crosswalkData.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }

    const result = {
      success: true,
      processed,
      updated,
      errors,
      message: `Backfill completed: ${updated} subscription statuses populated`
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
