import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { ConflictResolution } from "@/components/ConflictResolution";
import { SyncControls } from "@/components/SyncControls";
import { SyncSettings } from "@/components/SyncSettings";
import { SyncLogs } from "@/components/SyncLogs";
import EnterpriseSyncDashboard from "@/components/EnterpriseSyncDashboard";
import { LogOut, RefreshCw, AlertTriangle, Users, Database } from "lucide-react";

interface DashboardStats {
  totalSubscribers: number;
  totalGroups: number;
  pendingConflicts: number;
  lastSyncAt?: string;
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStats>({
    totalSubscribers: 0,
    totalGroups: 0,
    pendingConflicts: 0,
  });
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    // Set up auth state listener
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      
      if (!session?.user) {
        navigate("/auth");
      }
    });

    // Check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      
      if (!session?.user) {
        navigate("/auth");
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  useEffect(() => {
    if (user) {
      loadDashboardStats();
    }
  }, [user]);

  const loadDashboardStats = async () => {
    try {
      // Load stats from various tables
      const [subscribersResult, groupsResult, syncStateResult] = await Promise.all([
        supabase.from('ml_subscribers').select('id', { count: 'exact' }),
        supabase.from('ml_groups').select('id', { count: 'exact' }),
        supabase.from('ml_sync_state').select('*').single()
      ]);

      setStats({
        totalSubscribers: subscribersResult.count || 0,
        totalGroups: groupsResult.count || 0,
        pendingConflicts: 0, // TODO: Calculate actual conflicts
        lastSyncAt: syncStateResult.data?.last_full_backfill_at
      });
    } catch (error) {
      console.error('Error loading dashboard stats:', error);
    }
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      toast({
        title: "Error",
        description: "Failed to sign out. Please try again.",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Signed out",
        description: "You have been successfully signed out.",
      });
      navigate("/auth");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
          <p>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null; // Will redirect to auth
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">MailerLite Sync Dashboard</h1>
            <p className="text-muted-foreground">Manage data synchronization between MailerLite and Supabase</p>
          </div>
          <div className="flex items-center gap-4">
            <Badge variant="outline">{user.email}</Badge>
            <Button variant="outline" size="sm" onClick={handleSignOut}>
              <LogOut className="h-4 w-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Subscribers</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalSubscribers}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Groups</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalGroups}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending Conflicts</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">{stats.pendingConflicts}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Last Sync</CardTitle>
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-sm">
                {stats.lastSyncAt 
                  ? new Date(stats.lastSyncAt).toLocaleDateString()
                  : "Never"
                }
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="enterprise" className="space-y-6">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="enterprise">Enterprise Sync</TabsTrigger>
            <TabsTrigger value="conflicts">Conflict Resolution</TabsTrigger>
            <TabsTrigger value="sync">Legacy Controls</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="logs">Sync Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="enterprise" className="space-y-6">
            <EnterpriseSyncDashboard />
          </TabsContent>

          <TabsContent value="conflicts" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Resolve Data Conflicts</CardTitle>
                <CardDescription>
                  Review and resolve conflicts between MailerLite and Supabase data
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ConflictResolution onStatsUpdate={loadDashboardStats} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sync" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Synchronization Controls</CardTitle>
                <CardDescription>
                  Manage data synchronization between MailerLite and Supabase
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SyncControls onStatsUpdate={loadDashboardStats} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Sync Configuration</CardTitle>
                <CardDescription>
                  Configure field mappings and batch processing for large datasets
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SyncSettings />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="logs" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Synchronization Logs</CardTitle>
                <CardDescription>
                  View detailed logs of synchronization activities
                </CardDescription>
              </CardHeader>
              <CardContent>
                <SyncLogs />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}