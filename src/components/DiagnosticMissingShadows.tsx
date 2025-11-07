import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertCircle, CheckCircle, XCircle, Play, Loader2, AlertTriangle, Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface DiagnosticResult {
  email: string;
  status: string;
  hasClientId: boolean;
  hasSubscriberId: boolean;
}

interface DiagnosticSummary {
  total: number;
  success: number;
  not_found: number;
  unsubscribed: number;
  bounced: number;
  spam: number;
  junk: number;
  rate_limited: number;
  error: number;
}

interface DiagnosticResponse {
  batch: { offset: number; size: number; total: number };
  summary: DiagnosticSummary;
  results: DiagnosticResult[];
  recommendations: string;
}

export const DiagnosticMissingShadows: React.FC = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [summary, setSummary] = useState<DiagnosticSummary | null>(null);
  const [recommendations, setRecommendations] = useState<string>('');
  const { toast } = useToast();

  const runDiagnostic = async () => {
    setIsRunning(true);
    setProgress(0);
    setSummary(null);
    setRecommendations('');

    const batchSize = 100;
    let offset = 0;
    let totalProcessed = 0;
    let aggregatedSummary: DiagnosticSummary = {
      total: 0,
      success: 0,
      not_found: 0,
      unsubscribed: 0,
      bounced: 0,
      spam: 0,
      junk: 0,
      rate_limited: 0,
      error: 0
    };

    try {
      // First batch to get total count
      const { data: firstBatch, error: firstError } = await supabase.functions.invoke<DiagnosticResponse>('diagnose-missing-shadows', {
        body: { batchSize, offset: 0 }
      });

      if (firstError) throw firstError;
      if (!firstBatch) throw new Error('No data returned');

      const total = firstBatch.batch.total;
      const batches = Math.ceil(total / batchSize);
      setTotalBatches(batches);

      // Process first batch
      aggregatedSummary.total += firstBatch.summary.total;
      aggregatedSummary.success += firstBatch.summary.success;
      aggregatedSummary.not_found += firstBatch.summary.not_found;
      aggregatedSummary.unsubscribed += firstBatch.summary.unsubscribed;
      aggregatedSummary.bounced += firstBatch.summary.bounced;
      aggregatedSummary.spam += firstBatch.summary.spam;
      aggregatedSummary.junk += firstBatch.summary.junk;
      aggregatedSummary.rate_limited += firstBatch.summary.rate_limited;
      aggregatedSummary.error += firstBatch.summary.error;

      totalProcessed += firstBatch.summary.total;
      setCurrentBatch(1);
      setProgress((1 / batches) * 100);
      setSummary(aggregatedSummary);
      setRecommendations(firstBatch.recommendations);

      // Process remaining batches
      for (let i = 1; i < batches; i++) {
        offset = i * batchSize;
        
        const { data, error } = await supabase.functions.invoke<DiagnosticResponse>('diagnose-missing-shadows', {
          body: { batchSize, offset }
        });

        if (error) {
          console.error(`Batch ${i + 1} failed:`, error);
          continue;
        }

        if (data) {
          aggregatedSummary.total += data.summary.total;
          aggregatedSummary.success += data.summary.success;
          aggregatedSummary.not_found += data.summary.not_found;
          aggregatedSummary.unsubscribed += data.summary.unsubscribed;
          aggregatedSummary.bounced += data.summary.bounced;
          aggregatedSummary.spam += data.summary.spam;
          aggregatedSummary.junk += data.summary.junk;
          aggregatedSummary.rate_limited += data.summary.rate_limited;
          aggregatedSummary.error += data.summary.error;

          totalProcessed += data.summary.total;
          setCurrentBatch(i + 1);
          setProgress(((i + 1) / batches) * 100);
          setSummary({ ...aggregatedSummary });
        }

        // Rate limiting: wait 1 second between batches
        if (i < batches - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      toast({
        title: "Diagnostic Complete",
        description: `Processed ${totalProcessed} entries in ${batches} batches`,
      });

    } catch (error: any) {
      console.error('Diagnostic failed:', error);
      toast({
        title: "Diagnostic Failed",
        description: error.message || "Check console for details",
        variant: "destructive",
      });
    } finally {
      setIsRunning(false);
    }
  };

  const getStatusBadge = (count: number, label: string, variant: "default" | "secondary" | "destructive" | "outline") => {
    if (count === 0) return null;
    return (
      <Badge variant={variant} className="text-sm">
        {label}: {count}
      </Badge>
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Missing Shadows Diagnostic
            </CardTitle>
            <CardDescription>
              Analyze crosswalk entries without shadow records and check their status in MailerLite
            </CardDescription>
          </div>
          <Button
            onClick={runDiagnostic}
            disabled={isRunning}
            size="lg"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run Diagnostic
              </>
            )}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {isRunning && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Processing batch {currentBatch} of {totalBatches}
              </span>
              <span className="font-medium">{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        {summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{summary.total}</div>
                  <div className="text-xs text-muted-foreground">Total Checked</div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-green-600">{summary.success}</div>
                  <div className="text-xs text-muted-foreground">Active</div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-amber-600">{summary.unsubscribed}</div>
                  <div className="text-xs text-muted-foreground">Unsubscribed</div>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold text-red-600">{summary.not_found}</div>
                  <div className="text-xs text-muted-foreground">Not Found</div>
                </CardContent>
              </Card>
            </div>

            <div className="flex flex-wrap gap-2">
              {getStatusBadge(summary.success, 'Active', 'default')}
              {getStatusBadge(summary.unsubscribed, 'Unsubscribed', 'secondary')}
              {getStatusBadge(summary.bounced, 'Bounced', 'outline')}
              {getStatusBadge(summary.spam, 'Spam', 'outline')}
              {getStatusBadge(summary.junk, 'Junk', 'outline')}
              {getStatusBadge(summary.not_found, 'Not Found', 'destructive')}
              {getStatusBadge(summary.error, 'Error', 'destructive')}
            </div>

            {recommendations && (
              <Card className="border-primary/20 bg-primary/5">
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    Recommendations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground whitespace-pre-line">
                    {recommendations}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {!isRunning && !summary && (
          <div className="text-center py-8 text-muted-foreground">
            <AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Click "Run Diagnostic" to analyze missing shadow records</p>
            <p className="text-sm mt-2">This will check MailerLite status for crosswalk entries without shadows</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
