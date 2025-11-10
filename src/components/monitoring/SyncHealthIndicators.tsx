import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { 
  CheckCircle, 
  AlertCircle, 
  Clock, 
  RefreshCw,
  Database,
  Zap,
  TrendingUp
} from "lucide-react";

interface HealthStatus {
  backfill: {
    status: 'idle' | 'running' | 'completed' | 'paused' | 'failed';
    progress: number;
    lastRun?: string;
  };
  fullSync: {
    status: 'idle' | 'running' | 'completed' | 'failed';
    lastRun?: string;
    recordsProcessed: number;
  };
  incrementalSync: {
    status: 'idle' | 'running' | 'completed' | 'failed';
    lastRun?: string;
    updatesApplied: number;
  };
}

export const SyncHealthIndicators: React.FC = () => {
  const [health, setHealth] = useState<HealthStatus>({
    backfill: { status: 'idle', progress: 0 },
    fullSync: { status: 'idle', recordsProcessed: 0 },
    incrementalSync: { status: 'idle', updatesApplied: 0 },
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadHealthStatus();
    
    const channel = supabase
      .channel('health_monitoring')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sync_state',
          filter: 'key=eq.sync_status'
        },
        () => loadHealthStatus()
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const loadHealthStatus = async () => {
    try {
      const { data } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_status')
        .maybeSingle();

      if (data?.value) {
        const syncStatus = data.value as any;
        
        setHealth({
          backfill: {
            status: syncStatus.backfill?.status || 'idle',
            progress: syncStatus.backfill?.shadowsCreated || 0,
            lastRun: syncStatus.backfill?.lastUpdatedAt,
          },
          fullSync: {
            status: syncStatus.fullSync?.status || 'idle',
            lastRun: syncStatus.fullSync?.lastCompletedAt,
            recordsProcessed: syncStatus.fullSync?.totalProcessed || 0,
          },
          incrementalSync: {
            status: syncStatus.incrementalSync?.status || 'idle',
            lastRun: syncStatus.incrementalSync?.lastCompletedAt,
            updatesApplied: syncStatus.incrementalSync?.totalUpdated || 0,
          },
        });
      }
    } catch (error) {
      console.error('Error loading health status:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case 'paused':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      default:
        return <Database className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
      running: "default",
      completed: "secondary",
      failed: "destructive",
      paused: "outline",
      idle: "outline",
    };
    
    return (
      <Badge variant={variants[status] || "outline"}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {[1, 2, 3].map(i => (
          <Card key={i} className="animate-pulse">
            <CardHeader className="h-24 bg-muted/50" />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {/* Backfill Status */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Shadow Backfill</CardTitle>
          {getStatusIcon(health.backfill.status)}
        </CardHeader>
        <CardContent className="space-y-2">
          {getStatusBadge(health.backfill.status)}
          <div className="text-2xl font-bold">{health.backfill.progress}</div>
          <p className="text-xs text-muted-foreground">
            shadows created
          </p>
          {health.backfill.lastRun && (
            <p className="text-xs text-muted-foreground">
              Last: {new Date(health.backfill.lastRun).toLocaleString()}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Full Sync Status */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Full Sync</CardTitle>
          {getStatusIcon(health.fullSync.status)}
        </CardHeader>
        <CardContent className="space-y-2">
          {getStatusBadge(health.fullSync.status)}
          <div className="text-2xl font-bold">{health.fullSync.recordsProcessed}</div>
          <p className="text-xs text-muted-foreground">
            records processed
          </p>
          {health.fullSync.lastRun && (
            <p className="text-xs text-muted-foreground">
              Last: {new Date(health.fullSync.lastRun).toLocaleString()}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Incremental Sync Status */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Incremental Sync</CardTitle>
          {getStatusIcon(health.incrementalSync.status)}
        </CardHeader>
        <CardContent className="space-y-2">
          {getStatusBadge(health.incrementalSync.status)}
          <div className="text-2xl font-bold">{health.incrementalSync.updatesApplied}</div>
          <p className="text-xs text-muted-foreground">
            updates applied
          </p>
          {health.incrementalSync.lastRun && (
            <p className="text-xs text-muted-foreground">
              Last: {new Date(health.incrementalSync.lastRun).toLocaleString()}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
