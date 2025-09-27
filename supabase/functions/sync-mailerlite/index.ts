import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SyncRequest {
  syncType: 'full' | 'incremental' | 'health_check';
  direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite' | 'detect_conflicts' | 'health_check';
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
    console.log('=== SYNC FUNCTION STARTED ===');
    const startTime = Date.now();
    
    // Log masked connection details for debugging
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    console.log(`Connecting to Supabase: ${supabaseUrl.substring(0, 20)}...`);
    
    const supabaseClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
    console.log('✓ Supabase client created');

    const { 
      syncType, 
      direction, 
      batchSize = 500, 
      maxRecords = 0,
      offset = 0,
      fieldMappings = []
    }: SyncRequest = await req.json();
    
    console.log(`✓ Request parsed - ${syncType} sync in ${direction} direction with batch size ${batchSize}`);

    // Handle health check requests immediately
    if (direction === 'health_check' || syncType === 'health_check') {
      console.log('→ Performing health check');
      const healthResult = await performHealthCheck(supabaseClient);
      console.log('✓ Health check completed');
      
      return new Response(
        JSON.stringify({ 
          success: true, 
          result: healthResult
        }),
        { 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200 
        },
      );
    }

    // Check initial subscriber count
    const { count: preCount } = await supabaseClient
      .from('ml_subscribers')
      .select('*', { count: 'exact', head: true });
    console.log(`Pre-sync subscriber count: ${preCount}`);

    // Initialize MailerLite API client
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY');
    if (!mailerLiteApiKey) {
      console.error('✗ MailerLite API key not found');
      throw new Error('MailerLite API key not configured');
    }
    console.log('✓ MailerLite API key found');

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
    console.log('✓ Sync options prepared');

    let result = {};

    console.log(`Executing sync direction: ${direction}`);
    switch (direction) {
      case 'from_mailerlite':
        console.log('→ Starting syncFromMailerLite');
        result = await syncFromMailerLite(supabaseClient, mailerLiteHeaders, syncOptions);
        console.log('✓ syncFromMailerLite completed');
        break;
      case 'to_mailerlite': 
        console.log('→ Starting syncToMailerLite');
        result = await syncToMailerLite(supabaseClient, mailerLiteHeaders, syncOptions);
        console.log('✓ syncToMailerLite completed');
        break;
      case 'detect_conflicts':
        console.log('→ Starting chunkedConflictDetection');
        result = await chunkedConflictDetection(supabaseClient, mailerLiteHeaders, syncOptions);
        console.log('✓ chunkedConflictDetection completed');
        break;
      case 'bidirectional':
        console.log('→ Starting bidirectionalSync');
        result = await bidirectionalSync(supabaseClient, mailerLiteHeaders, syncType, syncOptions);
        console.log('✓ bidirectionalSync completed');
        break;
    }

    console.log('→ Updating sync state...');
    // Update sync state
    await supabaseClient
      .from('ml_sync_state')
      .upsert({ 
        id: true, 
        last_full_backfill_at: new Date().toISOString(),
        last_incremental_since: new Date().toISOString()
      });
    
    console.log('✓ Sync state updated successfully');
    
    // Check final subscriber count
    const { count: postCount } = await supabaseClient
      .from('ml_subscribers')
      .select('*', { count: 'exact', head: true });
    console.log(`Post-sync subscriber count: ${postCount}`);
    console.log(`Net change: ${(postCount || 0) - (preCount || 0)} subscribers`);
    
    const executionTime = Date.now() - startTime;
    console.log(`=== SYNC FUNCTION COMPLETED in ${executionTime}ms ===`, result);

    return new Response(
      JSON.stringify({ 
        success: true, 
        result: {
          ...result,
          preCount,
          postCount,
          netChange: (postCount || 0) - (preCount || 0),
          executionTime
        }
      }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      },
    );

  } catch (error) {
    console.error('Sync error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error: error
    });
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

