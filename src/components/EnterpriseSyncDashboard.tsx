import React, { useState } from 'react';
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
  const [stats, setStats] = useState<SyncStats>({ conflicts: 0 });
  const { toast } = useToast();

  const handleSync = async (direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite') => {
    try {
      setSyncStatus('syncing');
      setSyncProgress(0);

      // Simulate progress updates
      const progressInterval = setInterval(() => {
        setSyncProgress(prev => Math.min(prev + 10, 90));
      }, 500);

      const { data, error } = await supabase.functions.invoke('enterprise-sync', {
        body: {
          direction,
          options: {
            batchSize: 100,
            maxRecords: 1000
          }
        }
      });

      clearInterval(progressInterval);
      setSyncProgress(100);

      if (error) throw error;

      setStats(prev => ({
        ...prev,
        lastSync: new Date().toISOString(),
        recordsProcessed: data.recordsProcessed,
        updatesApplied: data.updatesApplied,
        conflicts: prev.conflicts + (data.conflictsDetected || 0)
      }));

      setSyncStatus('completed');
      
      toast({
        title: "Sync Completed",
        description: `Processed ${data.recordsProcessed} records, applied ${data.updatesApplied} updates`,
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