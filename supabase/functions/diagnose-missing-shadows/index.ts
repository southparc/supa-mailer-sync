import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface DiagnosticResult {
  email: string;
  status: 'success' | 'not_found' | 'unsubscribed' | 'bounced' | 'spam' | 'rate_limited' | 'error';
  subscriber_status?: string;
  error?: string;
  has_client_id: boolean;
  has_subscriber_id: boolean;
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  async take(): Promise<void> {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const tokensToAdd = (timePassed / 1000) * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitTime = ((1 - this.tokens) / this.refillRate) * 1000;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.tokens = 1;
    }
    this.tokens -= 1;
  }
}

// MailerLite allows 120 requests per minute
const rateLimiter = new TokenBucket(120, 2); // 2 per second = 120 per minute

async function getMailerLiteSubscriber(apiKey: string, subscriberId: string): Promise<any> {
  await rateLimiter.take();
  
  const response = await fetch(`https://connect.mailerlite.com/api/subscribers/${subscriberId}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return { status: 404, error: 'Not found' };
    }
    if (response.status === 429) {
      return { status: 429, error: 'Rate limited' };
    }
    return { status: response.status, error: await response.text() };
  }

  return await response.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const mailerLiteApiKey = Deno.env.get('MAILERLITE_API_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify admin access
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check if user is admin
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { batch = 100, offset = 0 } = await req.json().catch(() => ({}));

    console.log(`Starting diagnostic batch: offset=${offset}, batch=${batch}`);

    // Find crosswalk entries without corresponding shadows
    const { data: missingEntries, error: queryError } = await supabase
      .from('integration_crosswalk')
      .select('email, a_id, b_id')
      .is('b_id', null)
      .range(offset, offset + batch - 1);

    if (queryError) {
      throw queryError;
    }

    console.log(`Found ${missingEntries?.length || 0} entries without b_id`);

    // Also check entries WITH b_id but no shadow
    const { data: allCrosswalk } = await supabase
      .from('integration_crosswalk')
      .select('email, a_id, b_id')
      .not('b_id', 'is', null)
      .range(offset, offset + batch - 1);
    
    let withBIdMissing: any[] = [];
    if (allCrosswalk) {
      const emails = allCrosswalk.map(e => e.email);
      const { data: shadows } = await supabase
        .from('sync_shadow')
        .select('email')
        .in('email', emails);
      
      const shadowEmails = new Set(shadows?.map(s => s.email) || []);
      withBIdMissing = allCrosswalk.filter(e => !shadowEmails.has(e.email));
    }

    const allMissingEntries = [...(missingEntries || []), ...withBIdMissing];
    console.log(`Total missing entries to diagnose: ${allMissingEntries.length}`);

    const results: DiagnosticResult[] = [];

    for (const entry of allMissingEntries) {
      const result: DiagnosticResult = {
        email: entry.email,
        status: 'error',
        has_client_id: !!entry.a_id,
        has_subscriber_id: !!entry.b_id,
      };

      // If no subscriber ID, try to find by email
      if (!entry.b_id) {
        await rateLimiter.take();
        const searchResponse = await fetch(
          `https://connect.mailerlite.com/api/subscribers?filter[email]=${encodeURIComponent(entry.email)}`,
          {
            headers: {
              'Authorization': `Bearer ${mailerLiteApiKey}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (searchResponse.ok) {
          const searchData = await searchResponse.json();
          if (searchData.data && searchData.data.length > 0) {
            const subscriber = searchData.data[0];
            result.status = 'success';
            result.subscriber_status = subscriber.status || 'unknown';
            
            // Update crosswalk with found subscriber ID
            await supabase
              .from('integration_crosswalk')
              .update({ b_id: subscriber.id })
              .eq('email', entry.email);
          } else {
            result.status = 'not_found';
            result.error = 'Not found in MailerLite';
          }
        } else if (searchResponse.status === 429) {
          result.status = 'rate_limited';
          result.error = 'Rate limited';
        } else {
          result.status = 'error';
          result.error = `Search failed: ${searchResponse.status}`;
        }
      } else {
        // Has subscriber ID, try to fetch it
        const subscriber = await getMailerLiteSubscriber(mailerLiteApiKey, entry.b_id);
        
        if (subscriber.status === 404) {
          result.status = 'not_found';
          result.error = 'Subscriber deleted from MailerLite';
        } else if (subscriber.status === 429) {
          result.status = 'rate_limited';
          result.error = 'Rate limited';
        } else if (subscriber.status) {
          result.status = 'error';
          result.error = subscriber.error || `Error: ${subscriber.status}`;
        } else {
          // Success
          result.status = 'success';
          result.subscriber_status = subscriber.data?.status || subscriber.status || 'unknown';
          
          if (result.subscriber_status === 'unsubscribed') {
            result.status = 'unsubscribed';
          } else if (result.subscriber_status === 'bounced') {
            result.status = 'bounced';
          } else if (result.subscriber_status === 'junk') {
            result.status = 'spam';
          }
        }
      }

      results.push(result);
    }

    // Categorize results
    const summary = {
      total: results.length,
      success: results.filter(r => r.status === 'success').length,
      unsubscribed: results.filter(r => r.status === 'unsubscribed').length,
      bounced: results.filter(r => r.status === 'bounced').length,
      spam: results.filter(r => r.status === 'spam').length,
      not_found: results.filter(r => r.status === 'not_found').length,
      rate_limited: results.filter(r => r.status === 'rate_limited').length,
      error: results.filter(r => r.status === 'error').length,
      has_client_only: results.filter(r => r.has_client_id && !r.has_subscriber_id).length,
      has_subscriber_only: results.filter(r => !r.has_client_id && r.has_subscriber_id).length,
      has_both: results.filter(r => r.has_client_id && r.has_subscriber_id).length,
    };

    console.log('Diagnostic summary:', summary);

    return new Response(
      JSON.stringify({
        success: true,
        batch: { offset, size: batch, processed: results.length },
        summary,
        results,
        recommendation: generateRecommendation(summary),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Diagnostic error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorDetails = error instanceof Error ? error.toString() : String(error);
    return new Response(
      JSON.stringify({ 
        error: errorMessage,
        details: errorDetails,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

function generateRecommendation(summary: any): string {
  const recommendations: string[] = [];

  if (summary.success > 0) {
    recommendations.push(`${summary.success} subscribers found successfully - these should have shadows created`);
  }

  if (summary.unsubscribed > 0) {
    recommendations.push(`${summary.unsubscribed} unsubscribed users found - these are valid customers and should have shadows`);
  }

  if (summary.bounced > 0) {
    recommendations.push(`${summary.bounced} bounced emails found - consider if these should be kept or cleaned up`);
  }

  if (summary.spam > 0) {
    recommendations.push(`${summary.spam} spam complaints found - these should likely be removed`);
  }

  if (summary.not_found > 0) {
    recommendations.push(`${summary.not_found} subscribers not found in MailerLite - these crosswalk entries should be deleted`);
  }

  if (summary.rate_limited > 0) {
    recommendations.push(`${summary.rate_limited} rate limited - retry these with slower processing`);
  }

  if (summary.has_client_only > 0) {
    recommendations.push(`${summary.has_client_only} have client but no MailerLite subscriber - check if they should be added to MailerLite`);
  }

  return recommendations.join('; ');
}
