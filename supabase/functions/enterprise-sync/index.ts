import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface SyncOptions {
  batchSize?: number;
  maxRecords?: number;
  fieldMappings?: Array<{
    supabaseField: string;
    mailerLiteField: string;
  }>;
}

interface FieldConflict {
  field: string;
  a_value: any;
  b_value: any;
  a_updated_at?: string;
  b_updated_at?: string;
}

serve(async (req) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('=== ENTERPRISE SYNC FUNCTION STARTED ===');
    
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { direction, options = {} } = await req.json();
    const { batchSize = 100, maxRecords = 1000 } = options as SyncOptions;

    console.log(`Starting enterprise sync - Direction: ${direction}`);

    // Get MailerLite API key
    const mailerLiteKey = Deno.env.get('MAILERLITE_API_KEY');
    if (!mailerLiteKey) {
      throw new Error('MailerLite API key not configured');
    }

    let results = {
      recordsProcessed: 0,
      conflictsDetected: 0,
      updatesApplied: 0,
      errors: 0
    };

    if (direction === 'bidirectional' || direction === 'from_mailerlite') {
      results = await syncFromMailerLite(supabase, mailerLiteKey, options);
    }
    
    if (direction === 'bidirectional' || direction === 'to_mailerlite') {
      const toResults = await syncToMailerLite(supabase, mailerLiteKey, options);
      results.recordsProcessed += toResults.recordsProcessed;
      results.conflictsDetected += toResults.conflictsDetected;
      results.updatesApplied += toResults.updatesApplied;
      results.errors += toResults.errors;
    }

    console.log(`=== ENTERPRISE SYNC COMPLETED ===`, results);

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Enterprise sync failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(JSON.stringify({ 
      error: errorMessage,
      recordsProcessed: 0,
      conflictsDetected: 0,
      updatesApplied: 0,
      errors: 1
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

async function syncFromMailerLite(supabase: any, apiKey: string, options: SyncOptions) {
  console.log('→ Starting MailerLite → Supabase sync');
  
  const { batchSize = 100, maxRecords = 1000 } = options;
  let offset = 0;
  let totalProcessed = 0;
  let totalConflicts = 0;
  let totalUpdates = 0;
  let totalErrors = 0;

  while (totalProcessed < maxRecords) {
    try {
      console.log(`Fetching batch: offset=${offset}, limit=${batchSize}`);
      
      // Fetch from MailerLite
      const response = await fetch(`https://connect.mailerlite.com/api/subscribers?limit=${batchSize}&offset=${offset}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`MailerLite API error: ${response.status}`);
      }

      const data = await response.json();
      const subscribers = data.data || [];

      if (subscribers.length === 0) {
        console.log('No more subscribers to process');
        break;
      }

      // Process each subscriber with smart sync logic
      for (const subscriber of subscribers) {
        try {
          const result = await processSubscriberSync(supabase, subscriber);
          totalProcessed++;
          totalConflicts += result.conflicts;
          totalUpdates += result.updates;
        } catch (error) {
          console.error(`Error processing subscriber ${subscriber.email}:`, error);
          totalErrors++;
        }
      }

      offset += batchSize;
      
      if (subscribers.length < batchSize) {
        console.log('Reached end of MailerLite subscribers');
        break;
      }

    } catch (error) {
      console.error('Batch processing error:', error);
      totalErrors++;
      break;
    }
  }

  return {
    recordsProcessed: totalProcessed,
    conflictsDetected: totalConflicts,
    updatesApplied: totalUpdates,
    errors: totalErrors
  };
}

async function syncToMailerLite(supabase: any, apiKey: string, options: SyncOptions) {
  console.log('→ Starting Supabase → MailerLite sync');
  
  const { batchSize = 100, maxRecords = 1000 } = options;
  let offset = 0;
  let totalProcessed = 0;
  let totalConflicts = 0;
  let totalUpdates = 0;
  let totalErrors = 0;

  while (totalProcessed < maxRecords) {
    try {
      console.log(`Fetching clients batch: offset=${offset}, limit=${batchSize}`);
      
      // Fetch clients from Supabase
      const { data: clients, error } = await supabase
        .from('clients')
        .select('id, email, first_name, last_name, phone, city, country, mailerlite_subscriber_id, updated_at')
        .range(offset, offset + batchSize - 1)
        .order('updated_at', { ascending: false });

      if (error) {
        throw new Error(`Supabase query error: ${error.message}`);
      }

      if (!clients || clients.length === 0) {
        console.log('No more clients to process');
        break;
      }

      // Process each client
      for (const client of clients) {
        try {
          const result = await processClientSync(supabase, client, apiKey);
          totalProcessed++;
          totalConflicts += result.conflicts;
          totalUpdates += result.updates;
        } catch (error) {
          console.error(`Error processing client ${client.email}:`, error);
          totalErrors++;
        }
      }

      offset += batchSize;
      
      if (clients.length < batchSize) {
        console.log('Reached end of clients');
        break;
      }

    } catch (error) {
      console.error('Client batch processing error:', error);
      totalErrors++;
      break;
    }
  }

  return {
    recordsProcessed: totalProcessed,
    conflictsDetected: totalConflicts,
    updatesApplied: totalUpdates,
    errors: totalErrors
  };
}

async function processSubscriberSync(supabase: any, subscriber: any) {
  console.log(`Processing subscriber: ${subscriber.email}`);
  
  // Get existing client data
  const { data: existingClient } = await supabase
    .from('clients')
    .select('*')
    .eq('email', subscriber.email)
    .maybeSingle();

  const mailerLiteData = {
    email: subscriber.email,
    firstName: subscriber.fields?.name || subscriber.fields?.first_name,
    lastName: subscriber.fields?.last_name,
    phone: subscriber.fields?.phone,
    city: subscriber.fields?.city,
    country: subscriber.fields?.country,
    id: subscriber.id
  };

  let conflicts = 0;
  let updates = 0;

  if (existingClient) {
    // Apply smart sync logic
    const syncResult = await applySmartSync(existingClient, mailerLiteData);
    
    if (syncResult.hasConflicts) {
      conflicts = syncResult.conflicts.length;
      // Store conflicts in ml_outbox for now
      await storeConflicts(supabase, subscriber.email, syncResult.conflicts);
    }
    
    if (syncResult.hasUpdates) {
      // Apply updates to client
      const { error } = await supabase
        .from('clients')
        .update({
          ...syncResult.updates,
          mailerlite_subscriber_id: subscriber.id,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingClient.id);
        
      if (!error) {
        updates = 1;
      }
    }
  } else {
    // Create new client record
    const { error } = await supabase
      .from('clients')
      .insert({
        email: subscriber.email,
        first_name: mailerLiteData.firstName,
        last_name: mailerLiteData.lastName,
        phone: mailerLiteData.phone,
        city: mailerLiteData.city,
        country: mailerLiteData.country,
        mailerlite_subscriber_id: subscriber.id
      });
      
    if (!error) {
      updates = 1;
    }
  }

  return { conflicts, updates };
}

async function processClientSync(supabase: any, client: any, apiKey: string) {
  console.log(`Processing client: ${client.email}`);
  
  let conflicts = 0;
  let updates = 0;

  try {
    // Get MailerLite subscriber data
    const response = await fetch(`https://connect.mailerlite.com/api/subscribers?filter[email]=${client.email}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn(`Could not fetch subscriber ${client.email}: ${response.status}`);
      return { conflicts, updates };
    }

    const data = await response.json();
    const subscribers = data.data || [];
    
    if (subscribers.length === 0) {
      // Create new subscriber in MailerLite
      const createResponse = await fetch('https://connect.mailerlite.com/api/subscribers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: client.email,
          fields: {
            name: `${client.first_name || ''} ${client.last_name || ''}`.trim(),
            first_name: client.first_name,
            last_name: client.last_name,
            phone: client.phone,
            city: client.city,
            country: client.country
          }
        })
      });
      
      if (createResponse.ok) {
        const newSubscriber = await createResponse.json();
        // Update client with MailerLite ID
        await supabase
          .from('clients')
          .update({ mailerlite_subscriber_id: newSubscriber.data.id })
          .eq('id', client.id);
        updates = 1;
      }
    } else {
      // Update existing subscriber
      const subscriber = subscribers[0];
      const syncResult = await applySmartSync(client, {
        email: subscriber.email,
        firstName: subscriber.fields?.first_name,
        lastName: subscriber.fields?.last_name,
        phone: subscriber.fields?.phone,
        city: subscriber.fields?.city,
        country: subscriber.fields?.country,
        id: subscriber.id
      });
      
      if (syncResult.hasConflicts) {
        conflicts = syncResult.conflicts.length;
        await storeConflicts(supabase, client.email, syncResult.conflicts);
      }
      
      if (syncResult.hasUpdates) {
        // Update MailerLite subscriber
        const updateResponse = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriber.id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            fields: syncResult.updates
          })
        });
        
        if (updateResponse.ok) {
          updates = 1;
        }
      }
    }
  } catch (error) {
    console.error(`Error syncing client ${client.email}:`, error);
  }

  return { conflicts, updates };
}

