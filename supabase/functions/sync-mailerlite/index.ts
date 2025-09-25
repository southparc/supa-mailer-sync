import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SyncRequest {
  syncType: 'full' | 'incremental';
  direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite';
  batchSize?: number;
  maxRecords?: number;
  offset?: number;
  fieldMappings?: Array<{
    mailerlite_field: string;
    supabase_field: string;
    field_type: string;
    is_required: boolean;
    default_value?: string;
  }>;
}

interface SyncOptions {
  batchSize: number;
  maxRecords: number;
  offset: number;
  fieldMappings: any[];
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

    const { 
      syncType, 
      direction, 
      batchSize = 500, 
      maxRecords = 0,
      offset = 0,
      fieldMappings = []
    }: SyncRequest = await req.json();
    
    console.log(`Starting ${syncType} sync in ${direction} direction with batch size ${batchSize}`);

    // Initialize MailerLite API client
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY');
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured');
    }

    const mailerLiteHeaders = {
      'Authorization': `Bearer ${mailerLiteApiKey}`,
      'Content-Type': 'application/json',
    };

    const syncOptions: SyncOptions = {
      batchSize,
      maxRecords,
      offset,
      fieldMappings
    };

    let result = {};

    switch (direction) {
      case 'from_mailerlite':
        result = await syncFromMailerLite(supabaseClient, mailerLiteHeaders, syncOptions);
        break;
      case 'to_mailerlite': 
        result = await syncToMailerLite(supabaseClient, mailerLiteHeaders, syncOptions);
        break;
      case 'bidirectional':
        result = await bidirectionalSync(supabaseClient, mailerLiteHeaders, syncType, syncOptions);
        break;
    }

    // Update sync state
    await supabaseClient
      .from('ml_sync_state')
      .upsert({ 
        id: true, 
        last_full_backfill_at: new Date().toISOString(),
        last_incremental_since: new Date().toISOString()
      });

    return new Response(
      JSON.stringify({ success: true, result }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      },
    );

  } catch (error) {
    console.error('Sync error:', error);
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

async function syncFromMailerLite(supabaseClient: any, headers: any, options: SyncOptions) {
  console.log(`Syncing from MailerLite to Supabase with options:`, options);
  
  let totalSynced = 0;
  let currentOffset = options.offset;
  const { batchSize, maxRecords } = options;
  let batchCount = 0;
  
  while (true) {
    // Build MailerLite API URL with pagination
    const subscribersUrl = new URL('https://connect.mailerlite.com/api/subscribers');
    subscribersUrl.searchParams.set('limit', batchSize.toString());
    subscribersUrl.searchParams.set('offset', currentOffset.toString());
    
    console.log(`Fetching batch: offset=${currentOffset}, limit=${batchSize}`);
    
    // Fetch subscribers from MailerLite with pagination
    const subscribersResponse = await fetch(subscribersUrl.toString(), { headers });
    
    if (!subscribersResponse.ok) {
      throw new Error(`MailerLite API error: ${subscribersResponse.statusText}`);
    }
    
    const subscribersData = await subscribersResponse.json();
    const subscribers = subscribersData.data || [];
    
    console.log(`Received ${subscribers.length} subscribers in batch`);
    
    if (subscribers.length === 0) {
      console.log('No more subscribers to process');
      break;
    }

    // Process batch of subscribers with better error handling
    const subscriberBatch = [];
    for (const subscriber of subscribers) {
      const mappedData = mapFields(subscriber, options.fieldMappings, 'mailerlite_to_supabase');
      
      subscriberBatch.push({
        ml_id: subscriber.id,
        email: subscriber.email,
        name: mappedData.name || subscriber.fields?.name || null,
        status: subscriber.status,
        consent: subscriber.opted_in_at ? 'single_opt_in' : null,
        fields: subscriber.fields || {},
        updated_at: new Date().toISOString()
      });
    }

    // Batch upsert for better performance
    const { error } = await supabaseClient
      .from('ml_subscribers')
      .upsert(subscriberBatch);

    if (error) {
      console.error('Batch upsert error:', error);
      throw new Error(`Failed to sync batch: ${error.message}`);
    }

    totalSynced += subscribers.length;
    batchCount++;
    
    // Progress logging every 10 batches (for large syncs)
    if (batchCount % 10 === 0) {
      console.log(`Progress: ${totalSynced} subscribers synced (${batchCount} batches processed)`);
    }
    
    // Check if we've reached the max records limit
    if (maxRecords > 0 && totalSynced >= maxRecords) {
      console.log(`Reached max records limit: ${maxRecords}`);
      return { 
        subscribersSynced: totalSynced, 
        hasMore: subscribers.length === batchSize,
        nextOffset: currentOffset + batchSize
      };
    }

    currentOffset += batchSize;
    
    // If we received fewer records than requested, we've reached the end
    if (subscribers.length < batchSize) {
      break;
    }
  }

  // Sync groups (one-time, not paginated typically)
  const groupsResponse = await fetch('https://connect.mailerlite.com/api/groups', { headers });
  
  if (!groupsResponse.ok) {
    throw new Error(`MailerLite API error: ${groupsResponse.statusText}`);
  }
  
  const { data: groups } = await groupsResponse.json();

  for (const group of groups) {
    await supabaseClient
      .from('ml_groups')
      .upsert({
        ml_group_id: group.id,
        name: group.name,
        updated_at: new Date().toISOString()
      });
  }

  return { 
    subscribersSynced: totalSynced,
    groupsSynced: groups.length,
    hasMore: false,
    nextOffset: currentOffset
  };
}

async function syncToMailerLite(supabaseClient: any, headers: any, options: SyncOptions) {
  console.log('Syncing from Supabase to MailerLite with pagination');
  
  let totalSynced = 0;
  let currentOffset = options.offset;
  const { batchSize, maxRecords } = options;

  while (true) {
    // Get subscribers from Supabase with pagination
    const { data: subscribers, error } = await supabaseClient
      .from('ml_subscribers')
      .select('*')
      .range(currentOffset, currentOffset + batchSize - 1);

    if (error) {
      throw new Error(`Supabase error: ${error.message}`);
    }

    console.log(`Processing ${subscribers.length} subscribers from Supabase`);

    if (subscribers.length === 0) {
      break;
    }

    for (const subscriber of subscribers) {
      try {
        const mappedData = mapFields(subscriber, options.fieldMappings, 'supabase_to_mailerlite');
        
        const subscriberData = {
          email: subscriber.email,
          name: mappedData.name || subscriber.name,
          fields: { ...subscriber.fields, ...mappedData },
          status: subscriber.status
        };

        if (subscriber.ml_id) {
          // Update existing subscriber
          const response = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriber.ml_id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify(subscriberData)
          });

          if (response.ok) {
            totalSynced++;
          } else {
            console.error(`Failed to update subscriber ${subscriber.email}: ${response.statusText}`);
          }
        } else {
          // Create new subscriber
          const response = await fetch('https://connect.mailerlite.com/api/subscribers', {
            method: 'POST',
            headers,
            body: JSON.stringify(subscriberData)
          });

          if (response.ok) {
            const { data: newSubscriber } = await response.json();
            
            // Update Supabase with MailerLite ID
            await supabaseClient
              .from('ml_subscribers')
              .update({ ml_id: newSubscriber.id })
              .eq('id', subscriber.id);
              
            totalSynced++;
          } else {
            console.error(`Failed to create subscriber ${subscriber.email}: ${response.statusText}`);
          }
        }

        // Check if we've reached the max records limit
        if (maxRecords > 0 && totalSynced >= maxRecords) {
          console.log(`Reached max records limit: ${maxRecords}`);
          return { 
            subscribersUpdated: totalSynced,
            hasMore: subscribers.length === batchSize,
            nextOffset: currentOffset + batchSize
          };
        }
      } catch (error) {
        console.error(`Error syncing subscriber ${subscriber.email}:`, error);
      }
    }

    currentOffset += batchSize;
    
    // If we received fewer records than requested, we've reached the end
    if (subscribers.length < batchSize) {
      break;
    }
  }

  return { 
    subscribersUpdated: totalSynced,
    hasMore: false,
    nextOffset: currentOffset
  };
}

