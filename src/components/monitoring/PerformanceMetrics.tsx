import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { Clock, Zap, TrendingUp, Database } from "lucide-react";

interface ExecutionMetric {
  timestamp: string;
  functionName: string;
  executionTimeMs: number;
  recordsProcessed: number;
  status: string;
}

interface AggregatedMetrics {
  avgExecutionTime: number;
  maxExecutionTime: number;
  minExecutionTime: number;
  totalExecutions: number;
  successRate: number;
}

export const PerformanceMetrics: React.FC = () => {
  const [metrics, setMetrics] = useState<ExecutionMetric[]>([]);
  const [aggregated, setAggregated] = useState<Record<string, AggregatedMetrics>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMetrics();
    
    const interval = setInterval(loadMetrics, 30000); // Refresh every 30 seconds
    
    return () => clearInterval(interval);
  }, []);

  const loadMetrics = async () => {
    try {
      // Load execution metrics from sync_log
      const { data: logs } = await supabase
        .from('sync_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (logs) {
        const parsed: ExecutionMetric[] = logs.map(log => ({
          timestamp: log.created_at,
          functionName: log.action || 'unknown',
          executionTimeMs: (log.result as any)?.executionTime || 0,
          recordsProcessed: (log.result as any)?.recordsProcessed || 0,
          status: (log.result as any)?.status || 'unknown',
        }));

        setMetrics(parsed);

        // Calculate aggregated metrics per function
        const agg: Record<string, AggregatedMetrics> = {};
        
        ['backfill-sync', 'enterprise-sync', 'smart-sync'].forEach(funcName => {
          const funcMetrics = parsed.filter(m => m.functionName === funcName);
          
          if (funcMetrics.length > 0) {
            const times = funcMetrics.map(m => m.executionTimeMs).filter(t => t > 0);
            const successful = funcMetrics.filter(m => m.status === 'success').length;
            
            agg[funcName] = {
              avgExecutionTime: times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0,
              maxExecutionTime: times.length > 0 ? Math.max(...times) : 0,
              minExecutionTime: times.length > 0 ? Math.min(...times) : 0,
              totalExecutions: funcMetrics.length,
              successRate: funcMetrics.length > 0 ? (successful / funcMetrics.length) * 100 : 0,
            };
          }
        });

        setAggregated(agg);
      }
    } catch (error) {
      console.error('Error loading performance metrics:', error);
    } finally {
      setLoading(false);
    }
  };

  const chartData = metrics
    .slice(0, 20)
    .reverse()
    .map(m => ({
      time: new Date(m.timestamp).toLocaleTimeString(),
      executionTime: m.executionTimeMs / 1000, // Convert to seconds
      records: m.recordsProcessed,
      function: m.functionName,
    }));

  if (loading) {
    return (
      <div className="grid gap-4">
        <Card className="animate-pulse">
          <CardHeader className="h-64 bg-muted/50" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Aggregated Stats Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        {Object.entries(aggregated).map(([funcName, stats]) => (
          <Card key={funcName}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                {funcName.replace('-', ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
              </CardTitle>
              <Zap className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Avg Execution Time</p>
                <p className="text-2xl font-bold">{(stats.avgExecutionTime / 1000).toFixed(2)}s</p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground">Max</p>
                  <p className="font-medium">{(stats.maxExecutionTime / 1000).toFixed(1)}s</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Success Rate</p>
                  <p className="font-medium">{stats.successRate.toFixed(1)}%</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Execution Time Chart */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-primary" />
            <CardTitle>Execution Time Trends</CardTitle>
          </div>
          <CardDescription>
            Last 20 sync operations execution times (in seconds)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                dataKey="time" 
                className="text-xs fill-muted-foreground"
              />
              <YAxis 
                className="text-xs fill-muted-foreground"
                label={{ value: 'Seconds', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px'
                }}
              />
              <Legend />
              <Line 
                type="monotone" 
                dataKey="executionTime" 
                stroke="hsl(var(--primary))" 
                strokeWidth={2}
                name="Execution Time (s)"
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Records Processed Chart */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <CardTitle>Records Processed</CardTitle>
          </div>
          <CardDescription>
            Number of records processed per operation
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                dataKey="time" 
                className="text-xs fill-muted-foreground"
              />
              <YAxis 
                className="text-xs fill-muted-foreground"
                label={{ value: 'Records', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px'
                }}
              />
              <Legend />
              <Bar 
                dataKey="records" 
                fill="hsl(var(--primary))" 
                name="Records Processed"
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
};
