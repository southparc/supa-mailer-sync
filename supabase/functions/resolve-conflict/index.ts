import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    // Verify admin privileges
    const { userId, error: adminError } = await verifyAdmin(req, supabaseClient);
    if (adminError) {
      console.error('Unauthorized access attempt');
      return adminError;
    }

    console.log(`Admin user ${userId} initiated conflict resolution`);

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
      await updateSupabaseClient(resolution, supabaseClient);
    }

    // Log the resolution
    await supabaseClient
      .from('sync_log')
      .insert({
        email: resolution.email,
        action: 'conflict_resolved',
        direction: resolution.targetSource === 'mailerlite' ? 'B→A' : 'A→B',
        result: 'success',
        field: resolution.field,
        new_value: resolution.chosenValue?.toString()
      });

    // Mark conflict as resolved
    await supabaseClient
      .from('sync_conflicts')
      .update({
        status: 'resolved',
        resolved_value: resolution.chosenValue?.toString(),
        resolved_at: new Date().toISOString()
      })
      .eq('id', resolution.conflictId);

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

async function updateSupabaseClient(resolution: ConflictResolution, supabaseClient: any) {
  // Find the client in Supabase
  const { data: client, error: findError } = await supabaseClient
    .from('clients')
    .select('*')
    .eq('email', resolution.email)
    .maybeSingle();

  if (findError) {
    throw new Error(`Database error finding client ${resolution.email}: ${findError.message}`);
  }

  if (!client) {
    throw new Error(`Client ${resolution.email} not found in Supabase`);
  }

  // Prepare update data based on field mapping
  let updateData: any = {};
  
  // Map field names according to sync engine mapping
  const fieldMappings: Record<string, string> = {
    'name': 'first_name', // MailerLite 'name' -> Supabase 'first_name'
    'first_name': 'first_name',
    'last_name': 'last_name',
    'email': 'email',
    'phone': 'phone',
    'city': 'city',
    'country': 'country'
  };
  
  const supabaseField = fieldMappings[resolution.field] || resolution.field;
  updateData[supabaseField] = resolution.chosenValue;
  updateData.updated_at = new Date().toISOString();

  // Update client in Supabase
  const { error: updateError } = await supabaseClient
    .from('clients')
    .update(updateData)
    .eq('id', client.id);

  if (updateError) {
    throw new Error(`Failed to update Supabase client: ${updateError.message}`);
  }

  console.log(`Updated ${resolution.email} in Supabase with ${resolution.field}: ${resolution.chosenValue}`);
}