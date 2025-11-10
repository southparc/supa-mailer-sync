import React, { useState, useEffect } from 'react';
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface StallAlert {
  type: 'backfill' | 'fullSync' | 'incrementalSync';
  message: string;
  lastUpdate: string;
  canResume: boolean;
}

export const StallDetectionAlerts: React.FC = () => {
  const [alerts, setAlerts] = useState<StallAlert[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    checkForStalls();
    
    const interval = setInterval(checkForStalls, 60000); // Check every minute
    
    return () => clearInterval(interval);
  }, []);

  const checkForStalls = async () => {
    try {
      const { data } = await supabase
        .from('sync_state')
        .select('value')
        .eq('key', 'sync_status')
        .maybeSingle();

      if (!data?.value) return;

      const syncStatus = data.value as any;
      const now = new Date();
      const detectedAlerts: StallAlert[] = [];

      // Check backfill stall
      if (syncStatus.backfill?.status === 'running' && syncStatus.backfill?.lastUpdatedAt) {
        const lastUpdate = new Date(syncStatus.backfill.lastUpdatedAt);
        const minutesSinceUpdate = (now.getTime() - lastUpdate.getTime()) / 60000;
        
        if (minutesSinceUpdate > 10) {
          detectedAlerts.push({
            type: 'backfill',
            message: `Backfill has been stalled for ${Math.round(minutesSinceUpdate)} minutes`,
            lastUpdate: syncStatus.backfill.lastUpdatedAt,
            canResume: true,
          });
        }
      }

      // Check full sync stall
      if (syncStatus.fullSync?.status === 'running' && syncStatus.fullSync?.lastUpdatedAt) {
        const lastUpdate = new Date(syncStatus.fullSync.lastUpdatedAt);
        const minutesSinceUpdate = (now.getTime() - lastUpdate.getTime()) / 60000;
        
        if (minutesSinceUpdate > 15) {
          detectedAlerts.push({
            type: 'fullSync',
            message: `Full sync has been stalled for ${Math.round(minutesSinceUpdate)} minutes`,
            lastUpdate: syncStatus.fullSync.lastUpdatedAt,
            canResume: true,
          });
        }
      }

      setAlerts(detectedAlerts);
    } catch (error) {
      console.error('Error checking for stalls:', error);
    }
  };

  const handleResume = async (type: string) => {
    setResuming(type);
    
    try {
      let functionName = '';
      
      if (type === 'backfill') {
        functionName = 'backfill-sync';
      } else if (type === 'fullSync') {
        functionName = 'enterprise-sync';
      } else if (type === 'incrementalSync') {
        functionName = 'smart-sync';
      }

      const { error } = await supabase.functions.invoke(functionName, {
        body: { resume: true }
      });

      if (error) throw error;

      toast({
        title: "Resume initiated",
        description: `${type} operation has been resumed`,
      });

      // Refresh alerts
      setTimeout(checkForStalls, 2000);
    } catch (error) {
      console.error('Error resuming sync:', error);
      toast({
        title: "Resume failed",
        description: error instanceof Error ? error.message : "Failed to resume operation",
        variant: "destructive",
      });
    } finally {
      setResuming(null);
    }
  };

  if (alerts.length === 0) return null;

  return (
    <div className="space-y-4">
      {alerts.map((alert, idx) => (
        <Alert key={idx} variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Sync Operation Stalled</AlertTitle>
          <AlertDescription className="flex items-center justify-between">
            <div>
              <p>{alert.message}</p>
              <p className="text-xs mt-1">
                Last update: {new Date(alert.lastUpdate).toLocaleString()}
              </p>
            </div>
            {alert.canResume && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleResume(alert.type)}
                disabled={resuming === alert.type}
              >
                {resuming === alert.type ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Resuming...
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Auto Resume
                  </>
                )}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
};
