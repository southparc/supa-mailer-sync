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

interface SyncStats {
  conflicts: number;
  lastSync?: string;
  recordsProcessed?: number;
  updatesApplied?: number;
}

const EnterpriseSyncDashboard: React.FC = () => {
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'completed'>('idle');
  const [syncProgress, setSyncProgress] = useState(0);
  const [stats, setStats] = useState<SyncStats>({ 
    conflicts: 0, 
    lastSync: undefined, 
    recordsProcessed: 0, 
    updatesApplied: 0 
  });
  const [currentClientCount, setCurrentClientCount] = useState<number>(0);
  const [subscriptionStats, setSubscriptionStats] = useState<{
    total: number;
    subscribed: number;
    unsubscribed: number;
  }>({ total: 0, subscribed: 0, unsubscribed: 0 });
  const [chunkProgress, setChunkProgress] = useState({ current: 0, total: 0 });
  const { toast } = useToast();

  // Fetch current client count on mount and after syncs
  const fetchClientCount = async () => {
    try {
      const { count } = await supabase
        .from('clients')
        .select('*', { count: 'exact', head: true });
      
      if (count !== null) {
        setCurrentClientCount(count);
      }
    } catch (error) {
      console.error('Error fetching client count:', error);
    }
  };

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
    fetchClientCount();
    fetchSubscriptionStats();
  }, []);

  // Map UI directions to backend expectations
  const mapDirection = (d: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') =>
    d === 'bidirectional' ? 'both' :
    d === 'from_mailerlite' ? 'mailerlite-to-supabase' :
    'supabase-to-mailerlite';

  const stopSync = async () => {
    try {
      // Clear the sync cursor to stop the import
      await supabase
        .from('sync_state')
        .delete()
        .eq('key', 'mailerlite:import:cursor');
      
      setSyncStatus('idle');
      setSyncProgress(0);
      setChunkProgress({ current: 0, total: 0 });
      
      toast({
        title: "Sync Stopped",
        description: "The sync has been manually stopped.",
      });
    } catch (error) {
      console.error('Failed to stop sync:', error);
      toast({
        title: "Error",
        description: "Failed to stop sync. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleSync = async (direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') => {
    if (syncStatus === 'syncing') return;
    
    try {
      setSyncStatus('syncing');
      setSyncProgress(0);
      setChunkProgress({ current: 0, total: 0 });
      
      let totalRecordsProcessed = 0;
      let totalUpdatesApplied = 0;
      let totalConflictsDetected = 0;
      let chunkCount = 0;
      const maxChunks = 20; // Safety limit
      
      // Loop until sync is complete or we hit the safety limit
      while (chunkCount < maxChunks) {
        chunkCount++;
        setChunkProgress({ current: chunkCount, total: 0 });
        
        const { data, error } = await supabase.functions.invoke('enterprise-sync', {
          body: {
            direction: mapDirection(direction),
            maxRecords: 300,
            maxDurationMs: 120000,
            dryRun: false
          }
        });

        if (error) throw error;

        const result = data || {};
        
        // Accumulate totals
        totalRecordsProcessed += result.recordsProcessed || 0;
        totalUpdatesApplied += result.updatesApplied || 0;
        totalConflictsDetected += result.conflictsDetected || 0;
        
        // Update progress - estimate based on chunk count
        setSyncProgress(Math.min((chunkCount / 10) * 100, 95));
        
        // Refresh client count after each chunk
        await fetchClientCount();
        await fetchSubscriptionStats();
        
        // Show chunk completion toast
        toast({
          title: `Chunk ${chunkCount} Completed`,
          description: `Processed ${result.recordsProcessed || 0} records in this chunk`,
        });
        
        // If sync is done or no records processed, break the loop
        if (result.done === true || (result.recordsProcessed || 0) === 0) {
          break;
        }
        
        // Small delay between chunks to prevent overwhelming
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Update final stats
      setStats(prev => ({
        ...prev,
        lastSync: new Date().toISOString(),
        recordsProcessed: prev.recordsProcessed + totalRecordsProcessed,
        updatesApplied: prev.updatesApplied + totalUpdatesApplied,
        conflicts: prev.conflicts + totalConflictsDetected
      }));

      setSyncStatus('completed');
      setSyncProgress(100);
      
      // Final completion toast
      toast({
        title: "Sync Completed",
        description: `All chunks processed! Total: ${totalRecordsProcessed} records, ${totalUpdatesApplied} updates, ${totalConflictsDetected} conflicts across ${chunkCount} chunks.`,
      });

      // Reset status after delay
      setTimeout(() => {
        setSyncStatus('idle');
        setSyncProgress(0);
        setChunkProgress({ current: 0, total: 0 });
      }, 3000);

    } catch (error) {
      console.error('Sync failed:', error);
      setSyncStatus('idle');
      setSyncProgress(0);
      setChunkProgress({ current: 0, total: 0 });
      
      toast({
        title: "Sync Failed",
        description: "Please check the logs and try again.",
        variant: "destructive",
      });
    }
  };

  const getSyncButtonProps = (direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') => {
    const configs = {
      bidirectional: {
        icon: ArrowLeftRight,
        label: 'Bidirectional Sync',
        description: '⚠️ Imports ALL MailerLite subscribers (~18k+) and creates client records',
        variant: 'default' as const
      },
      from_mailerlite: {
        icon: ArrowRight,
        label: 'Import from MailerLite',
        description: '⚠️ Imports ALL subscribers and creates new client records for each',
        variant: 'outline' as const
      },
      to_mailerlite: {
        icon: ArrowLeft,
        label: 'Export to MailerLite',
        description: 'Export existing client data from Supabase to MailerLite',
        variant: 'outline' as const
      }
    };
    return configs[direction];
  };

  const updateConflictStats = (conflictStats: { conflicts: number }) => {
    setStats(prev => ({ ...prev, conflicts: conflictStats.conflicts }));
  };

  return (
    <div className="space-y-6">
      {/* Sync Status */}
      {syncStatus !== 'idle' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Sync in Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Progress value={syncProgress} className="mb-2" />
            <p className="text-sm text-muted-foreground">
              {syncStatus === 'syncing' ? 
                `Processing chunk ${chunkProgress.current}... ${Math.round(syncProgress)}% complete` : 
                'Sync completed!'
              }
            </p>
            {syncStatus === 'syncing' && (
              <Button 
                onClick={stopSync} 
                variant="outline" 
                size="sm" 
                className="mt-2"
              >
                Stop Sync
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Total Clients</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-blue-600" />
              <span className="text-2xl font-bold">{subscriptionStats.total.toLocaleString()}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              All imported contacts
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Subscribed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              <span className="text-2xl font-bold text-green-600">{subscriptionStats.subscribed.toLocaleString()}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Active subscribers
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Unsubscribed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-600" />
              <span className="text-2xl font-bold text-red-600">{subscriptionStats.unsubscribed.toLocaleString()}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Unsubscribed/bounced
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Active Conflicts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              <span className="text-2xl font-bold">{stats.conflicts}</span>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Last Sync</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-blue-600" />
              <span className="text-sm">
                {stats.lastSync 
                  ? new Date(stats.lastSync).toLocaleString()
                  : 'Never'
                }
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Records Processed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-green-600" />
              <span className="text-2xl font-bold">{stats.recordsProcessed || 0}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Updates Applied</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-purple-600" />
              <span className="text-2xl font-bold">{stats.updatesApplied || 0}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="sync" className="space-y-4">
        <TabsList>
          <TabsTrigger value="sync">Sync Control</TabsTrigger>
          <TabsTrigger value="conflicts">
            Conflict Resolution
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
              <CardTitle>Enterprise Sync Controls</CardTitle>
              <CardDescription>
                Advanced synchronization with smart conflict detection and field-level merging.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Backfill Sync Control */}
              <div className="flex items-center justify-between p-4 border-2 border-dashed border-primary/30 rounded-lg bg-primary/5">
                <div className="flex items-center gap-3">
                  <Database className="h-5 w-5 text-primary" />
                  <div>
                    <h3 className="font-medium">Initial Backfill Sync</h3>
                    <p className="text-sm text-muted-foreground">Build crosswalk mappings and shadow snapshots for all existing records</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      setSyncStatus('syncing');
                      const { data, error } = await supabase.functions.invoke('backfill-sync');
                      if (error) throw error;
                      toast({
                        title: "Backfill Completed",
                        description: `Created ${data.crosswalkCreated} crosswalk entries and ${data.shadowsCreated} shadow snapshots`,
                      });
                    } catch (error) {
                      toast({
                        title: "Backfill Failed", 
                        description: "Check logs for details",
                        variant: "destructive"
                      });
                    } finally {
                      setSyncStatus('idle');
                    }
                  }}
                  disabled={syncStatus === 'syncing'}
                >
                  <Database className="h-4 w-4 mr-2" />
                  Run Backfill
                </Button>
              </div>

              {/* Subscription Status Backfill */}
              <div className="flex items-center justify-between p-4 border-2 border-dashed border-blue-500/30 rounded-lg bg-blue-500/5">
                <div className="flex items-center gap-3">
                  <Users className="h-5 w-5 text-blue-500" />
                  <div>
                    <h3 className="font-medium">Backfill Subscription Status</h3>
                    <p className="text-sm text-muted-foreground">Populate missing subscription status for clients with MailerLite IDs</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      setSyncStatus('syncing');
                      toast({
                        title: "Backfill Started",
                        description: "Fetching subscription status from MailerLite...",
                      });
                      const { data, error } = await supabase.functions.invoke('backfill-subscription-status');
                      if (error) throw error;
                      await fetchSubscriptionStats();
                      toast({
                        title: "Backfill Completed",
                        description: `Updated ${data.updated} subscription statuses (${data.processed} processed, ${data.errors} errors)`,
                      });
                    } catch (error: any) {
                      toast({
                        title: "Backfill Failed", 
                        description: error.message || "Check logs for details",
                        variant: "destructive"
                      });
                    } finally {
                      setSyncStatus('idle');
                    }
                  }}
                  disabled={syncStatus === 'syncing'}
                >
                  <Users className="h-4 w-4 mr-2" />
                  Backfill Subscriptions
                </Button>
              </div>

              {/* Regular Sync Controls */}
              {(['bidirectional', 'from_mailerlite', 'to_mailerlite'] as const).map((direction) => {
                const config = getSyncButtonProps(direction);
                const IconComponent = config.icon;
                
                return (
                  <div key={direction} className="flex items-center justify-between p-4 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <IconComponent className="h-5 w-5" />
                      <div>
                        <h3 className="font-medium">{config.label}</h3>
                        <p className="text-sm text-muted-foreground">{config.description}</p>
                      </div>
                    </div>
                    <Button
                      variant={config.variant}
                      onClick={() => handleSync(direction)}
                      disabled={syncStatus === 'syncing'}
                    >
                      {syncStatus === 'syncing' ? (
                        <Pause className="h-4 w-4 mr-2" />
                      ) : (
                        <Play className="h-4 w-4 mr-2" />
                      )}
                      Start Sync
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