async function bidirectionalSync(supabaseClient: any, headers: any, syncType: string, options: SyncOptions) {
  console.log('Starting bidirectional sync with conflict detection');
  
  // First, fully sync from MailerLite (remove limits for full import)
  const fullSyncOptions = { ...options, maxRecords: 0 }; // Ensure unlimited
  const fromML = await syncFromMailerLite(supabaseClient, headers, fullSyncOptions);
  
  // Then detect conflicts on a limited subset (for performance)
  const conflictOptions = { ...options, maxRecords: 2000 }; // Limit only conflict detection
  const conflicts = await detectConflicts(supabaseClient, headers, conflictOptions);
  
  // Log conflicts for manual resolution
  for (const conflict of conflicts) {
    await supabaseClient
      .from('ml_outbox')
      .insert({
        action: 'conflict_detected',
        entity_type: 'subscriber',
        payload: conflict,
        status: 'pending'
      });
  }
  
  return {
    ...fromML,
    conflictsDetected: conflicts.length
  };
}

async function detectConflicts(supabaseClient: any, headers: any, options: SyncOptions) {
  console.log('Detecting conflicts between MailerLite and Supabase');
  
  const conflicts = [];
  const { batchSize, maxRecords } = options;
  
  // Get subscribers from Supabase (limited by our options)
  const { data: supabaseSubscribers } = await supabaseClient
    .from('ml_subscribers')
    .select('*')
    .limit(maxRecords > 0 ? Math.min(maxRecords, 1000) : 1000); // Limit conflict detection

  // Get corresponding subscribers from MailerLite
  for (const supabaseSub of supabaseSubscribers) {
    try {
      const searchResponse = await fetch(`https://connect.mailerlite.com/api/subscribers?filter[email]=${supabaseSub.email}`, {
        headers
      });
      
      if (searchResponse.ok) {
        const { data: mlSubscribers } = await searchResponse.json();
        
        if (mlSubscribers.length > 0) {
          const mlSub = mlSubscribers[0];
          
          // Compare fields and detect differences
          if (supabaseSub.name !== (mlSub as any).fields?.name) {
            conflicts.push({
              email: supabaseSub.email,
              field: 'name',
              supabase_value: supabaseSub.name,
              mailerlite_value: (mlSub as any).fields?.name,
              conflict_type: 'value_mismatch'
            });
          }
          
          if (supabaseSub.status !== (mlSub as any).status) {
            conflicts.push({
              email: supabaseSub.email,
              field: 'status', 
              supabase_value: supabaseSub.status,
              mailerlite_value: (mlSub as any).status,
              conflict_type: 'value_mismatch'
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error checking conflicts for ${supabaseSub.email}:`, error);
    }
  }
  
  return conflicts;
}

function mapFields(sourceData: any, fieldMappings: any[], direction: 'mailerlite_to_supabase' | 'supabase_to_mailerlite') {
  const mapped: any = {};
  
  if (!fieldMappings || fieldMappings.length === 0) {
    return mapped;
  }
  
  for (const mapping of fieldMappings) {
    try {
      let sourceValue;
      let targetField;
      
      if (direction === 'mailerlite_to_supabase') {
        sourceValue = getNestedValue(sourceData, mapping.mailerlite_field);
        targetField = mapping.supabase_field;
      } else {
        sourceValue = getNestedValue(sourceData, mapping.supabase_field);
        targetField = mapping.mailerlite_field;
      }
      
      // Apply default value if source is empty
      if ((sourceValue === null || sourceValue === undefined || sourceValue === '') && mapping.default_value) {
        sourceValue = mapping.default_value;
      }
      
      // Type conversion based on field type
      if (sourceValue !== null && sourceValue !== undefined) {
        switch (mapping.field_type) {
          case 'number':
            mapped[targetField] = parseFloat(sourceValue) || 0;
            break;
          case 'boolean':
            mapped[targetField] = Boolean(sourceValue);
            break;
          case 'date':
            mapped[targetField] = new Date(sourceValue).toISOString();
            break;
          default:
            mapped[targetField] = String(sourceValue);
        }
      }
    } catch (error) {
      console.error(`Error mapping field ${mapping.mailerlite_field} -> ${mapping.supabase_field}:`, error);
    }
  }
  
  return mapped;
}

function getNestedValue(obj: any, path: string) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
}