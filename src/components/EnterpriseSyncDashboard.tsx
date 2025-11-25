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
  CheckCircle,
  CheckCircle2,
  Users,
  TrendingUp,
  Clock,
  Info
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RadialBarChart, RadialBar, PolarAngleAxis } from 'recharts';
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
  clientsProcessed?: number;
  totalClients?: number;
  summary?: {
    created?: number;
    errors?: number;
    durationSec?: number;
    finalCoverage?: string;
  };
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
          clientsProcessed: backfillData.clientsProcessed,
          totalClients: backfillData.totalClients,
          summary: backfillData.summary,
        });

        // Determine status with freshness check
        const isFresh = backfillData.lastUpdatedAt && 
          (Date.now() - new Date(backfillData.lastUpdatedAt).getTime() < 90000);

        let derivedStatus: 'idle' | 'running' | 'paused' | 'completed' | 'failed' = 'idle';

        if (backfillData.paused === true) {
          derivedStatus = 'paused';
        } else if (backfillData.status === 'completed' || backfillData.phase === 'Completed' || backfillData.phase === 'Gap fill completed') {
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

        // Show completion toast if just completed
        if (derivedStatus === 'completed' && backfillData.summary && backfillStatus !== 'completed') {
          const isGapFill = backfillData.phase?.toLowerCase().includes('gap fill');
          toast({
            title: isGapFill ? "Gap Fill Complete" : "Backfill Complete",
            description: isGapFill 
              ? `Created ${backfillData.summary.created || 0} placeholder shadows. Final coverage: ${backfillData.summary.finalCoverage || 'N/A'}`
              : `Created ${backfillData.summary.created || backfillData.shadowsCreated} shadows in ${backfillData.summary.durationSec || 0}s`,
          });
        }
      } else {
        setBackfillStatus('idle');
      }
    } catch (error) {
      console.error('Error loading backfill progress:', error);
    }
  };

  const handleSync = async (direction: 'mailerlite-to-supabase' | 'supabase-to-mailerlite' | 'bidirectional', maxRecords = 500) => {
    if (duplicates.length > 0) {
      toast({
        title: "Duplicates Detected",
        description: "Please resolve duplicate advisors before syncing.",
        variant: "destructive",
      });
      return;
    }

    const result = await runSync({ direction, maxRecords });
    if (result?.success) {
      refreshStats();
    }
  };

  const handleFullSync = async () => {
    if (duplicates.length > 0) {
      toast({
        title: "Duplicates Detected",
        description: "Please resolve duplicate advisors before syncing.",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Full Sync Started",
      description: "Fetching all subscribers from MailerLite with auto-retry (15-20 min)...",
    });

    const result = await runSync({ 
      direction: 'mailerlite-to-supabase', 
      maxRecords: 50000 // High limit to get all ~30k subscribers
    });
    
    if (result?.success) {
      refreshStats();
      loadBackfillProgress();
      toast({
        title: "Full Sync Complete",
        description: `Processed ${result.recordsProcessed} records. All subscriber statuses updated.`,
      });
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

  const handleGapFill = async () => {
    try {
      toast({
        title: "Gap Fill Started",
        description: "Creating placeholder shadows for all remaining clients...",
      });
      const { error } = await supabase.functions.invoke('fill-missing-shadows', {
        body: { batchSize: 1000 }
      });
      if (error) throw error;
      await loadBackfillProgress();
      refreshStats();
      toast({
        title: "Gap Fill Running",
        description: "Placeholders are being inserted in the background.",
      });
    } catch (error: any) {
      console.error('Gap fill error:', error);
      toast({
        title: "Gap Fill Failed",
        description: error.message || 'Could not start gap fill',
        variant: "destructive",
      });
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

  const syncCoverageData = [{ name: 'Coverage', value: syncPercentage.percentage, fill: 'hsl(var(--primary))' }];
  const dataQualityPercent = stats.shadowCount > 0 
    ? Math.round(((stats.shadowCount - stats.incompleteShadows) / stats.shadowCount) * 100) 
    : 0;
  const dataQualityData = [{ name: 'Quality', value: dataQualityPercent, fill: 'hsl(var(--chart-2))' }];

  return (
    <div className="space-y-3">
      {/* Duplicate Advisors Warning */}
      {duplicates.length > 0 && (
        <Alert variant="destructive" className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm">
            <strong>Duplicate advisors:</strong> {duplicates.map(d => `${d.name} (${d.count}x)`).join(', ')} - Resolve in Advisors tab
          </AlertDescription>
        </Alert>
      )}

      {/* Backfill Warning */}
      {needsBackfill && backfillStatus !== 'running' && (
        <Alert className="py-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between text-sm">
            <span>
              <strong>{backfillStatus === 'completed' ? 'Backfill incomplete' : 'Initial backfill required'}</strong> - 
              {syncPercentage.percentage}% coverage ({syncPercentage.clientsWithShadow}/{syncPercentage.totalClients})
            </span>
            <div className="flex items-center gap-2">
              <Button onClick={() => setShowBackfillDialog(true)} size="sm">
                {backfillStatus === 'completed' ? 'Resume' : 'Start'}
              </Button>
              <Button onClick={handleGapFill} size="sm" variant="secondary">
                Fill Missing Shadows
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Backfill/Gap-Fill Progress */}
      {backfillStatus === 'running' && (
        <Card className="py-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {backfillProgress.phase?.toLowerCase().includes('gap fill') ? 'Gap Fill' : 'Backfill'} in Progress
              </CardTitle>
              <Button onClick={handlePauseBackfill} variant="outline" size="sm">
                <Pause className="h-3 w-3 mr-1" />
                Pause
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress 
              value={
                (backfillProgress as any).clientsProcessed && (backfillProgress as any).totalClients
                  ? ((backfillProgress as any).clientsProcessed / (backfillProgress as any).totalClients) * 100
                  : (backfillProgress.shadowsCreated / stats.totalClients) * 100
              } 
              className="h-1.5" 
            />
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">Phase</p>
                <p className="font-medium truncate">{backfillProgress.phase}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Progress</p>
                <p className="font-medium">
                  {(backfillProgress as any).clientsProcessed && (backfillProgress as any).totalClients
                    ? `${(backfillProgress as any).clientsProcessed}/${(backfillProgress as any).totalClients} clients`
                    : `${backfillProgress.shadowsCreated}/${stats.totalClients}`
                  }
                </p>
              </div>
              {backfillProgress.totalBatches > 0 ? (
                <div>
                  <p className="text-muted-foreground">Batch</p>
                  <p className="font-medium">{backfillProgress.currentBatch}/{backfillProgress.totalBatches}</p>
                </div>
              ) : (backfillProgress.errors || 0) > 0 ? (
                <div>
                  <p className="text-muted-foreground">Errors</p>
                  <p className="font-medium text-destructive">{backfillProgress.errors}</p>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Backfill Diagnostics Panel */}
      {backfillProgress && backfillProgress.phase && (
        <Card className="bg-muted/50 py-1">
          <CardHeader className="pb-1">
            <CardTitle className="text-xs">Diagnostics</CardTitle>
          </CardHeader>
          <CardContent className="text-xs">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="text-muted-foreground">Status:</span> <span className="font-medium">{backfillProgress.status || 'unknown'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Batch:</span> <span className="font-medium">{backfillProgress.currentBatch}/{backfillProgress.totalBatches}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Errors:</span> <span className="font-medium">{backfillProgress.errors || 0}</span>
              </div>
            </div>
            {backfillProgress.lastError && (
              <div className="mt-1 pt-1 border-t">
                <span className="text-destructive text-xs">{backfillProgress.lastError}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Sync Status */}
      {syncing && (
        <Card className="py-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Sync in Progress</CardTitle>
              <Button onClick={stopSync} variant="outline" size="sm">
                <Pause className="h-3 w-3 mr-1" />
                Pause
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1">
            <Progress value={progress} className="h-1.5" />
            <p className="text-xs text-muted-foreground">{status}</p>
          </CardContent>
        </Card>
      )}

      {/* Quick Actions */}
      <Card className="py-2">
        <CardContent className="flex gap-2 flex-wrap pt-4">
          <Button onClick={testConnection} variant="outline" size="sm" disabled={syncing}>
            <RefreshCw className="h-3 w-3 mr-1" />
            Test
          </Button>
          <Button 
            onClick={() => setShowBackfillDialog(true)} 
            size="sm" 
            disabled={backfillStatus === 'running'}
            variant="secondary"
          >
            <Database className="h-3 w-3 mr-1" />
            {backfillStatus === 'completed' ? 'Resume' : 'Run'} Backfill
          </Button>
          <Button onClick={handleFullSync} size="sm" disabled={syncing || duplicates.length > 0}>
            <Mail className="h-3 w-3 mr-1" />
            Full Sync (w/ retry)
          </Button>
        </CardContent>
      </Card>

      {/* Compact Stats with Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {/* Sync Coverage Gauge */}
        <Card className="py-2">
          <CardContent className="flex items-center gap-3 pt-3">
            <div className="h-16 w-16">
              <RadialBarChart 
                width={64} 
                height={64} 
                innerRadius="70%" 
                outerRadius="100%" 
                data={syncCoverageData} 
                startAngle={90} 
                endAngle={-270}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar background dataKey="value" cornerRadius={10} />
                <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-xs font-bold">
                  {syncPercentage.percentage}%
                </text>
              </RadialBarChart>
            </div>
            <div className="flex-1 min-w-0">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1 cursor-help">
                      Sync Coverage
                      <Info className="h-3 w-3" />
                    </p>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <p className="font-semibold mb-1">What is Sync Coverage?</p>
                    <p className="text-xs mb-2">
                      The percentage of clients from <strong>integration_crosswalk</strong> that have shadow records created.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <strong>Why might some be missing?</strong><br/>
                      • Backfill process hasn't completed yet<br/>
                      • Invalid or malformed email addresses<br/>
                      • Client not found in MailerLite<br/>
                      • API errors during synchronization
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <p className="text-lg font-bold">{stats.shadowCount.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground truncate">of {stats.crosswalkCount.toLocaleString()}</p>
            </div>
          </CardContent>
        </Card>

        {/* Data Quality Gauge */}
        <Card className="py-2">
          <CardContent className="flex items-center gap-3 pt-3">
            <div className="h-16 w-16">
              <RadialBarChart 
                width={64} 
                height={64} 
                innerRadius="70%" 
                outerRadius="100%" 
                data={dataQualityData} 
                startAngle={90} 
                endAngle={-270}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar background dataKey="value" cornerRadius={10} />
                <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-xs font-bold">
                  {dataQualityPercent}%
                </text>
              </RadialBarChart>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-muted-foreground">Data Quality</p>
              <p className="text-lg font-bold">{stats.incompleteShadows}</p>
              <p className="text-xs text-muted-foreground">incomplete</p>
            </div>
          </CardContent>
        </Card>

        {/* Conflicts */}
        <Card className="py-2">
          <CardContent className="pt-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertCircle className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Conflicts</p>
            </div>
            <p className="text-2xl font-bold">{stats.conflictCount}</p>
            <p className="text-xs text-muted-foreground">pending</p>
          </CardContent>
        </Card>

        {/* Last Sync */}
        <Card className="py-2">
          <CardContent className="pt-3">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Last Sync</p>
            </div>
            <p className="text-sm font-bold truncate">
              {stats.lastSync ? new Date(stats.lastSync).toLocaleString('nl-NL', { 
                day: '2-digit', 
                month: '2-digit', 
                hour: '2-digit', 
                minute: '2-digit' 
              }) : 'Never'}
            </p>
            <p className="text-xs text-muted-foreground">{stats.recordsProcessed} records</p>
          </CardContent>
        </Card>
      </div>

      {/* Compact Subscription Status */}
      <Card className="py-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" />
            Subscription Status ({stats.totalClients.toLocaleString()} total)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-center">
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Active</p>
              <p className="text-lg font-bold text-green-600">{stats.statusBreakdown.active.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Unsub</p>
              <p className="text-lg font-bold text-orange-600">{stats.statusBreakdown.unsubscribed.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Bounced</p>
              <p className="text-lg font-bold text-red-600">{stats.statusBreakdown.bounced.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Spam</p>
              <p className="text-lg font-bold text-purple-600">{stats.statusBreakdown.junk.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Unconf</p>
              <p className="text-lg font-bold text-muted-foreground">{stats.statusBreakdown.unconfirmed.toLocaleString()}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <RateLimitStatus />

      {/* Main Tabs */}
      <Tabs defaultValue="sync" className="space-y-3">
        <TabsList className="grid w-full grid-cols-3 h-8">
          <TabsTrigger value="sync" className="text-xs">Sync</TabsTrigger>
          <TabsTrigger value="conflicts" className="text-xs">Conflicts ({stats.conflictCount})</TabsTrigger>
          <TabsTrigger value="diagnostic" className="text-xs">Diagnostic</TabsTrigger>
        </TabsList>

        <TabsContent value="sync" className="space-y-2">
          <Card className="py-2">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Sync Controls</CardTitle>
              <div className="flex items-center gap-1">
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
                        className="h-7 text-xs"
                      >
                        {backfillStatus === 'completed' ? 'Resume' : 'Backfill'}
                      </Button>
                      {isActuallyRunning && !resuming && (
                        <Button 
                          size="sm"
                          variant="outline"
                          onClick={handlePauseBackfill}
                          className="h-7 text-xs"
                        >
                          <Pause className="h-3 w-3 mr-1" />
                          Pause
                        </Button>
                      )}
                      {(backfillStatus === 'running' || backfillStatus === 'paused') && (
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={handleForceResume}
                          disabled={isActuallyRunning || resuming}
                          className="h-7 text-xs"
                        >
                          <Play className="h-3 w-3 mr-1" />
                          {resuming ? 'Resuming...' : 'Resume'}
                        </Button>
                      )}
                    </>
                  );
                })()}
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-2 pb-3">
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
