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
      
      // Simple connection test - just check if we can query the database
      const { error: dbError } = await supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .limit(1);

      if (dbError) {
        console.error('Database connection failed:', dbError);
        toast({
          title: 'Connection Failed',
          description: 'Unable to connect to database',
          variant: 'destructive',
        });
        return false;
      }

      // Test MailerLite API connectivity
      const { error: apiError } = await supabase.functions.invoke('smart-sync', {
        body: { mode: 'test', dryRun: true }
      });

      if (apiError) {
        console.error('API connection test failed:', apiError);
        toast({
          title: 'API Connection Warning',
          description: 'Database OK, but sync service may be unavailable',
          variant: 'default',
        });
        setStatus('Database connected');
        return true; // Still return true since DB works
      }

      setStatus('All connections successful');
      toast({
        title: 'Connection Test Passed',
        description: 'Database and sync service are operational',
      });
      return true;
    } catch (error: any) {
      console.error('Connection test error:', error);
      toast({
        title: 'Connection Error',
        description: error.message || 'Network error',
        variant: 'destructive',
      });
      return false;
    } finally {
      setTimeout(() => setStatus(''), 3000);
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
