import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, Clock, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface RateLimitStatus {
  tokensAvailable: number;
  requestsInLastMinute: number;
  utilizationPercent: string;
  timestamp: string;
}

export function RateLimitStatus() {
  const [status, setStatus] = useState<RateLimitStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRateLimitStatus = async () => {
    const { data, error } = await supabase
      .from("sync_state")
      .select("value")
      .eq("key", "mailerlite_rate_limit_status")
      .single();

    if (error) {
      console.error("Error fetching rate limit status:", error);
      setLoading(false);
      return;
    }

    if (data?.value && typeof data.value === 'object' && data.value !== null) {
      const value = data.value as Record<string, any>;
      setStatus({
        tokensAvailable: value.tokensAvailable ?? 0,
        requestsInLastMinute: value.requestsInLastMinute ?? 0,
        utilizationPercent: value.utilizationPercent ?? "0",
        timestamp: value.timestamp ?? new Date().toISOString()
      });
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchRateLimitStatus();

    // Set up real-time subscription for live updates
    const channel = supabase
      .channel("rate-limit-updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sync_state",
          filter: "key=eq.mailerlite_rate_limit_status",
        },
        (payload) => {
          if (payload.new && "value" in payload.new) {
            const value = payload.new.value as Record<string, any>;
            setStatus({
              tokensAvailable: value.tokensAvailable ?? 0,
              requestsInLastMinute: value.requestsInLastMinute ?? 0,
              utilizationPercent: value.utilizationPercent ?? "0",
              timestamp: value.timestamp ?? new Date().toISOString()
            });
          }
        }
      )
      .subscribe();

    // Refresh every 10 seconds as fallback
    const interval = setInterval(fetchRateLimitStatus, 10000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            MailerLite Rate Limit
          </CardTitle>
          <CardDescription>Loading status...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            MailerLite Rate Limit
          </CardTitle>
          <CardDescription>No data available</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const utilization = parseFloat(status.utilizationPercent);
  const getUtilizationColor = () => {
    if (utilization >= 90) return "destructive";
    if (utilization >= 70) return "default";
    return "secondary";
  };

  const getUtilizationLabel = () => {
    if (utilization >= 90) return "High";
    if (utilization >= 70) return "Moderate";
    return "Low";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          MailerLite API Rate Limit
        </CardTitle>
        <CardDescription>120 requests per minute maximum</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Utilization</span>
            <Badge variant={getUtilizationColor()}>
              {getUtilizationLabel()} ({status.utilizationPercent}%)
            </Badge>
          </div>
          <Progress value={utilization} className="h-2" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TrendingUp className="h-4 w-4" />
              Tokens Available
            </div>
            <p className="text-2xl font-bold">{status.tokensAvailable}</p>
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Activity className="h-4 w-4" />
              Requests/min
            </div>
            <p className="text-2xl font-bold">{status.requestsInLastMinute}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2 border-t">
          <Clock className="h-3 w-3" />
          Last updated: {new Date(status.timestamp).toLocaleTimeString()}
        </div>
      </CardContent>
    </Card>
  );
}