function applySmartSync(clientData: any, mailerLiteData: any) {
  const conflicts: FieldConflict[] = [];
  const updates: any = {};
  
  // Field mappings
  const fieldMappings = {
    'first_name': 'firstName',
    'last_name': 'lastName',
    'phone': 'phone',
    'city': 'city',
    'country': 'country'
  };

  for (const [clientField, mlField] of Object.entries(fieldMappings)) {
    const clientValue = normalize(clientData[clientField]);
    const mlValue = normalize(mailerLiteData[mlField]);
    
    // Smart sync rules
    if (clientValue === null && mlValue !== null) {
      // Client empty, MailerLite has value → fill client
      updates[clientField] = mailerLiteData[mlField];
    } else if (clientValue !== null && mlValue === null) {
      // Client has value, MailerLite empty → fill MailerLite  
      updates[mlField] = clientData[clientField];
    } else if (clientValue !== null && mlValue !== null && clientValue !== mlValue) {
      // Both have different values → conflict
      conflicts.push({
        field: clientField,
        a_value: clientData[clientField],
        b_value: mailerLiteData[mlField]
      });
    }
  }
  
  return {
    hasConflicts: conflicts.length > 0,
    hasUpdates: Object.keys(updates).length > 0,
    conflicts,
    updates
  };
}

function normalize(value: any): any {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.trim().toLowerCase();
  return value;
}

async function storeConflicts(supabase: any, email: string, conflicts: FieldConflict[]) {
  const entries = conflicts.map(conflict => ({
    action: 'conflict_detected',
    entity_type: 'sync_conflict',
    payload: {
      email,
      field: conflict.field,
      a_value: conflict.a_value,
      b_value: conflict.b_value,
      detected_at: new Date().toISOString(),
      status: 'open'
    },
    status: 'pending' as const
  }));

  if (entries.length > 0) {
    await supabase.from('ml_outbox').insert(entries);
  }
}