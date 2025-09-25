import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SyncRequest {
  syncType: 'full' | 'incremental';
  direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite';
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

    const { syncType, direction }: SyncRequest = await req.json();
    
    console.log(`Starting ${syncType} sync in ${direction} direction`);

    // Initialize MailerLite API client
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY');
    if (!mailerLiteApiKey) {
      throw new Error('MailerLite API key not configured');
    }

    const mailerLiteHeaders = {
      'Authorization': `Bearer ${mailerLiteApiKey}`,
      'Content-Type': 'application/json',
    };

    let result = {};

    switch (direction) {
      case 'from_mailerlite':
        result = await syncFromMailerLite(supabaseClient, mailerLiteHeaders);
        break;
      case 'to_mailerlite': 
        result = await syncToMailerLite(supabaseClient, mailerLiteHeaders);
        break;
      case 'bidirectional':
        result = await bidirectionalSync(supabaseClient, mailerLiteHeaders, syncType);
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

async function syncFromMailerLite(supabaseClient: any, headers: any) {
  console.log('Syncing from MailerLite to Supabase');
  
  // Fetch subscribers from MailerLite
  const subscribersResponse = await fetch('https://connect.mailerlite.com/api/subscribers', {
    headers
  });
  
  if (!subscribersResponse.ok) {
    throw new Error(`MailerLite API error: ${subscribersResponse.statusText}`);
  }
  
  const { data: subscribers } = await subscribersResponse.json();
  
  // Fetch groups from MailerLite
  const groupsResponse = await fetch('https://connect.mailerlite.com/api/groups', {
    headers
  });
  
  if (!groupsResponse.ok) {
    throw new Error(`MailerLite API error: ${groupsResponse.statusText}`);
  }
  
  const { data: groups } = await groupsResponse.json();

  // Sync groups first
  for (const group of groups) {
    await supabaseClient
      .from('ml_groups')
      .upsert({
        ml_group_id: group.id,
        name: group.name,
        updated_at: new Date().toISOString()
      });
  }

  // Sync subscribers
  for (const subscriber of subscribers) {
    await supabaseClient
      .from('ml_subscribers')
      .upsert({
        ml_id: subscriber.id,
        email: subscriber.email,
        name: subscriber.fields?.name || null,
        status: subscriber.status,
        consent: subscriber.opted_in_at ? 'single_opt_in' : null,
        fields: subscriber.fields || {},
        updated_at: new Date().toISOString()
      });

    // Sync group memberships
    if (subscriber.groups && subscriber.groups.length > 0) {
      for (const group of subscriber.groups) {
        // Find the subscriber and group IDs
        const { data: subData } = await supabaseClient
          .from('ml_subscribers')
          .select('id')
          .eq('ml_id', subscriber.id)
          .single();

        const { data: groupData } = await supabaseClient
          .from('ml_groups')
          .select('id')
          .eq('ml_group_id', group.id)
          .single();

        if (subData && groupData) {
          await supabaseClient
            .from('ml_subscriber_groups')
            .upsert({
              subscriber_id: subData.id,
              group_id: groupData.id
            });
        }
      }
    }
  }

  return { 
    subscribersSynced: subscribers.length,
    groupsSynced: groups.length 
  };
}

async function syncToMailerLite(supabaseClient: any, headers: any) {
  console.log('Syncing from Supabase to MailerLite');
  
  // Get subscribers from Supabase
  const { data: subscribers, error } = await supabaseClient
    .from('ml_subscribers')
    .select('*');

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  let updatedCount = 0;

  for (const subscriber of subscribers) {
    try {
      const subscriberData = {
        email: subscriber.email,
        name: subscriber.name,
        fields: subscriber.fields || {},
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
          updatedCount++;
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
            
          updatedCount++;
        }
      }
    } catch (error) {
      console.error(`Error syncing subscriber ${subscriber.email}:`, error);
    }
  }

  return { subscribersUpdated: updatedCount };
}

async function bidirectionalSync(supabaseClient: any, headers: any, syncType: string) {
  console.log('Starting bidirectional sync');
  
  // First sync from MailerLite to get latest data
  const fromML = await syncFromMailerLite(supabaseClient, headers);
  
  // Then detect conflicts by comparing data
  const conflicts = await detectConflicts(supabaseClient, headers);
  
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

async function detectConflicts(supabaseClient: any, headers: any) {
  console.log('Detecting conflicts between MailerLite and Supabase');
  
  const conflicts = [];
  
  // Get all subscribers from both systems and compare
  const { data: supabaseSubscribers } = await supabaseClient
    .from('ml_subscribers')
    .select('*');

  const mailerLiteResponse = await fetch('https://connect.mailerlite.com/api/subscribers', {
    headers
  });
  
  const { data: mailerLiteSubscribers } = await mailerLiteResponse.json();
  
  // Create lookup map for efficient comparison
  const mlMap = new Map(mailerLiteSubscribers.map((s: any) => [s.email, s]));
  
  for (const supabaseSub of supabaseSubscribers) {
    const mlSub = mlMap.get(supabaseSub.email);
    
    if (mlSub) {
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
  
  return conflicts;
}