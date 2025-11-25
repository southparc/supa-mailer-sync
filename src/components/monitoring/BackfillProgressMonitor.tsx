import React, { useEffect, useState, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { Database, CloudCog, CheckCircle2, AlertCircle, Loader2, Zap, Clock } from 'lucide-react';

interface BackfillStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  stage?: string;
  progress?: number;
  batchNumber?: number;
  totalBatches?: number;
  shadowsCreated?: number;
  totalCrosswalks?: number;
  message?: string;
  error?: string;
}

export const BackfillProgressMonitor: React.FC = () => {
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [rate, setRate] = useState<number>(0);
  const [eta, setEta] = useState<string>('');
  
  const prevShadowsRef = useRef<number>(0);
  const prevTimestampRef = useRef<number>(Date.now());

  const fetchBackfillStatus = async () => {
    try {
      const { data, error } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_status')
        .single();

      if (error) throw error;
      
      if (data?.value) {
        const newStatus = data.value as unknown as BackfillStatus;
        setStatus(newStatus);
        
        // Calculate rate and ETA if backfill is running
        if (newStatus.status === 'running' && newStatus.shadowsCreated !== undefined) {
          const now = Date.now();
          const timeDiff = (now - prevTimestampRef.current) / 1000; // seconds
          const shadowsDiff = newStatus.shadowsCreated - prevShadowsRef.current;
          
          if (timeDiff > 0 && shadowsDiff > 0) {
            const currentRate = shadowsDiff / timeDiff;
            setRate(currentRate);
            
            // Calculate ETA
            if (newStatus.totalCrosswalks) {
              const remaining = newStatus.totalCrosswalks - newStatus.shadowsCreated;
              const secondsRemaining = remaining / currentRate;
              
              if (secondsRemaining < 60) {
                setEta(`${Math.round(secondsRemaining)}s`);
              } else if (secondsRemaining < 3600) {
                const minutes = Math.floor(secondsRemaining / 60);
                const seconds = Math.round(secondsRemaining % 60);
                setEta(`${minutes}m ${seconds}s`);
              } else {
                const hours = Math.floor(secondsRemaining / 3600);
                const minutes = Math.floor((secondsRemaining % 3600) / 60);
                setEta(`${hours}h ${minutes}m`);
              }
            }
          }
          
          prevShadowsRef.current = newStatus.shadowsCreated;
          prevTimestampRef.current = now;
        }
      }
    } catch (error) {
      console.error('Error fetching backfill status:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBackfillStatus();

    // Poll every 2 seconds when running
    const interval = setInterval(() => {
      if (status?.status === 'running') {
        fetchBackfillStatus();
      }
    }, 2000);

    // Setup realtime subscription
    const channel = supabase
      .channel('backfill-status-changes')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'sync_state',
          filter: 'key=eq.sync_status'
        },
        () => {
          fetchBackfillStatus();
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [status?.status]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-32">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!status || status.status === 'idle') {
    return null;
  }

  const completionPercentage = status.progress || 0;
  const isRunning = status.status === 'running';
  const isCompleted = status.status === 'completed';
  const isFailed = status.status === 'failed';

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-background">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isRunning && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
            {isCompleted && <CheckCircle2 className="h-5 w-5 text-green-500" />}
            {isFailed && <AlertCircle className="h-5 w-5 text-destructive" />}
            <CardTitle>Backfill Progress</CardTitle>
          </div>
          <Badge variant={isRunning ? "default" : isCompleted ? "secondary" : "destructive"}>
            {status.status?.toUpperCase() || 'UNKNOWN'}
          </Badge>
        </div>
        <CardDescription>
          {status.stage || 'Synchronizing shadow records'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Overall Progress</span>
            <span className="font-semibold">{completionPercentage.toFixed(1)}%</span>
          </div>
          <Progress value={completionPercentage} className="h-3" />
        </div>

        {/* Statistics Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {status.batchNumber !== undefined && status.totalBatches !== undefined && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CloudCog className="h-3 w-3" />
                Current Batch
              </div>
              <div className="text-2xl font-bold">
                {status.batchNumber}/{status.totalBatches}
              </div>
            </div>
          )}

          {status.shadowsCreated !== undefined && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Database className="h-3 w-3" />
                Shadows Created
              </div>
              <div className="text-2xl font-bold text-primary">
                {status.shadowsCreated.toLocaleString()}
              </div>
            </div>
          )}

          {status.totalCrosswalks !== undefined && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Database className="h-3 w-3" />
                Total Crosswalks
              </div>
              <div className="text-2xl font-bold">
                {status.totalCrosswalks.toLocaleString()}
              </div>
            </div>
          )}

          {status.shadowsCreated !== undefined && status.totalCrosswalks !== undefined && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3" />
                Remaining
              </div>
              <div className="text-2xl font-bold text-muted-foreground">
                {(status.totalCrosswalks - status.shadowsCreated).toLocaleString()}
              </div>
            </div>
          )}

          {isRunning && rate > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Zap className="h-3 w-3" />
                Rate
              </div>
              <div className="text-2xl font-bold text-green-500">
                {rate.toFixed(1)}/s
              </div>
            </div>
          )}

          {isRunning && eta && (
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                ETA
              </div>
              <div className="text-2xl font-bold text-blue-500">
                {eta}
              </div>
            </div>
          )}
        </div>

        {/* Status Message */}
        {status.message && (
          <div className="text-sm text-muted-foreground border-t pt-4">
            {status.message}
          </div>
        )}

        {/* Error Message */}
        {status.error && (
          <div className="text-sm text-destructive border-t pt-4 bg-destructive/10 p-3 rounded-md">
            <strong>Error:</strong> {status.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
