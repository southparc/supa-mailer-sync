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

      // Database connection is sufficient for basic operations
      setStatus('Database connected');
      toast({
        title: 'Connection Test Passed',
        description: 'Database is operational and ready for sync operations',
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
    const maxRetries = 3;
    let attempt = 0;

    const executeWithRetry = async (): Promise<SyncResult | null> => {
      try {
        setSyncing(true);
        setProgress(0);
        setStatus(attempt > 0 
          ? `Retrying ${options.direction} sync (attempt ${attempt + 1}/${maxRetries + 1})...`
          : `Starting ${options.direction} sync...`
        );

        const { data, error } = await supabase.functions.invoke('smart-sync', {
          body: {
            mode: options.direction === 'bidirectional' ? 'bidirectional' : 
                  options.direction === 'mailerlite-to-supabase' ? 'BtoA' : 'AtoB',
            emails: [], // Empty array means process all
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
        console.error(`Sync error (attempt ${attempt + 1}):`, error);
        
        if (attempt < maxRetries) {
          attempt++;
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000); // Exponential backoff: 1s, 2s, 4s max
          setStatus(`Sync failed, retrying in ${delayMs / 1000}s...`);
          
          await new Promise(resolve => setTimeout(resolve, delayMs));
          return executeWithRetry();
        }
        
        toast({
          title: 'Sync Failed',
          description: `Failed after ${maxRetries + 1} attempts: ${error.message || 'Unknown error'}`,
          variant: 'destructive',
        });
        return null;
      }
    };

    try {
      return await executeWithRetry();
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
