import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { 
  ArrowLeftRight, 
  ArrowRight, 
  ArrowLeft, 
  Play, 
  Pause, 
  AlertTriangle,
  Database,
  Mail,
  Activity,
  RefreshCw,
  CheckCircle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useSyncStats } from "@/hooks/useSyncStats";
import { useSyncOperation } from "@/hooks/useSyncOperation";
import { SyncButton } from "./SyncButton";
import EnterpriseConflictResolution from './EnterpriseConflictResolution';
import { RateLimitStatus } from './RateLimitStatus';
import { DiagnosticMissingShadows } from './DiagnosticMissingShadows';

interface Duplicate {
  name: string;
  count: number;
  ids: string;
}

interface BackfillProgress {
  phase: string;
  shadowsCreated: number;
  totalPairs: number;
  continuationCount: number;
  lastUpdatedAt: string;
}

const EnterpriseSyncDashboard: React.FC = () => {
  const { stats, syncPercentage, loading: statsLoading, refresh: refreshStats } = useSyncStats();
  const { syncing, progress, status, testConnection, runSync, stopSync } = useSyncOperation();
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [backfillStatus, setBackfillStatus] = useState<'idle' | 'running' | 'completed'>('idle');
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress>({ 
    phase: '', 
    shadowsCreated: 0, 
    totalPairs: 0,
    continuationCount: 0,
    lastUpdatedAt: ''
  });
  const [showBackfillDialog, setShowBackfillDialog] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    checkDuplicates();
    loadBackfillProgress();
    
    // Set up real-time subscription to sync_state
    const channel = supabase
      .channel('sync_state_updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sync_state',
          filter: 'key=in.(backfill_progress,full_sync_state)'
        },
        () => {
          refreshStats();
          loadBackfillProgress();
        }
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshStats]);

  const checkDuplicates = async () => {
    try {
      const { data, error } = await supabase.rpc('check_duplicate_advisors');
      if (error) throw error;
      setDuplicates(data || []);
    } catch (error) {
      console.error('Error checking duplicates:', error);
    }
  };

  const loadBackfillProgress = async () => {
    try {
      const { data } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'backfill_progress')
        .maybeSingle();

      if (data?.value) {
        const progress = data.value as any;
        setBackfillProgress({
          phase: progress.phase || '',
          shadowsCreated: progress.shadowsCreated || 0,
          totalPairs: progress.totalPairs || 0,
          continuationCount: progress.continuationCount || 0,
          lastUpdatedAt: progress.lastUpdatedAt || '',
        });
        setBackfillStatus(
          progress.phase === 'completed' ? 'completed' : 
          progress.phase ? 'running' : 'idle'
        );
      }
    } catch (error) {
      console.error('Error loading backfill progress:', error);
    }
  };

  const handleSync = async (direction: 'mailerlite-to-supabase' | 'supabase-to-mailerlite' | 'bidirectional') => {
    if (duplicates.length > 0) {
      toast({
        title: "Duplicates Detected",
        description: "Please resolve duplicate advisors before syncing.",
        variant: "destructive",
      });
      return;
    }

    const result = await runSync({ direction, maxRecords: 500 });
    if (result?.success) {
      refreshStats();
    }
  };

  const handleBackfill = async () => {
    try {
      setBackfillStatus('running');
      setShowBackfillDialog(false);
      
      toast({
        title: "Backfill Started",
        description: "Creating shadow records and crosswalk mappings...",
      });

      const { data, error } = await supabase.functions.invoke('backfill-sync', {
        body: { autoContinue: true }
      });

      if (error) throw error;

      const result = data?.result || {};
      
      toast({
        title: "Backfill Completed",
        description: `Created ${result.shadowsCreated || 0} shadows and ${result.crosswalksCreated || 0} crosswalks`,
      });

      setBackfillStatus('completed');
      refreshStats();
      loadBackfillProgress();
    } catch (error: any) {
      console.error('Backfill error:', error);
      toast({
        title: "Backfill Failed",
        description: error.message || 'An error occurred during backfill',
        variant: "destructive",
      });
      setBackfillStatus('idle');
    }
  };

  const handlePauseBackfill = async () => {
    try {
      await supabase.from('sync_state').upsert({
        key: 'backfill_paused',
        value: { paused: true, pausedAt: new Date().toISOString() }
      });
      
      toast({
        title: "Backfill Paused",
        description: "The backfill will stop after the current batch.",
      });
    } catch (error: any) {
      console.error('Error pausing backfill:', error);
      toast({
        title: "Error",
        description: "Failed to pause backfill",
        variant: "destructive",
      });
    }
  };

  const getSyncButtonProps = (direction: string) => {
    switch (direction) {
      case 'mailerlite-to-supabase':
        return {
          icon: ArrowRight,
          label: 'MailerLite → Supabase',
          description: 'Import data from MailerLite',
          variant: 'default' as const
        };
      case 'supabase-to-mailerlite':
        return {
          icon: ArrowLeft,
          label: 'Supabase → MailerLite',
          description: 'Export data to MailerLite',
          variant: 'secondary' as const
        };
      case 'bidirectional':
        return {
          icon: ArrowLeftRight,
          label: 'Bidirectional Sync',
          description: 'Two-way synchronization',
          variant: 'outline' as const
        };
      default:
        return {
          icon: Activity,
          label: 'Sync',
          description: '',
          variant: 'default' as const
        };
    }
  };

  const needsBackfill = stats.totalClients > 0 && syncPercentage.percentage < 50;

  return (
    <div className="space-y-6">
      {/* Duplicate Advisors Warning */}
      {duplicates.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Duplicate advisors detected:</strong> {duplicates.map(d => `${d.name} (${d.count}x)`).join(', ')}
            <br />
            <span className="text-sm">Resolve duplicates in the Advisors tab before syncing.</span>
          </AlertDescription>
        </Alert>
      )}

      {/* Backfill Warning */}
      {needsBackfill && backfillStatus !== 'running' && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <div>
              <strong>Initial backfill required</strong>
              <p className="text-sm mt-1">
                Only {syncPercentage.percentage}% of clients have shadow records ({syncPercentage.clientsWithShadow}/{syncPercentage.totalClients}).
                Run backfill to create initial sync state.
              </p>
            </div>
            <Button onClick={() => setShowBackfillDialog(true)} size="sm">
              Start Backfill
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Backfill Progress */}
      {backfillStatus === 'running' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Backfill in Progress</span>
              <Button onClick={handlePauseBackfill} variant="outline" size="sm">
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </Button>
            </CardTitle>
            <CardDescription>
              Creating shadow records and crosswalk mappings...
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <Progress value={(backfillProgress.shadowsCreated / stats.totalClients) * 100} />
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Phase</p>
                  <p className="font-medium">{backfillProgress.phase}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Progress</p>
                  <p className="font-medium">
                    {backfillProgress.shadowsCreated} / {stats.totalClients} shadows
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sync Status */}
      {syncing && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Sync in Progress</span>
              <Button onClick={stopSync} variant="outline" size="sm">
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Progress value={progress} />
              <p className="text-sm text-muted-foreground">{status}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Connection Test */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Connection Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={testConnection} variant="outline" disabled={syncing}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Test Connection
          </Button>
        </CardContent>
      </Card>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Database className="h-4 w-4" />
              Total Clients
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalClients}</div>
            <p className="text-xs text-muted-foreground">
              {syncPercentage.percentage}% synced
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Sync Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{syncPercentage.clientsWithShadow}</div>
            <p className="text-xs text-muted-foreground">with shadow records</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Conflicts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{stats.conflictCount}</div>
            <p className="text-xs text-muted-foreground">pending resolution</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Last Sync
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">
              {stats.lastSync 
                ? new Date(stats.lastSync).toLocaleString()
                : 'Never'
              }
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.recordsProcessed} records processed
            </p>
          </CardContent>
        </Card>
      </div>

      <RateLimitStatus />

      {/* Main Tabs */}
      <Tabs defaultValue="sync" className="space-y-6">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="sync">Synchronisatie</TabsTrigger>
          <TabsTrigger value="conflicts">Conflicten ({stats.conflictCount})</TabsTrigger>
          <TabsTrigger value="diagnostic">Diagnostic</TabsTrigger>
        </TabsList>

        <TabsContent value="sync" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Sync Controls</CardTitle>
              <CardDescription>
                Choose sync direction to synchronize data
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SyncButton
                onClick={() => handleSync('mailerlite-to-supabase')}
                disabled={syncing || duplicates.length > 0}
                loading={syncing}
                {...getSyncButtonProps('mailerlite-to-supabase')}
              />
              <SyncButton
                onClick={() => handleSync('supabase-to-mailerlite')}
                disabled={syncing || duplicates.length > 0}
                loading={syncing}
                {...getSyncButtonProps('supabase-to-mailerlite')}
              />
              <SyncButton
                onClick={() => handleSync('bidirectional')}
                disabled={syncing || duplicates.length > 0}
                loading={syncing}
                {...getSyncButtonProps('bidirectional')}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="conflicts">
          <EnterpriseConflictResolution onStatsUpdate={(conflictStats) => {
            refreshStats();
          }} />
        </TabsContent>

        <TabsContent value="diagnostic">
          <DiagnosticMissingShadows />
        </TabsContent>
      </Tabs>

      {/* Backfill Confirmation Dialog */}
      <AlertDialog open={showBackfillDialog} onOpenChange={setShowBackfillDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start Initial Backfill?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create shadow records and crosswalk mappings for all {stats.totalClients} clients.
              This process may take several minutes and will:
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>Create sync_shadow entries for change tracking</li>
                <li>Create integration_crosswalk mappings</li>
                <li>Fetch data from MailerLite API</li>
              </ul>
              <p className="mt-2 font-semibold">
                You can pause the backfill at any time.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleBackfill}>
              Start Backfill
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default EnterpriseSyncDashboard;