// Health check function to verify service readiness
async function performHealthCheck(supabaseClient: any) {
  console.log('Performing comprehensive health check...');
  
  const startTime = Date.now();
  const checks: any = {
    supabase: false,
    mailerlite: false,
    database_tables: false,
    api_keys: false
  };
  
  try {
    // Check Supabase connection and required tables
    const { data: subscriberCount, error: dbError } = await supabaseClient
      .from('ml_subscribers')
      .select('*', { count: 'exact', head: true });
      
    if (!dbError) {
      checks.supabase = true;
      checks.database_tables = true;
      console.log(`✓ Supabase connected - ${subscriberCount} subscribers in database`);
    } else {
      console.error('✗ Supabase connection failed:', dbError);
    }
    
    // Check MailerLite API
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY');
    if (mailerLiteApiKey) {
      checks.api_keys = true;
      
      const testResponse = await fetch('https://connect.mailerlite.com/api/me', { 
        headers: {
          'Authorization': `Bearer ${mailerLiteApiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'GET'
      });
      
      if (testResponse.ok) {
        checks.mailerlite = true;
        const userData = await testResponse.json();
        console.log(`✓ MailerLite API connected - Account: ${userData.data?.email || 'Unknown'}`);
      } else {
        console.error('✗ MailerLite API connection failed:', testResponse.statusText);
      }
    } else {
      console.error('✗ MailerLite API key not found');
    }
    
  } catch (error) {
    console.error('Health check error:', error);
  }
  
  const responseTime = Date.now() - startTime;
  const allChecksPass = Object.values(checks).every(check => check === true);
  
  console.log(`Health check completed in ${responseTime}ms - Status: ${allChecksPass ? 'HEALTHY' : 'UNHEALTHY'}`);
  
  return {
    status: allChecksPass ? 'healthy' : 'unhealthy',
    responseTime,
    checks,
    timestamp: new Date().toISOString()
  };
}

async function syncFromMailerLite(supabaseClient: any, headers: any, options: SyncOptions) {
  console.log(`Syncing from MailerLite to Supabase with options:`, options);
  
  let totalSynced = 0;
  let currentOffset = options.offset;
  const { batchSize, maxRecords } = options;
  let batchCount = 0;
  
  // Safety check: prevent processing beyond reasonable limits for individual requests
  // Allow larger limits for bidirectional sync but keep safety for single direction syncs
  const MAX_SAFE_OFFSET = maxRecords === 0 ? 25000 : 5000; // No limit for full sync, 5k for partial
  if (currentOffset > MAX_SAFE_OFFSET) {
    console.log(`Offset ${currentOffset} exceeds safety limit ${MAX_SAFE_OFFSET}, stopping`);
    return { 
      subscribersSynced: 0,
      groupsSynced: 0,
      hasMore: false,
      nextOffset: currentOffset
    };
  }
  
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
  const meta = subscribersData.meta || {};
  
  console.log(`Received ${subscribers.length} subscribers in batch (requested: ${batchSize})`);
  console.log(`MailerLite meta info:`, meta); // Log pagination metadata if available
  
  if (subscribers.length === 0) {
    console.log('No subscribers in response - reached end of data');
    return { 
      subscribersSynced: totalSynced,
      groupsSynced: 0,
      hasMore: false,
      nextOffset: currentOffset
    };
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

  // Batch upsert for better performance - use email as conflict resolution
  const { error } = await supabaseClient
    .from('ml_subscribers')
    .upsert(subscriberBatch, { onConflict: 'email' });

  if (error) {
    console.error('Batch upsert error:', error);
    throw new Error(`Failed to sync batch: ${error.message}`);
  }

  console.log(`✓ Successfully upserted ${subscriberBatch.length} subscribers`);

  totalSynced += subscribers.length;
  batchCount++;
  
  currentOffset += batchSize;
  
  // Return after processing exactly one batch (when maxRecords matches batchSize)
  if (maxRecords > 0 && maxRecords === batchSize) {
    console.log(`Processed single batch as requested: ${totalSynced} subscribers`);
    
    // SURGICAL FIX: Only continue if we got a FULL batch (indicates more data available)
    const hasMore = subscribers.length === batchSize && subscribers.length > 0 && currentOffset < MAX_SAFE_OFFSET;
    
    if (!hasMore && subscribers.length < batchSize) {
      console.log(`Batch incomplete (${subscribers.length}/${batchSize}) - reached end of MailerLite data`);
    } else if (!hasMore && currentOffset >= MAX_SAFE_OFFSET) {
      console.log(`Reached safety offset limit (${MAX_SAFE_OFFSET}) - stopping to prevent infinite loop`);
    }
    
    return { 
      subscribersSynced: totalSynced, 
      hasMore,
      nextOffset: currentOffset
    };
  }
  
  // Legacy behavior: continue processing if maxRecords = 0 (import all)
  if (maxRecords === 0) {
    while (subscribers.length === batchSize) {
      // Continue with additional batches for full import...
      const nextUrl = new URL('https://connect.mailerlite.com/api/subscribers');
      nextUrl.searchParams.set('limit', batchSize.toString());
      nextUrl.searchParams.set('offset', currentOffset.toString());
      
      const nextResponse = await fetch(nextUrl.toString(), { headers });
      if (!nextResponse.ok) break;
      
      const nextData = await nextResponse.json();
      const nextSubscribers = nextData.data || [];
      
      if (nextSubscribers.length === 0) break;
      
      // Process next batch...
      const nextBatch = nextSubscribers.map((subscriber: any) => {
        const mappedData = mapFields(subscriber, options.fieldMappings, 'mailerlite_to_supabase');
        return {
          ml_id: subscriber.id,
          email: subscriber.email,
          name: mappedData.name || subscriber.fields?.name || null,
          status: subscriber.status,
          consent: subscriber.opted_in_at ? 'single_opt_in' : null,
          fields: subscriber.fields || {},
          updated_at: new Date().toISOString()
        };
      });
      
      const { error: nextError } = await supabaseClient
        .from('ml_subscribers')
        .upsert(nextBatch, { onConflict: 'email' });
        
      if (nextError) {
        console.error('Next batch upsert error:', nextError);
        break;
      }
      
      totalSynced += nextSubscribers.length;
      currentOffset += batchSize;
      batchCount++;
      
      if (batchCount % 10 === 0) {
        console.log(`Progress: ${totalSynced} subscribers synced (${batchCount} batches processed)`);
      }
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
      }, { onConflict: 'ml_group_id' });
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
  console.log('Starting comprehensive bidirectional sync with full conflict detection');
  
  // First, import all data from MailerLite (no limits)
  const importOptions = { ...options, maxRecords: 0 }; // Remove any limits for import
  console.log('Step 1: Importing all data from MailerLite...');
  const fromML = await syncFromMailerLite(supabaseClient, headers, importOptions);
  
  // Then detect conflicts across all imported records
  console.log('Step 2: Detecting conflicts across all records...');
  const conflicts = await chunkedConflictDetection(supabaseClient, headers, { ...options, maxRecords: 0 });
  
  // Log all conflicts for manual resolution
  if (conflicts.conflictsDetected > 0) {
    console.log(`Found ${conflicts.conflictsDetected} conflicts, logging completed.`);
  }
  
  return {
    ...fromML,
    conflictsDetected: conflicts.conflictsDetected || 0,
    conflictsSummary: {
      total: conflicts.conflictsDetected || 0,
      recordsProcessed: conflicts.recordsProcessed || 0
    }
  };
}

async function chunkedConflictDetection(supabaseClient: any, headers: any, options: SyncOptions) {
  console.log('Starting chunked conflict detection with pagination support');
  
  const conflicts: any[] = [];
  let processedCount = 0;
  let currentOffset = options.offset || 0;
  const batchSize = Math.min(options.batchSize || 100, 100); // Smaller batches for conflict detection
  const maxRecords = options.maxRecords || 1000; // Default chunk size for conflict detection
  let supabaseSubscribers: any[] = [];
  
  while (true) {
    // Get batch of subscribers from Supabase
    const { data: subscribers, error } = await supabaseClient
      .from('ml_subscribers')
      .select('*')
      .range(currentOffset, currentOffset + batchSize - 1)
      .order('email');

    if (error) {
      console.error('Error fetching Supabase subscribers:', error);
      break;
    }

    supabaseSubscribers = subscribers || [];

    if (supabaseSubscribers.length === 0) {
      console.log('No more Supabase subscribers to process for conflict detection');
      break;
    }

    console.log(`Checking conflicts for batch ${Math.floor(currentOffset/batchSize) + 1}: ${supabaseSubscribers.length} subscribers`);

    // Check each subscriber against MailerLite
    for (const supabaseSub of supabaseSubscribers) {
      try {
        // Search for matching email in MailerLite
        const searchUrl = `https://connect.mailerlite.com/api/subscribers?filter[email]=${encodeURIComponent(supabaseSub.email)}`;
        const searchResponse = await fetch(searchUrl, { headers });
        
        if (searchResponse.ok) {
          const { data: mlSubscribers } = await searchResponse.json();
          
          if (mlSubscribers && mlSubscribers.length > 0) {
            const mlSub = mlSubscribers[0];
            const detectedConflicts = [];
            
            // Helper function to check if a value is empty (null, undefined, or empty string)
            const isEmpty = (value: any) => {
              return value === null || value === undefined || value === '';
            };
            
            // Helper function to check if values are genuinely different (both non-empty and different)
            const hasGenuineConflict = (value1: any, value2: any) => {
              return !isEmpty(value1) && !isEmpty(value2) && value1 !== value2;
            };

            // Compare name fields - only flag if both have different non-empty values
            const mlName = mlSub.fields?.name || mlSub.name || null;
            const supabaseName = supabaseSub.name || null;
            if (hasGenuineConflict(mlName, supabaseName)) {
              detectedConflicts.push({
                email: supabaseSub.email,
                field: 'name',
                supabase_value: supabaseName,
                mailerlite_value: mlName,
                conflict_type: 'value_mismatch'
              });
            }
            
            // Compare status - only flag if both have different non-empty values
            if (hasGenuineConflict(supabaseSub.status, mlSub.status)) {
              detectedConflicts.push({
                email: supabaseSub.email,
                field: 'status',
                supabase_value: supabaseSub.status,
                mailerlite_value: mlSub.status,
                conflict_type: 'value_mismatch'
              });
            }
            
            // Compare custom fields - only flag genuine conflicts
            const mlFields = mlSub.fields || {};
            const supabaseFields = supabaseSub.fields || {};
            
            // Check for field differences (excluding name which we already handled)
            const allFieldKeys = new Set([...Object.keys(mlFields), ...Object.keys(supabaseFields)]);
            for (const fieldKey of allFieldKeys) {
              if (fieldKey !== 'name' && hasGenuineConflict(mlFields[fieldKey], supabaseFields[fieldKey])) {
                detectedConflicts.push({
                  email: supabaseSub.email,
                  field: `fields.${fieldKey}`,
                  supabase_value: supabaseFields[fieldKey],
                  mailerlite_value: mlFields[fieldKey],
                  conflict_type: 'field_mismatch'
                });
              }
            }
            
            conflicts.push(...detectedConflicts);
            
            if (detectedConflicts.length > 0) {
              console.log(`Found ${detectedConflicts.length} conflicts for ${supabaseSub.email}`);
            }
          } else {
            // Subscriber exists in Supabase but not in MailerLite
            conflicts.push({
              email: supabaseSub.email,
              field: 'existence',
              supabase_value: 'exists',
              mailerlite_value: 'missing',
              conflict_type: 'missing_in_mailerlite'
            });
          }
        }
        
        processedCount++;
        
        // Add small delay to avoid rate limiting
        if (processedCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
      } catch (error) {
        console.error(`Error checking conflicts for ${supabaseSub.email}:`, error);
      }
    }
    
    currentOffset += batchSize;
    
    // Progress logging
    if (currentOffset % 500 === 0) {
      console.log(`Conflict detection progress: ${processedCount} records processed, ${conflicts.length} conflicts found`);
    }

    // Check if we've processed our chunk limit
    if (processedCount >= maxRecords) {
      console.log(`Reached chunk limit: ${maxRecords} records processed`);
      break;
    }

    // If we received fewer records than requested, we've reached the end
    if (supabaseSubscribers.length < batchSize) {
      console.log('Reached end of subscribers');
      break;
    }
  }

  // Log any conflicts found in this chunk
  if (conflicts.length > 0) {
    console.log(`Found ${conflicts.length} conflicts in this chunk, logging them...`);
    
    const conflictRecords = conflicts.map(conflict => ({
      action: 'conflict_detected',
      entity_type: 'subscriber',
      payload: conflict,
      status: 'pending',
      dedupe_key: `conflict_${conflict.email}_${conflict.field}`
    }));
    
    // Batch insert conflicts to avoid overwhelming the database
    const conflictBatches = [];
    for (let i = 0; i < conflictRecords.length; i += 50) {
      conflictBatches.push(conflictRecords.slice(i, i + 50));
    }
    
    for (const batch of conflictBatches) {
      const { error } = await supabaseClient
        .from('ml_outbox')
        .upsert(batch, { onConflict: 'dedupe_key' });
        
      if (error) {
        console.error('Error logging conflicts:', error);
      }
    }
  }

  console.log(`Conflict detection chunk completed: ${processedCount} records processed, ${conflicts.length} conflicts found`);
  
  // Check if we processed fewer records than the batch size, meaning we're at the end
  const lastBatchSize = supabaseSubscribers ? supabaseSubscribers.length : 0;
  
  return { 
    conflictsDetected: conflicts.length,
    recordsProcessed: processedCount,
    hasMore: processedCount >= maxRecords && lastBatchSize === batchSize,
    nextOffset: currentOffset
  };
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