import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface SyncStats {
  totalClients: number;
  shadowCount: number;
  incompleteShadows: number;
  crosswalkCount: number;
  conflictCount: number;
  lastSync: string | null;
  recordsProcessed: number;
  updatesApplied: number;
  statusBreakdown: {
    active: number;
    unsubscribed: number;
    bounced: number;
    junk: number;
    unconfirmed: number;
  };
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
    incompleteShadows: 0,
    crosswalkCount: 0,
    conflictCount: 0,
    lastSync: null,
    recordsProcessed: 0,
    updatesApplied: 0,
    statusBreakdown: {
      active: 0,
      unsubscribed: 0,
      bounced: 0,
      junk: 0,
      unconfirmed: 0,
    },
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
        incompleteShadowsResult,
        crosswalksResult,
        conflictsResult,
        syncStatusResult,
        statusActiveResult,
        statusUnsubscribedResult,
        statusBouncedResult,
        statusJunkResult,
        statusUnconfirmedResult,
      ] = await Promise.all([
        supabase.from('clients').select('id', { count: 'exact', head: true }),
        supabase.from('sync_shadow').select('id', { count: 'exact', head: true }),
        supabase.from('sync_shadow').select('id', { count: 'exact', head: true }).eq('validation_status', 'incomplete'),
        supabase.from('integration_crosswalk').select('id', { count: 'exact', head: true }),
        supabase.from('sync_conflicts').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('sync_state').select('value').eq('key', 'sync_status').maybeSingle(),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('subscription_status', 'active'),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('subscription_status', 'unsubscribed'),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('subscription_status', 'bounced'),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('subscription_status', 'junk'),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('subscription_status', 'unconfirmed'),
      ]);

      const totalClients = clientsResult.count || 0;
      const shadowCount = shadowsResult.count || 0;
      const incompleteShadows = incompleteShadowsResult.count || 0;
      const crosswalkCount = crosswalksResult.count || 0;
      const conflictCount = conflictsResult.count || 0;

      // Read from consolidated sync_status (Phase 1 structure)
      const syncStatus = syncStatusResult.data?.value as any;
      
      setStats({
        totalClients,
        shadowCount,
        incompleteShadows,
        crosswalkCount,
        conflictCount,
        lastSync: syncStatus?.fullSync?.lastCompletedAt || syncStatus?.lastSync?.timestamp || null,
        recordsProcessed: syncStatus?.fullSync?.totalProcessed || syncStatus?.statistics?.recordsProcessed || 0,
        updatesApplied: syncStatus?.fullSync?.totalUpdated || syncStatus?.statistics?.updatesApplied || 0,
        statusBreakdown: {
          active: statusActiveResult.count || 0,
          unsubscribed: statusUnsubscribedResult.count || 0,
          bounced: statusBouncedResult.count || 0,
          junk: statusJunkResult.count || 0,
          unconfirmed: statusUnconfirmedResult.count || 0,
        },
      });

      // Sync Coverage should be based on crosswalk count (clients that should have shadows)
      // not total clients count
      setSyncPercentage({
        percentage: crosswalkCount > 0 ? Math.round((shadowCount / crosswalkCount) * 100) : 0,
        clientsWithShadow: shadowCount,
        totalClients: crosswalkCount, // This represents clients in crosswalk
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
