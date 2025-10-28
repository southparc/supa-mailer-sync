import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
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
  Clock,
  Users,
  CheckCircle,
  XCircle
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import EnterpriseConflictResolution from './EnterpriseConflictResolution';
import { RateLimitStatus } from './RateLimitStatus';

interface SyncStats {
  conflicts: number;
  lastSync?: string;
  recordsProcessed?: number;
  updatesApplied?: number;
}

interface SyncPercentage {
  percentage: number;
  totalMailerLite: number;
  totalSupabase: number;
  matched: number;
  lastCalculated?: string;
}

interface Duplicate {
  name: string;
  count: number;
  ids: string;
}

const EnterpriseSyncDashboard: React.FC = () => {
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'completed' | 'paused'>('idle');
  const [syncProgress, setSyncProgress] = useState(0);
  const [batchState, setBatchState] = useState<any>(null);
  const [stats, setStats] = useState<SyncStats>({ 
    conflicts: 0, 
    lastSync: undefined, 
    recordsProcessed: 0, 
    updatesApplied: 0 
  });
  const [subscriptionStats, setSubscriptionStats] = useState<{
    total: number;
    subscribed: number;
    unsubscribed: number;
  }>({ total: 0, subscribed: 0, unsubscribed: 0 });
  const [syncPercentage, setSyncPercentage] = useState<SyncPercentage>({
    percentage: 0,
    totalMailerLite: 0,
    totalSupabase: 0,
    matched: 0
  });
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const { toast } = useToast();

  const fetchSubscriptionStats = async () => {
    try {
      // Get total clients
      const { count: totalCount, error: totalError } = await supabase
        .from('clients')
        .select('*', { count: 'exact', head: true });

      if (totalError) throw totalError;

      // Get subscription counts by joining clients with mappings to satisfy RLS
      const { data: mappings, error: mappingError } = await supabase
        .from('client_group_mappings')
        .select('is_subscribed, clients!inner(*)')
        .not('clients', 'is', null);

      if (mappingError) throw mappingError;

      const subscribedCount = mappings?.filter(m => m.is_subscribed === true).length || 0;
      const unsubscribedCount = mappings?.filter(m => m.is_subscribed === false).length || 0;

      setSubscriptionStats({
        total: totalCount || 0,
        subscribed: subscribedCount,
        unsubscribed: unsubscribedCount,
      });
    } catch (error) {
      console.error('Failed to fetch subscription stats:', error);
    }
  };

  useEffect(() => {
    loadSyncStats();
    fetchSubscriptionStats();
    checkDuplicates();
    checkBatchState();
  }, []);

  const loadSyncStats = async () => {
    try {
      // Load last sync timestamp from sync_log
      const { data: logData } = await supabase
        .from('sync_log')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      // Load persistent statistics from sync_state
      const { data: statsData } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_statistics')
        .maybeSingle();
      
      // Load sync percentage from sync_state
      const { data: percentageData } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_percentage_status')
        .maybeSingle();
      
      if (logData?.created_at) {
        setStats(prev => ({
          ...prev,
          lastSync: logData.created_at
        }));
      }
      
      if (statsData?.value && typeof statsData.value === 'object') {
        const persistedStats = statsData.value as any;
        setStats(prev => ({
          ...prev,
          recordsProcessed: persistedStats.recordsProcessed || 0,
          updatesApplied: persistedStats.updatesApplied || 0,
          conflicts: persistedStats.conflicts || prev.conflicts
        }));
      }
      
      if (percentageData?.value && typeof percentageData.value === 'object') {
        const percentData = percentageData.value as any;
        setSyncPercentage({
          percentage: percentData.percentage || 0,
          totalMailerLite: percentData.totalMailerLite || 0,
          totalSupabase: percentData.totalSupabase || 0,
          matched: percentData.matched || 0,
          lastCalculated: percentData.lastCalculated
        });
      }
    } catch (error) {
      console.error('Failed to load sync stats:', error);
    }
  };

  const checkDuplicates = async () => {
    try {
      const { data, error } = await supabase.rpc('check_duplicate_advisors');
      if (error) throw error;
      setDuplicates(data || []);
    } catch (error: any) {
      console.error('Error checking duplicates:', error);
    }
  };

  const checkBatchState = async () => {
    try {
      const { data } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'full_sync_state')
        .maybeSingle();
      
      if (data?.value && typeof data.value === 'object') {
        const state = data.value as any;
        setBatchState(state);
        if (state.phase !== 'done' && state.phase !== 'init') {
          setSyncStatus('paused');
        }
      }
    } catch (error) {
      console.error('Failed to check batch state:', error);
    }
  };

  // Map UI directions to smart-sync modes
  const mapDirection = (d: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') =>
    d === 'bidirectional' ? 'bidirectional' :
    d === 'from_mailerlite' ? 'BtoA' :
    'AtoB';

  const stopSync = async () => {
    try {
      await supabase
        .from('sync_state')
        .delete()
        .eq('key', 'mailerlite:import:cursor');
      
      setSyncStatus('idle');
      setSyncProgress(0);
      
      toast({
        title: "Sync Gestopt",
        description: "De synchronisatie is handmatig gestopt.",
      });
    } catch (error) {
      console.error('Failed to stop sync:', error);
      toast({
        title: "Fout",
        description: "Kon sync niet stoppen. Probeer opnieuw.",
        variant: "destructive",
      });
    }
  };

  const handleSync = async (direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') => {
    if (syncStatus === 'syncing') {
      toast({
        title: "Sync Already Running",
        description: "Please wait for the current sync to complete.",
      });
      return;
    }
    
    console.log('Starting sync with direction:', direction, 'mapped to:', mapDirection(direction));
    
    try {
      setSyncStatus('syncing');
      setSyncProgress(10);
      
      toast({
        title: "Sync Started",
        description: `Starting ${direction} sync...`,
      });
      
      console.log('Invoking smart-sync function...');
      const { data, error } = await supabase.functions.invoke('smart-sync', {
        body: {
          mode: mapDirection(direction),
          emails: [],
          repair: false,
          dryRun: false,
          batch: true, // Enable batch mode
          maxItems: 500,
          timeBudgetMs: 45000,
          minRemaining: 60
        }
      });

      console.log('Smart-sync response:', { data, error });

      if (error) {
        console.error('Smart-sync error:', error);
        throw error;
      }

      setSyncProgress(90);
      
      const result = data || {};
      console.log('Parsed result:', result);
      
      // Check if batch was paused
      if (result.out?.paused) {
        const pauseReason = result.out.paused === 'rate-limit' ? 'Rate Limit Bereikt' : 'Batch Limiet';
        const nextRun = result.out.next_run_at ? ` (hervat om ${new Date(result.out.next_run_at).toLocaleTimeString()})` : '';
        
        setSyncStatus('idle');
        setSyncProgress(0);
        
        toast({
          title: `Sync Gepauseerd: ${pauseReason}`,
          description: `Verwerkt: ${result.out.processed || 0} records. Phase: ${result.out.phase}.${nextRun} Roep sync opnieuw aan om te hervatten.`,
        });
        return;
      }
      
      // Check if batch completed
      if (result.out?.done) {
        const syncStats = result.out.stats || {};
        const created = syncStats.created || 0;
        const updated = syncStats.updated || 0;
        const errors = syncStats.errors || 0;
        
        setStats(prev => ({
          ...prev,
          lastSync: new Date().toISOString(),
          recordsProcessed: (prev.recordsProcessed || 0) + (created + updated),
          updatesApplied: (prev.updatesApplied || 0) + created + updated,
        }));

        setSyncStatus('completed');
        setSyncProgress(100);
        
        await fetchSubscriptionStats();
        
        toast({
          title: "Batch Sync Voltooid!",
          description: `Created: ${created}, Updated: ${updated}, Errors: ${errors}`,
        });

        setTimeout(() => {
          setSyncStatus('idle');
          setSyncProgress(0);
        }, 3000);
        return;
      }
      
      const recordCount = result.count || 0;
      const syncStats = result.out?.stats || {};
      const created = syncStats.created || 0;
      const updated = syncStats.updated || 0;
      const conflicts = syncStats.conflicts || 0;
      
      setStats(prev => ({
        ...prev,
        lastSync: new Date().toISOString(),
        recordsProcessed: (prev.recordsProcessed || 0) + recordCount,
        updatesApplied: (prev.updatesApplied || 0) + created + updated,
        conflicts: (prev.conflicts || 0) + conflicts
      }));

      setSyncStatus('completed');
      setSyncProgress(100);
      
      await fetchSubscriptionStats();
      await loadSyncStats(); // Reload stats including sync percentage
      
      toast({
        title: "Sync Completed",
        description: `${recordCount} records. Created: ${created}, Updated: ${updated}, Conflicts: ${conflicts}`,
      });

      setTimeout(() => {
        setSyncStatus('idle');
        setSyncProgress(0);
      }, 3000);

    } catch (error: any) {
      console.error('Sync failed:', error);
      setSyncStatus('idle');
      setSyncProgress(0);
      
      toast({
        title: "Sync Failed",
        description: error.message || "Check console for details.",
        variant: "destructive",
      });
    }
  };

  const getSyncButtonProps = (direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') => {
    const configs = {
      bidirectional: {
        icon: ArrowLeftRight,
        label: 'Bidirectionele Sync',
        description: 'Synchroniseert in beide richtingen tussen Supabase en MailerLite',
        variant: 'default' as const
      },
      from_mailerlite: {
        icon: ArrowRight,
        label: 'Importeer van MailerLite',
        description: 'Haalt data op van MailerLite naar Supabase',
        variant: 'outline' as const
      },
      to_mailerlite: {
        icon: ArrowLeft,
        label: 'Exporteer naar MailerLite',
        description: 'Stuurt Supabase data naar MailerLite',
        variant: 'outline' as const
      }
    };
    return configs[direction];
  };

  const updateConflictStats = (conflictStats: { conflicts: number }) => {
    setStats(prev => ({ ...prev, conflicts: conflictStats.conflicts }));
  };

  const hasDuplicates = duplicates.length > 0;

  return (
    <div className="space-y-6">
      {/* Duplicate Advisors Warning */}
      {hasDuplicates && (
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Duplicate Advisors Detected
            </CardTitle>
            <CardDescription>
              Sync operations are blocked until duplicate advisors are resolved.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {duplicates.map((dup, idx) => (
                <div key={idx} className="flex items-center justify-between p-3 bg-destructive/10 rounded-lg">
                  <div>
                    <p className="font-medium">{dup.name}</p>
                    <p className="text-sm text-muted-foreground">Found {dup.count} times (IDs: {dup.ids})</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-sm text-muted-foreground mt-4">
              Please go to Advisors Management to resolve these duplicates before running sync operations.
            </p>
          </CardContent>
        </Card>
      )}
      
      {/* Sync Status */}
      {syncStatus !== 'idle' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5 animate-pulse" />
              {syncStatus === 'syncing' ? 'Synchroniseren...' : 'Sync Voltooid!'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Progress value={syncProgress} className="mb-2" />
            <p className="text-sm text-muted-foreground">
              {Math.round(syncProgress)}% voltooid
            </p>
          </CardContent>
        </Card>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Totaal Clients</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              <span className="text-2xl font-bold">{subscriptionStats.total.toLocaleString()}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {subscriptionStats.subscribed} geabonneerd, {subscriptionStats.unsubscribed} afgemeld
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Sync Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold">
                  {syncPercentage.percentage.toFixed(1)}%
                </span>
                {syncPercentage.percentage >= 95 ? (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                ) : syncPercentage.percentage >= 80 ? (
                  <AlertTriangle className="h-5 w-5 text-orange-500" />
                ) : (
                  <XCircle className="h-5 w-5 text-red-500" />
                )}
              </div>
              <Progress 
                value={syncPercentage.percentage} 
                className="h-2"
              />
              <p className="text-xs text-muted-foreground">
                {syncPercentage.matched} van {Math.max(syncPercentage.totalMailerLite, syncPercentage.totalSupabase)} records in sync
              </p>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Conflicten</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <span className="text-2xl font-bold">{stats.conflicts}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Actieve conflicten
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Laatste Sync</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" />
              <span className="text-sm">
                {stats.lastSync 
                  ? new Date(stats.lastSync).toLocaleDateString('nl-NL') + ' ' + new Date(stats.lastSync).toLocaleTimeString('nl-NL')
                  : 'Nog niet gesynchroniseerd'
                }
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Verwerkte Records</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              <span className="text-2xl font-bold">{stats.recordsProcessed || 0}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats.updatesApplied || 0} updates toegepast
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Rate Limit Monitoring */}
      <RateLimitStatus />

      <Tabs defaultValue="sync" className="space-y-4">
        <TabsList>
          <TabsTrigger value="sync">Synchronisatie</TabsTrigger>
          <TabsTrigger value="conflicts">
            Conflicten
            {stats.conflicts > 0 && (
              <Badge variant="destructive" className="ml-2">
                {stats.conflicts}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sync" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Smart Sync</CardTitle>
              <CardDescription>
                Synchroniseer data tussen Supabase en MailerLite met automatische conflict detectie.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Sync Controls */}
              {(['bidirectional', 'from_mailerlite', 'to_mailerlite'] as const).map((direction) => {
                const config = getSyncButtonProps(direction);
                const IconComponent = config.icon;
                
                return (
                  <div key={direction} className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <IconComponent className="h-5 w-5 text-primary" />
                      <div>
                        <h3 className="font-medium">{config.label}</h3>
                        <p className="text-sm text-muted-foreground">{config.description}</p>
                      </div>
                    </div>
                    <Button
                      variant={config.variant}
                      onClick={() => handleSync(direction)}
                      disabled={syncStatus === 'syncing' || hasDuplicates}
                    >
                      <Play className="h-4 w-4 mr-2" />
                      Start
                    </Button>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="conflicts">
          <EnterpriseConflictResolution onStatsUpdate={updateConflictStats} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default EnterpriseSyncDashboard;