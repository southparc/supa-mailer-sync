import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface SyncStats {
  totalClients: number;
  shadowCount: number;
  crosswalkCount: number;
  conflictCount: number;
  lastSync: string | null;
  recordsProcessed: number;
  updatesApplied: number;
}

interface SyncPercentage {
  percentage: number;
  clientsWithShadow: number;
  totalClients: number;
}

export function useSyncStats() {
  const [stats, setStats] = useState<SyncStats>({
    totalClients: 0,
    shadowCount: 0,
    crosswalkCount: 0,
    conflictCount: 0,
    lastSync: null,
    recordsProcessed: 0,
    updatesApplied: 0,
  });
  
  const [syncPercentage, setSyncPercentage] = useState<SyncPercentage>({
    percentage: 0,
    clientsWithShadow: 0,
    totalClients: 0,
  });
  
  const [loading, setLoading] = useState(true);

  const loadStats = useCallback(async () => {
    try {
      setLoading(true);
      
      // Load all stats in parallel
      const [
        clientsResult,
        shadowsResult,
        crosswalksResult,
        conflictsResult,
        syncStateResult
      ] = await Promise.all([
        supabase.from('clients').select('id', { count: 'exact', head: true }),
        supabase.from('sync_shadow').select('id', { count: 'exact', head: true }),
        supabase.from('integration_crosswalk').select('id', { count: 'exact', head: true }),
        supabase.from('sync_conflicts').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('sync_state').select('value').eq('key', 'full_sync_state').maybeSingle(),
      ]);

      const totalClients = clientsResult.count || 0;
      const shadowCount = shadowsResult.count || 0;
      const crosswalkCount = crosswalksResult.count || 0;
      const conflictCount = conflictsResult.count || 0;

      const syncState = syncStateResult.data?.value as any;
      
      setStats({
        totalClients,
        shadowCount,
        crosswalkCount,
        conflictCount,
        lastSync: syncState?.lastCompletedAt || null,
        recordsProcessed: syncState?.totalProcessed || 0,
        updatesApplied: syncState?.totalUpdated || 0,
      });

      setSyncPercentage({
        percentage: totalClients > 0 ? Math.round((shadowCount / totalClients) * 100) : 0,
        clientsWithShadow: shadowCount,
        totalClients,
      });
    } catch (error) {
      console.error('Error loading sync stats:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return {
    stats,
    syncPercentage,
    loading,
    refresh: loadStats,
  };
}
