import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { RefreshCw, Check, X, Mail, User, Calendar } from "lucide-react";

interface ConflictData {
  id: string;
  email: string;
  field: string;
  mailerlite_value: any;
  supabase_value: any;
  conflict_type: 'value_mismatch' | 'missing_mailerlite' | 'missing_supabase';
  created_at: string;
}

interface ConflictResolutionProps {
  onStatsUpdate?: () => void;
}

export function ConflictResolution({ onStatsUpdate }: ConflictResolutionProps) {
  const [conflicts, setConflicts] = useState<ConflictData[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadConflicts();
  }, []);

  const loadConflicts = async () => {
    try {
      setLoading(true);
      
      // For now, we'll create some mock conflicts since the conflict detection logic
      // needs to be implemented. In a real implementation, this would query a conflicts table.
      const mockConflicts: ConflictData[] = [
        {
          id: "1",
          email: "john@example.com",
          field: "name",
          mailerlite_value: "John Smith",
          supabase_value: "John Doe",
          conflict_type: "value_mismatch",
          created_at: new Date().toISOString()
        },
        {
          id: "2", 
          email: "jane@example.com",
          field: "status",
          mailerlite_value: "active",
          supabase_value: null,
          conflict_type: "missing_supabase",
          created_at: new Date().toISOString()
        }
      ];
      
      setConflicts(mockConflicts);
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

  const resolveConflict = async (conflictId: string, chosenValue: any, source: 'mailerlite' | 'supabase') => {
    try {
      setResolving(conflictId);
      
      const conflict = conflicts.find(c => c.id === conflictId);
      if (!conflict) return;

      // Call edge function to resolve conflict
      const { error } = await supabase.functions.invoke('resolve-conflict', {
        body: {
          conflictId,
          email: conflict.email,
          field: conflict.field,
          chosenValue,
          source,
          targetSource: source === 'mailerlite' ? 'supabase' : 'mailerlite'
        }
      });

      if (error) {
        throw error;
      }

      // Remove resolved conflict from local state
      setConflicts(prev => prev.filter(c => c.id !== conflictId));
      
      toast({
        title: "Conflict Resolved",
        description: `${conflict.field} for ${conflict.email} has been updated with the chosen value.`,
      });

      onStatsUpdate?.();
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

  const getConflictTypeLabel = (type: ConflictData['conflict_type']) => {
    switch (type) {
      case 'value_mismatch':
        return 'Value Mismatch';
      case 'missing_mailerlite':
        return 'Missing in MailerLite';
      case 'missing_supabase':
        return 'Missing in Supabase';
      default:
        return 'Unknown';
    }
  };

  const getConflictTypeBadgeVariant = (type: ConflictData['conflict_type']) => {
    switch (type) {
      case 'value_mismatch':
        return 'destructive' as const;
      case 'missing_mailerlite':
        return 'secondary' as const;
      case 'missing_supabase':
        return 'outline' as const;
      default:
        return 'default' as const;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="h-8 w-8 animate-spin" />
        <span className="ml-2">Loading conflicts...</span>
      </div>
    );
  }

  if (conflicts.length === 0) {
    return (
      <div className="text-center py-8">
        <Check className="h-12 w-12 text-green-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold mb-2">No Conflicts Found</h3>
        <p className="text-muted-foreground">All data is in sync between MailerLite and Supabase.</p>
        <Button onClick={loadConflicts} variant="outline" className="mt-4">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">
            {conflicts.length} Conflict{conflicts.length !== 1 ? 's' : ''} Found
          </h3>
          <p className="text-sm text-muted-foreground">
            Review and choose the correct values to resolve conflicts
          </p>
        </div>
        <Button onClick={loadConflicts} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="space-y-4">
        {conflicts.map((conflict) => (
          <Card key={conflict.id} className="border-l-4 border-l-destructive">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <CardTitle className="text-base">{conflict.email}</CardTitle>
                    <CardDescription>
                      Field: <span className="font-medium">{conflict.field}</span>
                    </CardDescription>
                  </div>
                </div>
                <Badge variant={getConflictTypeBadgeVariant(conflict.conflict_type)}>
                  {getConflictTypeLabel(conflict.conflict_type)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* MailerLite Value */}
                <Card className="border-blue-200 bg-blue-50/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <div className="w-3 h-3 bg-blue-500 rounded-full"></div>
                      MailerLite Value
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="p-3 bg-background rounded border">
                      {conflict.mailerlite_value !== null ? (
                        <span className="font-mono text-sm">
                          {typeof conflict.mailerlite_value === 'object' 
                            ? JSON.stringify(conflict.mailerlite_value, null, 2)
                            : String(conflict.mailerlite_value)
                          }
                        </span>
                      ) : (
                        <span className="text-muted-foreground italic">null</span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      className="w-full mt-3"
                      onClick={() => resolveConflict(conflict.id, conflict.mailerlite_value, 'mailerlite')}
                      disabled={resolving === conflict.id}
                    >
                      <Check className="h-4 w-4 mr-2" />
                      Use This Value
                    </Button>
                  </CardContent>
                </Card>

                {/* Supabase Value */}
                <Card className="border-green-200 bg-green-50/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                      Supabase Value
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="p-3 bg-background rounded border">
                      {conflict.supabase_value !== null ? (
                        <span className="font-mono text-sm">
                          {typeof conflict.supabase_value === 'object' 
                            ? JSON.stringify(conflict.supabase_value, null, 2)
                            : String(conflict.supabase_value)
                          }
                        </span>
                      ) : (
                        <span className="text-muted-foreground italic">null</span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      className="w-full mt-3"
                      onClick={() => resolveConflict(conflict.id, conflict.supabase_value, 'supabase')}
                      disabled={resolving === conflict.id}
                    >
                      <Check className="h-4 w-4 mr-2" />
                      Use This Value
                    </Button>
                  </CardContent>
                </Card>
              </div>

              <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Detected: {new Date(conflict.created_at).toLocaleString()}
                </div>
                {resolving === conflict.id && (
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    Resolving...
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}