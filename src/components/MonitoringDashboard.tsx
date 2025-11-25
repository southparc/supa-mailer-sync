import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SyncHealthIndicators } from './monitoring/SyncHealthIndicators';
import { StructuredLogsViewer } from './monitoring/StructuredLogsViewer';
import { PerformanceMetrics } from './monitoring/PerformanceMetrics';
import { StallDetectionAlerts } from './monitoring/StallDetectionAlerts';
import { BackfillProgressMonitor } from './monitoring/BackfillProgressMonitor';
import { BackfillTriggerButton } from './monitoring/BackfillTriggerButton';
import { DataQualityDashboard } from './monitoring/DataQualityDashboard';
import { Activity } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useSyncStats } from '@/hooks/useSyncStats';
import { ErrorBoundary } from './ErrorBoundary';

export const MonitoringDashboard: React.FC = () => {
  const [isBackfillRunning, setIsBackfillRunning] = useState(false);
  const { refresh: refreshStats } = useSyncStats();

  useEffect(() => {
    // Check backfill status
    const checkBackfillStatus = async () => {
      try {
        const { data } = await supabase
          .from('sync_state')
          .select('value')
          .eq('key', 'sync_status')
          .single();

        if (data?.value) {
          const status = (data.value as any).status;
          setIsBackfillRunning(status === 'running');
        }
      } catch (error) {
        console.error('Error checking backfill status:', error);
      }
    };

    checkBackfillStatus();

    // Poll every 5 seconds to refresh stats while backfill is running
    const interval = setInterval(() => {
      checkBackfillStatus();
      if (isBackfillRunning) {
        console.log('🔄 Auto-refreshing stats (backfill running)...');
        refreshStats();
      }
    }, 5000);

    // Setup realtime subscription for backfill status changes
    const channel = supabase
      .channel('monitoring-backfill-status')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'sync_state',
          filter: 'key=eq.sync_status'
        },
        () => {
          checkBackfillStatus();
          refreshStats();
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [isBackfillRunning, refreshStats]);

  return (
    <div className="space-y-6">
      {/* Backfill Controls */}
      <div className="flex justify-end">
        <ErrorBoundary fallbackTitle="Backfill Controls Error">
          <BackfillTriggerButton />
        </ErrorBoundary>
      </div>

      {/* Backfill Progress Monitor - Shows when active */}
      <ErrorBoundary fallbackTitle="Backfill Progress Error">
        <BackfillProgressMonitor />
      </ErrorBoundary>
      
      {/* Stall Detection Alerts - Always visible at top */}
      <ErrorBoundary fallbackTitle="Stall Detection Error">
        <StallDetectionAlerts />
      </ErrorBoundary>

      {/* Health Indicators */}
      <ErrorBoundary fallbackTitle="Health Indicators Error">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <CardTitle>Sync Health Overview</CardTitle>
            </div>
            <CardDescription>
              Real-time status of all synchronization operations {isBackfillRunning && '• Auto-refreshing every 5s'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SyncHealthIndicators />
          </CardContent>
        </Card>
      </ErrorBoundary>

      {/* Detailed Monitoring Tabs */}
      <Tabs defaultValue="data-quality" className="space-y-4">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="data-quality">Data Quality</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="data-quality" className="space-y-4">
          <ErrorBoundary fallbackTitle="Data Quality Dashboard Error">
            <DataQualityDashboard />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="performance" className="space-y-4">
          <ErrorBoundary fallbackTitle="Performance Metrics Error">
            <PerformanceMetrics />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <ErrorBoundary fallbackTitle="Logs Viewer Error">
            <StructuredLogsViewer />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
};
