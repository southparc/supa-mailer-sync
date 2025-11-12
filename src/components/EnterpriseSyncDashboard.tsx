import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { 
  ArrowLeftRight, 
  ArrowRight, 
  ArrowLeft, 
  Play, 
  Pause, 
  AlertTriangle,
  AlertCircle,
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
  currentBatch: number;
  totalBatches: number;
  lastUpdatedAt: string;
  status?: 'running' | 'completed' | 'paused' | 'failed' | 'idle';
  lastError?: string;
  pauseReason?: string;
  errors?: number;
  startedAt?: string;
  completedAt?: string;
  paused?: boolean;
}

const EnterpriseSyncDashboard: React.FC = () => {
  const { stats, syncPercentage, loading: statsLoading, refresh: refreshStats } = useSyncStats();
  const { syncing, progress, status, testConnection, runSync, stopSync } = useSyncOperation();
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [backfillStatus, setBackfillStatus] = useState<'idle' | 'running' | 'paused' | 'completed' | 'failed'>('idle');
  const [resuming, setResuming] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress>({
    phase: '', 
    shadowsCreated: 0,
    currentBatch: 0,
    totalBatches: 0,
    lastUpdatedAt: '',
    errors: 0
  });
  const [showBackfillDialog, setShowBackfillDialog] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    checkDuplicates();
    loadBackfillProgress();
    
    // Set up real-time subscription to sync_status (consolidated state from Phase 1)
    const channel = supabase
      .channel('sync_state_updates')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sync_state',
          filter: 'key=eq.sync_status'
        },
        () => {
          console.log('📡 Sync status updated via realtime');
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
      // Read from consolidated sync_status (Phase 1 structure)
      const { data, error } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_status')
        .maybeSingle();

      if (error) {
        console.error('Error loading sync status:', error);
        return;
      }

      if (data?.value) {
        const syncStatus = data.value as any;
        const backfillData = syncStatus.backfill || {};

        setBackfillProgress({
          phase: backfillData.phase || '',
          shadowsCreated: backfillData.shadowsCreated || 0,
          currentBatch: backfillData.currentBatch || 0,
          totalBatches: backfillData.totalBatches || 0,
          lastUpdatedAt: backfillData.lastUpdatedAt || '',
          status: backfillData.status,
          lastError: backfillData.pauseReason, // pauseReason doubles as error message
          pauseReason: backfillData.pauseReason,
          errors: backfillData.errors || 0,
          startedAt: backfillData.startedAt,
          completedAt: backfillData.completedAt,
          paused: backfillData.paused || false,
        });

        // Determine status with freshness check
        const isFresh = backfillData.lastUpdatedAt && 
          (Date.now() - new Date(backfillData.lastUpdatedAt).getTime() < 90000);

        let derivedStatus: 'idle' | 'running' | 'paused' | 'completed' | 'failed' = 'idle';

        if (backfillData.paused === true) {
          derivedStatus = 'paused';
        } else if (backfillData.status === 'completed' || backfillData.phase === 'Completed') {
          derivedStatus = 'completed';
        } else if (backfillData.status === 'failed') {
          derivedStatus = 'failed';
        } else if (backfillData.status === 'running' && isFresh) {
          derivedStatus = 'running';
        } else if (backfillData.status === 'running' && !isFresh) {
          // Stale running state
          derivedStatus = 'paused'; // Treat as paused for UI purposes
        } else if (backfillData.phase) {
          derivedStatus = 'running';
        }

        setBackfillStatus(derivedStatus);
      } else {
        setBackfillStatus('idle');
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
        title: backfillStatus === 'completed' ? "Backfill Resumed" : "Backfill Started",
        description: "Creating shadow records in bulk...",
      });

      const { data, error } = await supabase.functions.invoke('backfill-sync', {
        body: { autoContinue: true }
      });

      if (error) throw error;

      toast({
        title: "Backfill Started",
        description: "Bulk shadow creation running in background. Check progress above.",
      });

      // Refresh immediately to show updated status
      await loadBackfillProgress();
      refreshStats();
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
      // Get current sync_status
      const { data: currentData } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_status')
        .maybeSingle();

      const syncStatus = currentData?.value as any || { backfill: {}, fullSync: {}, lastSync: {}, statistics: {} };

      // Update consolidated sync_status
      const { error } = await supabase
        .from('sync_state')
        .upsert({
          key: 'sync_status',
          value: {
            ...syncStatus,
            backfill: {
              ...syncStatus.backfill,
              status: 'paused',
              paused: true,
              pauseReason: 'User paused',
              lastUpdatedAt: new Date().toISOString()
            }
          },
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      if (error) throw error;

      toast({
        title: "Backfill Paused",
        description: "The backfill process will stop gracefully.",
      });

      await loadBackfillProgress();
    } catch (error: any) {
      console.error('Error pausing backfill:', error);
      toast({
        title: "Failed to Pause",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleForceResume = async () => {
    setResuming(true);
    try {
      // Get current sync_status
      const { data: currentData } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_status')
        .maybeSingle();

      const syncStatus = currentData?.value as any || { backfill: {}, fullSync: {}, lastSync: {}, statistics: {} };

      // Update consolidated sync_status to resume
      const { error: updateError } = await supabase
        .from('sync_state')
        .upsert({
          key: 'sync_status',
          value: {
            ...syncStatus,
            backfill: {
              ...syncStatus.backfill,
              status: 'running',
              phase: syncStatus.backfill?.phase === 'Completed' 
                ? 'Bulk processing crosswalks' 
                : syncStatus.backfill?.phase || 'Initializing bulk backfill',
              paused: false,
              pauseReason: undefined,
              lastUpdatedAt: new Date().toISOString()
            }
          },
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });

      if (updateError) throw updateError;

      setBackfillStatus('running');
      
      // Invoke backfill with autoContinue
      const { error } = await supabase.functions.invoke('backfill-sync', {
        body: { autoContinue: true }
      });

      if (error) throw error;
      
      toast({
        title: "Backfill Resumed",
        description: "Bulk backfill process has been force-resumed",
      });

      await loadBackfillProgress();
    } catch (error: any) {
      console.error('Force resume error:', error);
      toast({
        title: "Resume Error",
        description: error instanceof Error ? error.message : "Failed to resume backfill",
        variant: "destructive",
      });
    } finally {
      setResuming(false);
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
              <strong>{backfillStatus === 'completed' ? 'Backfill incomplete' : 'Initial backfill required'}</strong>
              <p className="text-sm mt-1">
                Only {syncPercentage.percentage}% of clients have shadow records ({syncPercentage.clientsWithShadow}/{syncPercentage.totalClients}).
                {backfillStatus === 'completed' 
                  ? ' Resume backfill to complete sync state.' 
                  : ' Run backfill to create initial sync state.'}
              </p>
            </div>
            <Button onClick={() => setShowBackfillDialog(true)} size="sm">
              {backfillStatus === 'completed' ? 'Resume Backfill' : 'Start Backfill'}
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
                {backfillProgress.totalBatches > 0 && (
                  <div>
                    <p className="text-muted-foreground">Batch</p>
                    <p className="font-medium">
                      {backfillProgress.currentBatch} / {backfillProgress.totalBatches}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Backfill Diagnostics Panel */}
      {backfillProgress && backfillProgress.phase && (
        <Card className="bg-muted/50">
          <CardHeader>
            <CardTitle className="text-sm">Backfill Diagnostics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground">Status:</span>
                <span className="ml-2 font-medium">{backfillProgress.status || 'unknown'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Phase:</span>
                <span className="ml-2 font-medium">{backfillProgress.phase}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Batch:</span>
                <span className="ml-2 font-medium">
                  {backfillProgress.currentBatch}/{backfillProgress.totalBatches}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Shadows:</span>
                <span className="ml-2 font-medium">{backfillProgress.shadowsCreated}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Errors:</span>
                <span className="ml-2 font-medium">{backfillProgress.errors || 0}</span>
              </div>
              {backfillProgress.paused && (
                <div>
                  <span className="text-muted-foreground">Paused:</span>
                  <span className="ml-2 font-medium text-yellow-600">Yes</span>
                </div>
              )}
            </div>
            {backfillProgress.lastUpdatedAt && (
              <div className="pt-2 border-t">
                <span className="text-muted-foreground">Last updated:</span>
                <span className="ml-2 text-xs">{new Date(backfillProgress.lastUpdatedAt).toLocaleString()}</span>
              </div>
            )}
            {backfillProgress.pauseReason && (
              <div className="pt-2 border-t">
                <span className="text-muted-foreground">Pause reason:</span>
                <span className="ml-2 text-xs">{backfillProgress.pauseReason}</span>
              </div>
            )}
            {backfillProgress.lastError && (
              <div className="pt-2 border-t">
                <span className="text-destructive">Last error:</span>
                <span className="ml-2 text-xs text-destructive">{backfillProgress.lastError}</span>
              </div>
            )}
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
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
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
              in database
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <CheckCircle className="h-4 w-4" />
              Shadow Records
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{syncPercentage.clientsWithShadow}</div>
            <p className="text-xs text-muted-foreground">
              {syncPercentage.percentage}% tracked
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Data Quality
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-warning">{stats.incompleteShadows}</div>
            <p className="text-xs text-muted-foreground">incomplete records</p>
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
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>Sync Controls</CardTitle>
                <CardDescription>
                  Choose sync direction to synchronize data
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const isFresh = backfillProgress.lastUpdatedAt && 
                    (Date.now() - new Date(backfillProgress.lastUpdatedAt).getTime() < 90000);
                  const isActuallyRunning = backfillStatus === 'running' && isFresh;
                  
                  return (
                    <>
                      <Button 
                        size="sm" 
                        onClick={() => setShowBackfillDialog(true)}
                        disabled={isActuallyRunning}
                      >
                        {backfillStatus === 'completed' ? 'Resume Backfill' : 'Start Backfill'}
                      </Button>
                      {isActuallyRunning && !resuming && (
                        <Button 
                          size="sm"
                          variant="outline"
                          onClick={handlePauseBackfill}
                        >
                          <Pause className="h-4 w-4 mr-2" />
                          Pause
                        </Button>
                      )}
                      {(backfillStatus === 'running' || backfillStatus === 'paused') && (
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={handleForceResume}
                          disabled={isActuallyRunning || resuming}
                        >
                          <Play className="h-4 w-4 mr-2" />
                          {resuming ? 'Resuming...' : 'Force Resume'}
                        </Button>
                      )}
                    </>
                  );
                })()}
              </div>
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
