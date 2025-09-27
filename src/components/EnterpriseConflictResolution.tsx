import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, CheckCircle, Clock, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Conflict {
  id: string;
  email: string;
  field: string;
  a_value: string;
  b_value: string;
  detected_at: string;
  status: 'open' | 'resolved';
}

interface ConflictResolutionProps {
  onStatsUpdate?: (stats: { conflicts: number }) => void;
}

const EnterpriseConflictResolution: React.FC<ConflictResolutionProps> = ({ onStatsUpdate }) => {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadConflicts();
  }, []);

  const loadConflicts = async () => {
    try {
      setLoading(true);
      
      // Get conflicts from sync_conflicts table
      const { data, error } = await supabase
        .from('sync_conflicts')
        .select('*')
        .eq('status', 'pending')
        .order('detected_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      const formattedConflicts: Conflict[] = data.map(item => ({
        id: item.id.toString(),
        email: item.email,
        field: item.field,
        a_value: item.a_value || '',
        b_value: item.b_value || '',
        detected_at: item.detected_at,
        status: item.status === 'resolved' ? 'resolved' : 'open'
      }));

      setConflicts(formattedConflicts);
      onStatsUpdate?.({ conflicts: formattedConflicts.filter(c => c.status === 'open').length });
    } catch (error) {
      console.error('Error loading conflicts:', error);
      toast({
        title: "Error",
        description: "Failed to load conflicts. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const resolveConflict = async (conflictId: string, chosenValue: 'a' | 'b') => {
    try {
      setResolving(conflictId);
      
      const conflict = conflicts.find(c => c.id === conflictId);
      if (!conflict) return;

      // Update the sync_conflicts record to mark as resolved
      const { error } = await supabase
        .from('sync_conflicts')
        .update({ 
          status: 'resolved',
          resolved_value: chosenValue === 'a' ? conflict.a_value : conflict.b_value,
          resolved_at: new Date().toISOString()
        })
        .eq('id', conflictId);

      if (error) throw error;

      // Remove from local state
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
      
      toast({
        title: "Conflict Resolved",
        description: `Applied ${chosenValue === 'a' ? 'Supabase' : 'MailerLite'} value for ${conflict.field}`,
      });

      // Update stats
      const remainingConflicts = conflicts.filter(c => c.id !== conflictId && c.status === 'open').length;
      onStatsUpdate?.({ conflicts: remainingConflicts });

    } catch (error) {
      console.error('Error resolving conflict:', error);
      toast({
        title: "Error",
        description: "Failed to resolve conflict. Please try again.",
        variant: "destructive",
      });
    } finally {
      setResolving(null);
    }
  };

  const getFieldDisplayName = (field: string): string => {
    const fieldNames: Record<string, string> = {
      'first_name': 'First Name',
      'last_name': 'Last Name',
      'phone': 'Phone',
      'city': 'City',
      'country': 'Country',
      'email': 'Email'
    };
    return fieldNames[field] || field;
  };

  const formatValue = (value: string): string => {
    return value || '(empty)';
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 animate-spin" />
            Loading Conflicts...
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center p-8">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (conflicts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-600" />
            No Conflicts Found
          </CardTitle>
          <CardDescription>
            All data is synchronized without conflicts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center p-6">
            <CheckCircle className="h-12 w-12 text-green-600 mx-auto mb-4" />
            <p className="text-lg font-medium mb-2">All Clear!</p>
            <p className="text-muted-foreground mb-4">
              No conflicts detected between Supabase and MailerLite data.
            </p>
            <Button onClick={loadConflicts} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-yellow-600" />
          Data Conflicts
          <Badge variant="secondary">{conflicts.length}</Badge>
        </CardTitle>
        <CardDescription>
          Review and resolve data conflicts between Supabase and MailerLite.
        </CardDescription>
        <Button onClick={loadConflicts} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-96">
          <div className="space-y-4">
            {conflicts.map((conflict) => (
              <Card key={conflict.id} className="border">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {conflict.email}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {getFieldDisplayName(conflict.field)}
                      </Badge>
                      <Badge variant="secondary">
                        <Clock className="h-3 w-3 mr-1" />
                        {new Date(conflict.detected_at).toLocaleDateString()}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Supabase Value */}
                    <div className="p-4 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">Supabase Value</h4>
                        <Badge variant="outline">A</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">
                        {formatValue(conflict.a_value)}
                      </p>
                      <Button
                        size="sm"
                        onClick={() => resolveConflict(conflict.id, 'a')}
                        disabled={resolving === conflict.id}
                        className="w-full"
                      >
                        {resolving === conflict.id ? (
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                        ) : null}
                        Use This Value
                      </Button>
                    </div>

                    {/* MailerLite Value */}
                    <div className="p-4 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-sm">MailerLite Value</h4>
                        <Badge variant="outline">B</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">
                        {formatValue(conflict.b_value)}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resolveConflict(conflict.id, 'b')}
                        disabled={resolving === conflict.id}
                        className="w-full"
                      >
                        {resolving === conflict.id ? (
                          <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                        ) : null}
                        Use This Value
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

export default EnterpriseConflictResolution;