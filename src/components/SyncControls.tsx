import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { RefreshCw, Download, Upload, Database, Mail, AlertTriangle } from "lucide-react";

interface SyncControlsProps {
  onStatsUpdate?: () => void;
}

export function SyncControls({ onStatsUpdate }: SyncControlsProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncStatus, setSyncStatus] = useState<string>("");
  const { toast } = useToast();

  const startFullSync = async () => {
    try {
      setSyncing(true);
      setSyncProgress(0);
      setSyncStatus("Initializing full sync...");

      // Call edge function to start full sync
      const { data, error } = await supabase.functions.invoke('sync-mailerlite', {
        body: { 
          syncType: 'full',
          direction: 'bidirectional'
        }
      });

      if (error) {
        throw error;
      }

      // Simulate progress updates (in real implementation, this would come from the edge function)
      const progressSteps = [
        { progress: 20, status: "Fetching MailerLite subscribers..." },
        { progress: 40, status: "Comparing with Supabase data..." },
        { progress: 60, status: "Identifying conflicts..." },
        { progress: 80, status: "Updating synchronized records..." },
        { progress: 100, status: "Sync completed successfully!" }
      ];

      for (const step of progressSteps) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        setSyncProgress(step.progress);
        setSyncStatus(step.status);
      }

      toast({
        title: "Sync Completed",
        description: "Full synchronization completed successfully.",
      });

      onStatsUpdate?.();
    } catch (error) {
      console.error('Sync error:', error);
      toast({
        title: "Sync Failed",
        description: "Failed to complete synchronization. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
      setSyncProgress(0);
      setSyncStatus("");
    }
  };

  const startIncrementalSync = async () => {
    try {
      setSyncing(true);
      setSyncStatus("Starting incremental sync...");

      const { data, error } = await supabase.functions.invoke('sync-mailerlite', {
        body: { 
          syncType: 'incremental',
          direction: 'bidirectional'
        }
      });

      if (error) {
        throw error;
      }

      toast({
        title: "Incremental Sync Completed",
        description: "Recent changes have been synchronized.",
      });

      onStatsUpdate?.();
    } catch (error) {
      console.error('Incremental sync error:', error);
      toast({
        title: "Sync Failed",
        description: "Failed to complete incremental sync. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
      setSyncStatus("");
    }
  };

  const syncFromMailerLite = async () => {
    try {
      setSyncing(true);
      setSyncProgress(0);
      setSyncStatus("Starting MailerLite import...");

      let offset = 0;
      let totalSynced = 0;
      let hasMore = true;
      const batchSize = 500;
      const maxRecords = 5000; // Start with 5k for testing

      while (hasMore) {
        setSyncStatus(`Importing batch ${Math.floor(offset/batchSize) + 1} (offset: ${offset})...`);
        
        const { data, error } = await supabase.functions.invoke('sync-mailerlite', {
          body: { 
            syncType: 'full',
            direction: 'from_mailerlite',
            batchSize,
            maxRecords,
            offset
          }
        });

        if (error) {
          console.error('Sync error:', error);
          throw new Error(error.message || 'Sync failed');
        }

        console.log('Sync response:', data);
        
        const result = data?.result || {};
        totalSynced += result.subscribersSynced || 0;
        hasMore = result.hasMore || false;
        offset = result.nextOffset || offset + batchSize;

        // Update progress (rough estimate)
        const progress = Math.min(90, (totalSynced / maxRecords) * 100);
        setSyncProgress(progress);
        setSyncStatus(`Imported ${totalSynced} subscribers so far...`);

        // If we've reached our test limit or no more data, stop
        if (totalSynced >= maxRecords || !hasMore) {
          hasMore = false;
        }
      }

      setSyncProgress(100);
      setSyncStatus("Import completed successfully!");

      toast({
        title: "Import Completed", 
        description: `Imported ${totalSynced} subscribers from MailerLite successfully.`,
      });

      onStatsUpdate?.();
    } catch (error) {
      console.error('Import error:', error);
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : "Failed to import from MailerLite. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
      setSyncProgress(0);
      setSyncStatus("");
    }
  };

  const syncToMailerLite = async () => {
    try {
      setSyncing(true);
      setSyncStatus("Exporting to MailerLite...");

      const { data, error } = await supabase.functions.invoke('sync-mailerlite', {
        body: { 
          syncType: 'full',
          direction: 'to_mailerlite'
        }
      });

      if (error) {
        throw error;
      }

      toast({
        title: "Export Completed",
        description: "Data exported to MailerLite successfully.",
      });

      onStatsUpdate?.();
    } catch (error) {
      console.error('Export error:', error);
      toast({
        title: "Export Failed",
        description: "Failed to export to MailerLite. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
      setSyncStatus("");
    }
  };

  return (
    <div className="space-y-6">
      {syncing && (
        <Alert>
          <RefreshCw className="h-4 w-4 animate-spin" />
          <AlertDescription>
            <div className="space-y-2">
              <div>{syncStatus}</div>
              {syncProgress > 0 && (
                <Progress value={syncProgress} className="w-full" />
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Bidirectional Sync */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" />
              Bidirectional Sync
            </CardTitle>
            <CardDescription>
              Synchronize data in both directions, detecting and flagging conflicts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button 
              onClick={startFullSync} 
              disabled={syncing} 
              className="w-full"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Full Sync
            </Button>
            <Button 
              onClick={startIncrementalSync} 
              disabled={syncing} 
              variant="outline"
              className="w-full"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Incremental Sync
            </Button>
          </CardContent>
        </Card>

        {/* One-way Sync */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              One-way Sync
            </CardTitle>
            <CardDescription>
              Import or export data in one direction only
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button 
              onClick={syncFromMailerLite} 
              disabled={syncing} 
              variant="outline"
              className="w-full"
            >
              <Download className="h-4 w-4 mr-2" />
              Import from MailerLite
            </Button>
            <Button 
              onClick={syncToMailerLite} 
              disabled={syncing} 
              variant="outline"
              className="w-full"
            >
              <Upload className="h-4 w-4 mr-2" />
              Export to MailerLite
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Sync Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Important Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 text-sm">
            <p><strong>Full Sync:</strong> Compares all records and identifies conflicts for manual resolution.</p>
            <p><strong>Incremental Sync:</strong> Only processes changes since the last sync.</p>
            <p><strong>One-way Sync:</strong> Overwrites data in the target system without conflict detection.</p>
          </div>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Always review conflicts before running one-way syncs to avoid data loss.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}