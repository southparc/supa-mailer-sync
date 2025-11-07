import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface SyncOptions {
  direction: 'mailerlite-to-supabase' | 'supabase-to-mailerlite' | 'bidirectional';
  maxRecords?: number;
  dryRun?: boolean;
}

interface SyncResult {
  success: boolean;
  recordsProcessed: number;
  updatesApplied: number;
  conflictsDetected: number;
  done: boolean;
  message: string;
}

export function useSyncOperation() {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const { toast } = useToast();

  const testConnection = useCallback(async (): Promise<boolean> => {
    try {
      setStatus('Testing connection...');
      const { data, error } = await supabase.functions.invoke('smart-sync', {
        body: { mode: 'AtoB', emails: [], dryRun: true }
      });

      if (error) {
        console.error('Connection test failed:', error);
        toast({
          title: 'Connection Failed',
          description: error.message || 'Unable to reach sync service',
          variant: 'destructive',
        });
        return false;
      }

      setStatus('Connection successful');
      return true;
    } catch (error: any) {
      console.error('Connection test error:', error);
      toast({
        title: 'Connection Error',
        description: error.message || 'Network error',
        variant: 'destructive',
      });
      return false;
    }
  }, [toast]);

  const runSync = useCallback(async (options: SyncOptions): Promise<SyncResult | null> => {
    try {
      setSyncing(true);
      setProgress(0);
      setStatus(`Starting ${options.direction} sync...`);

      const { data, error } = await supabase.functions.invoke('enterprise-sync', {
        body: {
          direction: options.direction,
          maxRecords: options.maxRecords || 500,
          maxDurationMs: 120000,
          dryRun: options.dryRun || false,
        }
      });

      if (error) {
        throw new Error(error.message || 'Sync failed');
      }

      const result = data || {};
      setProgress(100);
      setStatus('Sync completed');

      toast({
        title: options.dryRun ? 'Sync Preview Complete' : 'Sync Complete',
        description: `Processed ${result.recordsProcessed || 0} records, applied ${result.updatesApplied || 0} updates`,
      });

      return {
        success: true,
        recordsProcessed: result.recordsProcessed || 0,
        updatesApplied: result.updatesApplied || 0,
        conflictsDetected: result.conflictsDetected || 0,
        done: result.done || false,
        message: result.message || 'Sync completed successfully',
      };
    } catch (error: any) {
      console.error('Sync error:', error);
      toast({
        title: 'Sync Failed',
        description: error.message || 'An error occurred during sync',
        variant: 'destructive',
      });
      return null;
    } finally {
      setSyncing(false);
      setProgress(0);
      setStatus('');
    }
  }, [toast]);

  const stopSync = useCallback(async () => {
    try {
      await supabase.from('sync_state').upsert({
        key: 'sync_paused',
        value: { paused: true, pausedAt: new Date().toISOString() }
      });
      
      toast({
        title: 'Sync Paused',
        description: 'The sync operation will stop after the current batch',
      });
    } catch (error: any) {
      console.error('Error pausing sync:', error);
      toast({
        title: 'Error',
        description: 'Failed to pause sync',
        variant: 'destructive',
      });
    }
  }, [toast]);

  return {
    syncing,
    progress,
    status,
    testConnection,
    runSync,
    stopSync,
  };
}
