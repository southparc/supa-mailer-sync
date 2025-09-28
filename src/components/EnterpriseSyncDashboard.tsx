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
  Clock
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

  useEffect(() => {
    fetchClientCount();
  }, []);

  // Map UI directions to backend expectations
  const mapDirection = (d: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') =>
    d === 'bidirectional' ? 'both' :
    d === 'from_mailerlite' ? 'mailerlite-to-supabase' :
    'supabase-to-mailerlite';

  const handleSync = async (direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') => {
    try {
      setSyncStatus('syncing');
      setSyncProgress(0);

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
      
      setStats(prev => ({
        ...prev,
        lastSync: new Date().toISOString(),
        recordsProcessed: prev.recordsProcessed + (result.recordsProcessed || 0),
        updatesApplied: prev.updatesApplied + (result.updatesApplied || 0),
        conflicts: prev.conflicts + (result.conflictsDetected || 0)
      }));

      // Refresh client count
      await fetchClientCount();

      setSyncStatus('completed');
      setSyncProgress(100);
      
      toast({
        title: "Sync Completed",
        description: `Processed ${result.recordsProcessed || 0} records, applied ${result.updatesApplied || 0} updates, detected ${result.conflictsDetected || 0} conflicts.`,
      });

      // Reset status after delay
      setTimeout(() => {
        setSyncStatus('idle');
        setSyncProgress(0);
      }, 3000);

    } catch (error) {
      console.error('Sync failed:', error);
      setSyncStatus('idle');
      setSyncProgress(0);
      
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
        description: 'Smart sync both directions with conflict detection',
        variant: 'default' as const
      },
      from_mailerlite: {
        icon: ArrowRight,
        label: 'Import from MailerLite',
        description: 'Import subscriber data from MailerLite to Supabase',
        variant: 'outline' as const
      },
      to_mailerlite: {
        icon: ArrowLeft,
        label: 'Export to MailerLite',
        description: 'Export client data from Supabase to MailerLite',
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
              {syncStatus === 'syncing' ? 'Processing records...' : 'Sync completed!'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Total Clients</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-blue-600" />
              <span className="text-2xl font-bold">{currentClientCount.toLocaleString()}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Current database count
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