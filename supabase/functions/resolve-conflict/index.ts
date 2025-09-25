import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ConflictResolution {
  conflictId: string;
  email: string;
  field: string;
  chosenValue: any;
  source: 'mailerlite' | 'supabase';
  targetSource: 'mailerlite' | 'supabase';
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    const resolution: ConflictResolution = await req.json();
    
    console.log(`Resolving conflict for ${resolution.email} - ${resolution.field}`);

    // Get MailerLite API key
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY');
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured');
    }

    const mailerLiteHeaders = {
      'Authorization': `Bearer ${mailerLiteApiKey}`,
      'Content-Type': 'application/json',
    };

    // Apply the chosen value to the target system
    if (resolution.targetSource === 'mailerlite') {
      await updateMailerLiteSubscriber(resolution, mailerLiteHeaders);
    } else {
      await updateSupabaseSubscriber(resolution, supabaseClient);
    }

    // Log the resolution
    await supabaseClient
      .from('ml_outbox')
      .insert({
        action: 'conflict_resolved',
        entity_type: 'subscriber',
        payload: {
          email: resolution.email,
          field: resolution.field,
          resolved_value: resolution.chosenValue,
          source: resolution.source
        },
        status: 'completed'
      });

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Conflict resolved successfully' 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      },
    );

  } catch (error) {
    console.error('Conflict resolution error:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        success: false 
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      },
    );
  }
});

async function updateMailerLiteSubscriber(resolution: ConflictResolution, headers: any) {
  // First, find the subscriber in MailerLite by email
  const searchResponse = await fetch(`https://connect.mailerlite.com/api/subscribers?filter[email]=${resolution.email}`, {
    headers
  });

  if (!searchResponse.ok) {
    throw new Error(`Failed to find subscriber in MailerLite: ${searchResponse.statusText}`);
  }

  const { data: subscribers } = await searchResponse.json();
  
  if (subscribers.length === 0) {
    throw new Error(`Subscriber ${resolution.email} not found in MailerLite`);
  }

  const subscriber = subscribers[0];
  
  // Prepare update data based on field
  let updateData: any = {};
  
  switch (resolution.field) {
    case 'name':
      updateData = {
        email: subscriber.email,
        fields: {
          ...subscriber.fields,
          name: resolution.chosenValue
        }
      };
      break;
    case 'status':
      updateData = {
        email: subscriber.email,
        status: resolution.chosenValue
      };
      break;
    default:
      updateData = {
        email: subscriber.email,
        fields: {
          ...subscriber.fields,
          [resolution.field]: resolution.chosenValue
        }
      };
  }

  // Update subscriber in MailerLite
  const updateResponse = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriber.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(updateData)
  });

  if (!updateResponse.ok) {
    throw new Error(`Failed to update MailerLite subscriber: ${updateResponse.statusText}`);
  }

  console.log(`Updated ${resolution.email} in MailerLite with ${resolution.field}: ${resolution.chosenValue}`);
}

async function updateSupabaseSubscriber(resolution: ConflictResolution, supabaseClient: any) {
  // Find the subscriber in Supabase
  const { data: subscriber, error: findError } = await supabaseClient
    .from('ml_subscribers')
    .select('*')
    .eq('email', resolution.email)
    .single();

  if (findError || !subscriber) {
    throw new Error(`Subscriber ${resolution.email} not found in Supabase`);
  }

  // Prepare update data based on field
  let updateData: any = {};
  
  switch (resolution.field) {
    case 'name':
      updateData.name = resolution.chosenValue;
      break;
    case 'status':
      updateData.status = resolution.chosenValue;
      break;
    default:
      // For custom fields, update the fields JSON
      updateData.fields = {
        ...subscriber.fields,
        [resolution.field]: resolution.chosenValue
      };
  }

  updateData.updated_at = new Date().toISOString();

  // Update subscriber in Supabase
  const { error: updateError } = await supabaseClient
    .from('ml_subscribers')
    .update(updateData)
    .eq('id', subscriber.id);

  if (updateError) {
    throw new Error(`Failed to update Supabase subscriber: ${updateError.message}`);
  }

  console.log(`Updated ${resolution.email} in Supabase with ${resolution.field}: ${resolution.chosenValue}`);
}