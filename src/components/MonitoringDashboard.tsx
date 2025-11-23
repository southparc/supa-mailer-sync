import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SyncHealthIndicators } from './monitoring/SyncHealthIndicators';
import { StructuredLogsViewer } from './monitoring/StructuredLogsViewer';
import { PerformanceMetrics } from './monitoring/PerformanceMetrics';
import { StallDetectionAlerts } from './monitoring/StallDetectionAlerts';
import { BackfillProgressMonitor } from './monitoring/BackfillProgressMonitor';
import { Activity } from 'lucide-react';

export const MonitoringDashboard: React.FC = () => {
  return (
    <div className="space-y-6">
      {/* Backfill Progress Monitor - Shows when active */}
      <BackfillProgressMonitor />
      
      {/* Stall Detection Alerts - Always visible at top */}
      <StallDetectionAlerts />

      {/* Health Indicators */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            <CardTitle>Sync Health Overview</CardTitle>
          </div>
          <CardDescription>
            Real-time status of all synchronization operations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SyncHealthIndicators />
        </CardContent>
      </Card>

      {/* Detailed Monitoring Tabs */}
      <Tabs defaultValue="performance" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="performance">Performance Metrics</TabsTrigger>
          <TabsTrigger value="logs">Structured Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="performance" className="space-y-4">
          <PerformanceMetrics />
        </TabsContent>

        <TabsContent value="logs" className="space-y-4">
          <StructuredLogsViewer />
        </TabsContent>
      </Tabs>
    </div>
  );
};
