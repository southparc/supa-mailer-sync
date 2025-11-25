import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { SyncLogs } from "@/components/SyncLogs";
import { AdvisorsManagement } from "@/components/AdvisorsManagement";
import SmartSyncDashboard from "@/components/SmartSyncDashboard";
import EnterpriseSyncDashboard from "@/components/EnterpriseSyncDashboard";
import { MonitoringDashboard } from "@/components/MonitoringDashboard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LogOut, RefreshCw, AlertTriangle, Users, Database } from "lucide-react";

interface DashboardStats {
  totalClients: number;
  totalGroups: number;
  pendingConflicts: number;
  lastSyncAt?: string;
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [stats, setStats] = useState<DashboardStats>({
    totalClients: 0,
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

  useEffect(() => {
    const checkAdminStatus = async () => {
      if (!session?.user) {
        setCheckingAdmin(false);
        return;
      }

      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', session.user.id)
        .eq('role', 'admin')
        .maybeSingle();

      if (error || !data) {
        setIsAdmin(false);
        toast({
          title: "Access Denied",
          description: "You don't have permission to access this dashboard.",
          variant: "destructive",
        });
        navigate("/auth");
      } else {
        setIsAdmin(true);
      }
      setCheckingAdmin(false);
    };

    if (session?.user) {
      checkAdminStatus();
    }
  }, [session, navigate, toast]);

  const loadDashboardStats = async () => {
    try {
      setRefreshing(true);
      
      // Load stats from available tables
      const [clientsResult, groupsResult, conflictsResult] = await Promise.all([
        supabase.from('clients').select('id', { count: 'exact' }),
        supabase.from('managed_mailerlite_groups').select('id', { count: 'exact' }),
        supabase.from('sync_conflicts').select('id', { count: 'exact' }).eq('status', 'pending'),
      ]);

      // Get latest sync time from sync logs
      const { data: lastSync } = await supabase
        .from('sync_log')
        .select('created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      setStats({
        totalClients: clientsResult.count || 0,
        totalGroups: groupsResult.count || 0,
        pendingConflicts: conflictsResult.count || 0,
        lastSyncAt: lastSync?.created_at || null
      });
      
      toast({
        title: "Stats Refreshed",
        description: "Dashboard statistics have been updated",
      });
    } catch (error) {
      console.error('Error loading dashboard stats:', error);
      // Set defaults on error to prevent broken UI
      setStats({
        totalClients: 0,
        totalGroups: 0,
        pendingConflicts: 0,
        lastSyncAt: null
      });
      
      toast({
        title: "Refresh Failed",
        description: "Failed to load dashboard statistics",
        variant: "destructive",
      });
    } finally {
      setRefreshing(false);
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

  if (loading || checkingAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">
            {loading ? "Loading dashboard..." : "Verifying permissions..."}
          </p>
        </div>
      </div>
    );
  }

  if (!user || !isAdmin) {
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
          <div className="flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={loadDashboardStats}
              disabled={refreshing}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
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
              <CardTitle className="text-sm font-medium">Total Clients</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.totalClients}</div>
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
        <Tabs defaultValue="enterprise-sync" className="space-y-6">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="enterprise-sync">Full Sync (Bidirectional)</TabsTrigger>
            <TabsTrigger value="smart-sync">Incremental Sync (Targeted)</TabsTrigger>
            <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            <TabsTrigger value="advisors">Advisors</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>

          <TabsContent value="enterprise-sync" className="space-y-6">
            <ErrorBoundary fallbackTitle="Enterprise Sync Error">
              <EnterpriseSyncDashboard />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="smart-sync" className="space-y-6">
            <ErrorBoundary fallbackTitle="Smart Sync Error">
              <SmartSyncDashboard />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="monitoring" className="space-y-6">
            <ErrorBoundary fallbackTitle="Monitoring Dashboard Error">
              <MonitoringDashboard />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="advisors" className="space-y-6">
            <ErrorBoundary fallbackTitle="Advisors Management Error">
              <AdvisorsManagement />
            </ErrorBoundary>
          </TabsContent>

          <TabsContent value="logs" className="space-y-6">
            <ErrorBoundary fallbackTitle="Sync Logs Error">
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
            </ErrorBoundary>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}