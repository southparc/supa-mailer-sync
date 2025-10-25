import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Users } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Advisor {
  id: number;
  name: string;
  email: string | null;
  VoAdvisor: string | null;
  client_count?: number;
}

interface Duplicate {
  name: string;
  count: number;
  ids: string;
}

export function AdvisorsManagement() {
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadAdvisors();
    checkDuplicates();
  }, []);

  async function loadAdvisors() {
    setLoading(true);
    try {
      // Get advisors with client counts
      const { data, error } = await supabase
        .from('advisors')
        .select(`
          id,
          name,
          email,
          VoAdvisor,
          clients:clients(count)
        `)
        .order('name');

      if (error) throw error;

      const advisorsWithCounts = data?.map(a => ({
        ...a,
        client_count: a.clients?.[0]?.count || 0
      })) || [];

      setAdvisors(advisorsWithCounts);
    } catch (error: any) {
      toast({
        title: "Error loading advisors",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  async function checkDuplicates() {
    try {
      const { data, error } = await supabase.rpc('check_duplicate_advisors');
      if (error) throw error;
      setDuplicates(data || []);
    } catch (error: any) {
      console.error('Error checking duplicates:', error);
    }
  }

  function getAdvisorBadge(advisor: Advisor) {
    const isDuplicate = duplicates.some(d => d.name === advisor.name);
    if (isDuplicate) {
      return <Badge variant="destructive">Duplicate</Badge>;
    }
    if (!advisor.email) {
      return <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">No Email</Badge>;
    }
    return <Badge variant="outline">Active</Badge>;
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2" />
          <p>Loading advisors...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Advisors Management
          </CardTitle>
          <CardDescription>
            Manage advisors and resolve data quality issues
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {duplicates.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Duplicate advisors found:</strong> {duplicates.map(d => `${d.name} (${d.count}x)`).join(', ')}
                <br />
                <span className="text-sm">Sync operations are blocked until duplicates are resolved.</span>
              </AlertDescription>
            </Alert>
          )}

          <div className="flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              Total advisors: <strong>{advisors.length}</strong>
              {' | '}
              Without email: <strong>{advisors.filter(a => !a.email).length}</strong>
            </div>
            <Button onClick={() => { loadAdvisors(); checkDuplicates(); }} variant="outline" size="sm">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 text-sm font-medium">Name</th>
                  <th className="text-left p-3 text-sm font-medium">Email</th>
                  <th className="text-left p-3 text-sm font-medium">VoAdvisor</th>
                  <th className="text-center p-3 text-sm font-medium">Clients</th>
                  <th className="text-center p-3 text-sm font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {advisors.map(advisor => (
                  <tr key={advisor.id} className="hover:bg-muted/50 transition-colors">
                    <td className="p-3 text-sm font-medium">{advisor.name}</td>
                    <td className="p-3 text-sm text-muted-foreground">
                      {advisor.email || <span className="italic">No email</span>}
                    </td>
                    <td className="p-3 text-sm text-muted-foreground">
                      {advisor.VoAdvisor || <span className="italic">—</span>}
                    </td>
                    <td className="p-3 text-sm text-center">{advisor.client_count}</td>
                    <td className="p-3 text-center">{getAdvisorBadge(advisor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
