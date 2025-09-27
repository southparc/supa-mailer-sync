import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { RefreshCw, Calendar, AlertCircle, CheckCircle, XCircle, Clock } from "lucide-react";

interface SyncLog {
  id: string;
  email: string;
  action: string;
  direction: string;
  result: string;
  field?: string;
  created_at: string;
}

export function SyncLogs() {
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLogs();
  }, []);

  const loadLogs = async () => {
    try {
      setLoading(true);
      
      const { data, error } = await supabase
        .from('sync_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        throw error;
      }

      if (data) {
        const logs: SyncLog[] = data.map(item => ({
          id: item.id,
          email: item.email,
          action: item.action,
          direction: item.direction,
          result: item.result,
          field: item.field,
          created_at: item.created_at
        }));
        setLogs(logs);
      }
    } catch (error) {
      console.error('Error loading sync logs:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (result: string) => {
    switch (result) {
      case 'applied':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'conflict':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'skipped':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      default:
        return <AlertCircle className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusBadgeVariant = (result: string) => {
    switch (result) {
      case 'applied':
        return 'default' as const;
      case 'conflict':
        return 'destructive' as const;
      case 'skipped':
        return 'secondary' as const;
      default:
        return 'outline' as const;
    }
  };

  const formatPayload = (log: SyncLog) => {
    return `${log.email} - ${log.field || 'all fields'}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="h-8 w-8 animate-spin" />
        <span className="ml-2">Loading sync logs...</span>
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="text-center py-8">
        <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-semibold mb-2">No Sync Logs</h3>
        <p className="text-muted-foreground">No synchronization activities have been logged yet.</p>
        <Button onClick={loadLogs} variant="outline" className="mt-4">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Sync Activity Log</h3>
          <p className="text-sm text-muted-foreground">
            Recent synchronization activities and their status
          </p>
        </div>
        <Button onClick={loadLogs} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <ScrollArea className="h-96">
        <div className="space-y-3">
          {logs.map((log) => (
            <Card key={log.id} className="border-l-4 border-l-muted">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {getStatusIcon(log.result)}
                    <div>
                      <CardTitle className="text-base">
                        {log.action} - {log.direction}
                      </CardTitle>
                      <CardDescription className="flex items-center gap-2">
                        <Calendar className="h-3 w-3" />
                        {new Date(log.created_at).toLocaleString()}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={getStatusBadgeVariant(log.result)}>
                      {log.result}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium mb-1">Details:</p>
                    <div className="p-2 bg-muted rounded text-xs font-mono">
                      {formatPayload(log)}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}