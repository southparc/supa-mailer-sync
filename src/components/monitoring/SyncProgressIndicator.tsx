import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Clock, Activity, Loader2, CheckCircle, PauseCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface SyncState {
  phase: 'init' | 'onlyInML' | 'onlyInSB' | 'inBoth' | 'done';
  idx: number;
  onlyInML?: string[];
  onlyInSB?: string[];
  inBoth?: string[];
  stats?: {
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
  next_run_at?: string;
  last_save_reason?: string;
  elapsed_ms?: number;
}

interface SyncStatus {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error';
  message?: string;
}

export function SyncProgressIndicator() {
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ status: 'idle' });
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [estimatedCompletion, setEstimatedCompletion] = useState<string | null>(null);

  useEffect(() => {
    // Initial load
    loadSyncState();
    loadSyncStatus();

    // Subscribe to sync_state changes
    const channel = supabase
      .channel('sync-progress')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'sync_state',
          filter: 'key=in.(full_sync_state,sync_status)'
        },
        (payload) => {
          console.log('Sync state updated:', payload);
          if (payload.new && 'key' in payload.new) {
            const record = payload.new as { key: string; value: any };
            if (record.key === 'full_sync_state') {
              setSyncState(record.value as unknown as SyncState);
              updateEstimatedCompletion(record.value as unknown as SyncState);
            } else if (record.key === 'sync_status') {
              setSyncStatus(record.value as unknown as SyncStatus);
              if (record.value.status === 'running' && !startTime) {
                setStartTime(new Date());
              } else if (record.value.status !== 'running') {
                setStartTime(null);
              }
            }
          }
        }
      )
      .subscribe();

    // Poll for updates every 3 seconds as backup
    const pollInterval = setInterval(() => {
      loadSyncState();
      loadSyncStatus();
    }, 3000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(pollInterval);
    };
  }, []);

  const loadSyncState = async () => {
    const { data, error } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'full_sync_state')
      .maybeSingle();

    if (data?.value && !error) {
      const state = data.value as unknown as SyncState;
      setSyncState(state);
      updateEstimatedCompletion(state);
    }
  };

  const loadSyncStatus = async () => {
    const { data, error } = await supabase
      .from('sync_state')
      .select('value')
      .eq('key', 'sync_status')
      .maybeSingle();

    if (data?.value && !error) {
      const status = data.value as unknown as SyncStatus;
      setSyncStatus(status);
      if (status.status === 'running' && !startTime) {
        setStartTime(new Date());
      } else if (status.status !== 'running') {
        setStartTime(null);
      }
    }
  };

  const updateEstimatedCompletion = (state: SyncState) => {
    if (!state || state.phase === 'done' || state.phase === 'init') {
      setEstimatedCompletion(null);
      return;
    }

    // Calculate total records and processed records
    const totalRecords = 
      (state.onlyInML?.length || 0) + 
      (state.onlyInSB?.length || 0) + 
      (state.inBoth?.length || 0);
    
    let processedRecords = 0;
    
    if (state.phase === 'onlyInML') {
      processedRecords = state.idx;
    } else if (state.phase === 'onlyInSB') {
      processedRecords = (state.onlyInML?.length || 0) + state.idx;
    } else if (state.phase === 'inBoth') {
      processedRecords = (state.onlyInML?.length || 0) + (state.onlyInSB?.length || 0) + state.idx;
    }

    const remainingRecords = totalRecords - processedRecords;

    // Estimate time per record (200ms average)
    const avgTimePerRecord = 200;
    const estimatedRemainingMs = remainingRecords * avgTimePerRecord;
    
    if (estimatedRemainingMs > 0) {
      const eta = new Date(Date.now() + estimatedRemainingMs);
      setEstimatedCompletion(formatDistanceToNow(eta, { addSuffix: true }));
    } else {
      setEstimatedCompletion(null);
    }
  };

  const calculateProgress = (): number => {
    if (!syncState || syncState.phase === 'init') return 0;
    if (syncState.phase === 'done') return 100;

    const totalRecords = 
      (syncState.onlyInML?.length || 0) + 
      (syncState.onlyInSB?.length || 0) + 
      (syncState.inBoth?.length || 0);
    
    if (totalRecords === 0) return 0;

    let processedRecords = 0;
    
    if (syncState.phase === 'onlyInML') {
      processedRecords = syncState.idx;
    } else if (syncState.phase === 'onlyInSB') {
      processedRecords = (syncState.onlyInML?.length || 0) + syncState.idx;
    } else if (syncState.phase === 'inBoth') {
      processedRecords = (syncState.onlyInML?.length || 0) + (syncState.onlyInSB?.length || 0) + syncState.idx;
    }

    return Math.round((processedRecords / totalRecords) * 100);
  };

  const getPhaseLabel = (phase: string): string => {
    switch (phase) {
      case 'init': return 'Initializing';
      case 'onlyInML': return 'Syncing MailerLite → Supabase';
      case 'onlyInSB': return 'Syncing Supabase → MailerLite';
      case 'inBoth': return 'Bidirectional Sync';
      case 'done': return 'Completed';
      default: return phase;
    }
  };

  const getStatusBadge = () => {
    switch (syncStatus.status) {
      case 'running':
        return <Badge variant="default" className="animate-pulse"><Loader2 className="h-3 w-3 mr-1 animate-spin" />Running</Badge>;
      case 'paused':
        return <Badge variant="secondary"><PauseCircle className="h-3 w-3 mr-1" />Paused</Badge>;
      case 'completed':
        return <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-500/20"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="outline">Idle</Badge>;
    }
  };

  // Don't show if no active sync
  if (syncStatus.status === 'idle' || !syncState || syncState.phase === 'init') {
    return null;
  }

  const progress = calculateProgress();
  const totalRecords = 
    (syncState.onlyInML?.length || 0) + 
    (syncState.onlyInSB?.length || 0) + 
    (syncState.inBoth?.length || 0);

  let currentPhaseRecords = 0;
  let currentPhaseTotal = 0;
  
  if (syncState.phase === 'onlyInML') {
    currentPhaseRecords = syncState.idx;
    currentPhaseTotal = syncState.onlyInML?.length || 0;
  } else if (syncState.phase === 'onlyInSB') {
    currentPhaseRecords = syncState.idx;
    currentPhaseTotal = syncState.onlyInSB?.length || 0;
  } else if (syncState.phase === 'inBoth') {
    currentPhaseRecords = syncState.idx;
    currentPhaseTotal = syncState.inBoth?.length || 0;
  }

  return (
    <Card className="border-primary/20 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              Sync in Progress
            </CardTitle>
            <CardDescription>
              {getPhaseLabel(syncState.phase)}
            </CardDescription>
          </div>
          {getStatusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall Progress */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Overall Progress</span>
            <span className="font-medium">{progress}%</span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>

        {/* Current Phase Progress */}
        {syncState.phase !== 'done' && currentPhaseTotal > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Current Phase</span>
              <span className="font-medium">
                {currentPhaseRecords.toLocaleString()} / {currentPhaseTotal.toLocaleString()}
              </span>
            </div>
            <Progress 
              value={(currentPhaseRecords / currentPhaseTotal) * 100} 
              className="h-1.5"
            />
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3 pt-2">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Total Records</p>
            <p className="text-lg font-bold">{totalRecords.toLocaleString()}</p>
          </div>
          
          {syncState.stats && (
            <>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Processed</p>
                <p className="text-lg font-bold text-green-600">
                  {(syncState.stats.created + syncState.stats.updated).toLocaleString()}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="text-sm font-medium">{syncState.stats.created.toLocaleString()}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Updated</p>
                <p className="text-sm font-medium">{syncState.stats.updated.toLocaleString()}</p>
              </div>
            </>
          )}
        </div>

        {/* ETA */}
        {estimatedCompletion && syncStatus.status === 'running' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground pt-2 border-t">
            <Clock className="h-3.5 w-3.5" />
            <span>Estimated completion: {estimatedCompletion}</span>
          </div>
        )}

        {/* Pause Reason */}
        {syncStatus.status === 'paused' && syncState.last_save_reason && (
          <div className="text-xs text-muted-foreground pt-2 border-t">
            <span className="font-medium">Paused: </span>
            {syncState.last_save_reason === 'timeout-protection' && 'Approaching timeout - will auto-resume'}
            {syncState.last_save_reason === 'rate-limit' && `Rate limit reached - resuming ${syncState.next_run_at ? formatDistanceToNow(new Date(syncState.next_run_at), { addSuffix: true }) : 'soon'}`}
            {syncState.last_save_reason === 'quota-exhausted' && 'Daily quota reached - will resume tomorrow'}
            {syncState.last_save_reason === 'batch-limit' && 'Batch complete - ready for next batch'}
          </div>
        )}

        {/* Status Message */}
        {syncStatus.message && (
          <div className="text-xs text-muted-foreground pt-2 border-t">
            {syncStatus.message}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
