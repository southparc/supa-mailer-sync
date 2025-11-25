import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { supabase } from "@/integrations/supabase/client";
import { 
  AlertCircle, 
  Mail, 
  Database, 
  XCircle, 
  AlertTriangle,
  Info,
  CheckCircle2,
  Loader2
} from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface IncompleteBreakdown {
  no_b_id: { count: number; samples: string[] };
  not_in_mailerlite: { count: number; samples: string[] };
  malformed_email: { count: number; samples: string[] };
  api_error: { count: number; samples: string[] };
  no_data: { count: number; samples: string[] };
}

interface DataQualityStats {
  totalShadows: number;
  incompleteShadows: number;
  completeShadows: number;
  dataQualityPercentage: number;
  breakdown: IncompleteBreakdown | null;
}

export const DataQualityDashboard: React.FC = () => {
  const [stats, setStats] = useState<DataQualityStats>({
    totalShadows: 0,
    incompleteShadows: 0,
    completeShadows: 0,
    dataQualityPercentage: 0,
    breakdown: null,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDataQualityStats();
  }, []);

  const loadDataQualityStats = async () => {
    try {
      setLoading(true);

      // Get shadow counts
      const [totalResult, incompleteResult] = await Promise.all([
        supabase.from('sync_shadow').select('id', { count: 'exact', head: true }),
        supabase.from('sync_shadow').select('id', { count: 'exact', head: true }).eq('validation_status', 'incomplete'),
      ]);

      const totalShadows = totalResult.count || 0;
      const incompleteShadows = incompleteResult.count || 0;
      const completeShadows = totalShadows - incompleteShadows;
      const dataQualityPercentage = totalShadows > 0 
        ? Math.round((completeShadows / totalShadows) * 100) 
        : 0;

      // Get breakdown from sync_state
      const { data: breakdownData } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'backfill_incomplete_breakdown')
        .maybeSingle();

      const breakdown = breakdownData?.value as unknown as IncompleteBreakdown | null;

      setStats({
        totalShadows,
        incompleteShadows,
        completeShadows,
        dataQualityPercentage,
        breakdown,
      });
    } catch (error) {
      console.error('Error loading data quality stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'no_b_id':
        return <Database className="h-4 w-4" />;
      case 'not_in_mailerlite':
        return <XCircle className="h-4 w-4" />;
      case 'malformed_email':
        return <AlertTriangle className="h-4 w-4" />;
      case 'api_error':
        return <AlertCircle className="h-4 w-4" />;
      case 'no_data':
        return <Mail className="h-4 w-4" />;
      default:
        return <Info className="h-4 w-4" />;
    }
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'no_b_id':
        return 'Missing MailerLite ID';
      case 'not_in_mailerlite':
        return 'Not Found in MailerLite';
      case 'malformed_email':
        return 'Invalid Email Format';
      case 'api_error':
        return 'API Error';
      case 'no_data':
        return 'Empty API Response';
      default:
        return category;
    }
  };

  const getCategoryDescription = (category: string) => {
    switch (category) {
      case 'no_b_id':
        return 'Crosswalk records exist but lack a MailerLite subscriber ID (b_id). These clients are in Supabase but not properly linked to MailerLite.';
      case 'not_in_mailerlite':
        return 'Email addresses that do not exist in MailerLite. The subscriber may have been deleted or never existed in MailerLite.';
      case 'malformed_email':
        return 'Email addresses that have invalid formats and cannot be processed by MailerLite API.';
      case 'api_error':
        return 'MailerLite API returned an error when trying to fetch subscriber data. This could be due to rate limits or temporary service issues.';
      case 'no_data':
        return 'MailerLite API returned successfully but with no subscriber data. The record might exist but lack complete information.';
      default:
        return 'Unknown category';
    }
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'no_b_id':
        return 'text-orange-500';
      case 'not_in_mailerlite':
        return 'text-red-500';
      case 'malformed_email':
        return 'text-yellow-500';
      case 'api_error':
        return 'text-purple-500';
      case 'no_data':
        return 'text-blue-500';
      default:
        return 'text-muted-foreground';
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              Complete Shadows
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-500">
              {stats.completeShadows.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.dataQualityPercentage}% of total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-orange-500" />
              Incomplete Shadows
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-orange-500">
              {stats.incompleteShadows.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {100 - stats.dataQualityPercentage}% of total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              Total Shadows
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {stats.totalShadows.toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Shadow records created
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Sync Coverage Explanation */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription className="space-y-2">
          <div className="font-semibold">Understanding Sync Coverage vs. Data Quality</div>
          <div className="text-sm space-y-1">
            <p>
              <strong>Sync Coverage (74%):</strong> The percentage of clients (from integration_crosswalk) that have shadow records created. 
              This shows {stats.totalShadows.toLocaleString()} shadows exist out of the total client base.
            </p>
            <p>
              <strong>Data Quality ({stats.dataQualityPercentage}%):</strong> The percentage of existing shadow records that have complete MailerLite data. 
              {stats.completeShadows.toLocaleString()} shadows have all required fields populated.
            </p>
            <p className="text-muted-foreground italic">
              💡 A shadow is "incomplete" when it lacks MailerLite subscriber data. This can happen for various reasons like missing IDs, 
              invalid emails, or API errors during the backfill process.
            </p>
          </div>
        </AlertDescription>
      </Alert>

      {/* Breakdown Details */}
      {stats.breakdown && (
        <Card>
          <CardHeader>
            <CardTitle>Incomplete Shadow Breakdown</CardTitle>
            <CardDescription>
              Detailed reasons why {stats.incompleteShadows.toLocaleString()} shadows are missing MailerLite data
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              {Object.entries(stats.breakdown).map(([category, data]) => {
                if (!data || data.count === 0) return null;
                
                return (
                  <AccordionItem key={category} value={category}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center justify-between w-full pr-4">
                        <div className="flex items-center gap-3">
                          <div className={getCategoryColor(category)}>
                            {getCategoryIcon(category)}
                          </div>
                          <div className="text-left">
                            <div className="font-semibold">{getCategoryLabel(category)}</div>
                            <div className="text-xs text-muted-foreground">
                              {getCategoryDescription(category)}
                            </div>
                          </div>
                        </div>
                        <Badge variant="secondary" className="ml-2">
                          {data.count.toLocaleString()}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="pl-10 space-y-2">
                        <div className="text-sm font-medium text-muted-foreground">
                          Sample problematic emails ({Math.min(data.samples?.length || 0, 10)} shown):
                        </div>
                        <div className="space-y-1">
                          {data.samples?.slice(0, 10).map((email, idx) => (
                            <div 
                              key={idx}
                              className="text-sm font-mono bg-muted px-3 py-2 rounded-md flex items-center gap-2"
                            >
                              <Mail className="h-3 w-3 text-muted-foreground" />
                              {email}
                            </div>
                          ))}
                        </div>
                        {data.samples && data.samples.length > 10 && (
                          <div className="text-xs text-muted-foreground italic pt-2">
                            + {(data.samples.length - 10).toLocaleString()} more emails in this category
                          </div>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>

            {stats.incompleteShadows > 0 && !Object.values(stats.breakdown).some(d => d?.count > 0) && (
              <div className="text-center py-8 text-muted-foreground">
                <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No detailed breakdown available yet</p>
                <p className="text-sm">Run the backfill process to generate diagnostic data</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};
