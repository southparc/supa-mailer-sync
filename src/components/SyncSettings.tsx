import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Settings, Plus, Trash2, Save, RefreshCw, Info } from "lucide-react";

interface FieldMapping {
  id: string;
  mailerlite_field: string;
  supabase_field: string;
  field_type: 'text' | 'email' | 'number' | 'boolean' | 'date';
  is_required: boolean;
  default_value?: string;
}

interface SyncConfig {
  batch_size: number;
  max_records_per_sync: number;
  sync_direction: 'bidirectional' | 'from_mailerlite' | 'to_mailerlite';
  field_mappings: FieldMapping[];
  auto_resolve_conflicts: boolean;
  conflict_resolution_strategy: 'mailerlite_wins' | 'supabase_wins' | 'manual';
}

const defaultConfig: SyncConfig = {
  batch_size: 100,
  max_records_per_sync: 1000,
  sync_direction: 'bidirectional',
  field_mappings: [
    {
      id: '1',
      mailerlite_field: 'email',
      supabase_field: 'email',
      field_type: 'email',
      is_required: true
    },
    {
      id: '2', 
      mailerlite_field: 'fields.name',
      supabase_field: 'name',
      field_type: 'text',
      is_required: false
    },
    {
      id: '3',
      mailerlite_field: 'status',
      supabase_field: 'status',
      field_type: 'text',
      is_required: false
    }
  ],
  auto_resolve_conflicts: false,
  conflict_resolution_strategy: 'manual'
};

export function SyncSettings() {
  const [config, setConfig] = useState<SyncConfig>(defaultConfig);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      setLoading(true);
      
      // Load saved configuration from a settings table
      // For now, we'll use localStorage as a simple implementation
      const savedConfig = localStorage.getItem('mailerlite_sync_config');
      if (savedConfig) {
        setConfig(JSON.parse(savedConfig));
      }
    } catch (error) {
      console.error('Error loading config:', error);
      toast({
        title: "Error",
        description: "Failed to load sync configuration.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    try {
      setSaving(true);
      
      // Save configuration
      localStorage.setItem('mailerlite_sync_config', JSON.stringify(config));
      
      // Could also save to Supabase for persistence across devices
      // await supabase.from('sync_configs').upsert({ user_id: user.id, config });
      
      toast({
        title: "Settings Saved",
        description: "Sync configuration has been saved successfully.",
      });
    } catch (error) {
      console.error('Error saving config:', error);
      toast({
        title: "Error",
        description: "Failed to save sync configuration.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const addFieldMapping = () => {
    const newMapping: FieldMapping = {
      id: Date.now().toString(),
      mailerlite_field: '',
      supabase_field: '',
      field_type: 'text',
      is_required: false
    };
    
    setConfig(prev => ({
      ...prev,
      field_mappings: [...prev.field_mappings, newMapping]
    }));
  };

  const updateFieldMapping = (id: string, updates: Partial<FieldMapping>) => {
    setConfig(prev => ({
      ...prev,
      field_mappings: prev.field_mappings.map(mapping =>
        mapping.id === id ? { ...mapping, ...updates } : mapping
      )
    }));
  };

  const removeFieldMapping = (id: string) => {
    setConfig(prev => ({
      ...prev,
      field_mappings: prev.field_mappings.filter(mapping => mapping.id !== id)
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <RefreshCw className="h-8 w-8 animate-spin" />
        <span className="ml-2">Loading settings...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Sync Configuration
          </h3>
          <p className="text-sm text-muted-foreground">
            Configure field mappings and sync parameters for large datasets
          </p>
        </div>
        <Button onClick={saveConfig} disabled={saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>

      {/* Batch Processing Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Batch Processing</CardTitle>
          <CardDescription>
            Configure how to handle large datasets efficiently
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              With ~17k records, we recommend processing in batches to avoid timeouts and rate limits.
            </AlertDescription>
          </Alert>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="batch_size">Batch Size</Label>
              <Input
                id="batch_size"
                type="number"
                value={config.batch_size}
                onChange={(e) => setConfig(prev => ({ 
                  ...prev, 
                  batch_size: parseInt(e.target.value) || 100 
                }))}
                min="10"
                max="500"
              />
              <p className="text-xs text-muted-foreground">
                Number of records to process at once (10-500)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="max_records">Max Records Per Sync</Label>
              <Input
                id="max_records"
                type="number"
                value={config.max_records_per_sync}
                onChange={(e) => setConfig(prev => ({ 
                  ...prev, 
                  max_records_per_sync: parseInt(e.target.value) || 1000 
                }))}
                min="100"
                max="20000"
              />
              <p className="text-xs text-muted-foreground">
                Total records to sync in one operation (0 = no limit)
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sync_direction">Default Sync Direction</Label>
            <Select
              value={config.sync_direction}
              onValueChange={(value: SyncConfig['sync_direction']) => 
                setConfig(prev => ({ ...prev, sync_direction: value }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bidirectional">Bidirectional (Detect Conflicts)</SelectItem>
                <SelectItem value="from_mailerlite">From MailerLite Only</SelectItem>
                <SelectItem value="to_mailerlite">To MailerLite Only</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Field Mapping Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Field Mapping Configuration
            <Button onClick={addFieldMapping} size="sm" variant="outline">
              <Plus className="h-4 w-4 mr-2" />
              Add Field
            </Button>
          </CardTitle>
          <CardDescription>
            Map fields between MailerLite and Supabase
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.field_mappings.map((mapping, index) => (
            <Card key={mapping.id} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <Badge variant="outline">Field {index + 1}</Badge>
                {!mapping.is_required && (
                  <Button
                    onClick={() => removeFieldMapping(mapping.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <Label>MailerLite Field</Label>
                  <Input
                    placeholder="e.g., fields.name"
                    value={mapping.mailerlite_field}
                    onChange={(e) => updateFieldMapping(mapping.id, { 
                      mailerlite_field: e.target.value 
                    })}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Supabase Field</Label>
                  <Input
                    placeholder="e.g., name"
                    value={mapping.supabase_field}
                    onChange={(e) => updateFieldMapping(mapping.id, { 
                      supabase_field: e.target.value 
                    })}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Field Type</Label>
                  <Select
                    value={mapping.field_type}
                    onValueChange={(value: FieldMapping['field_type']) => 
                      updateFieldMapping(mapping.id, { field_type: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                      <SelectItem value="boolean">Boolean</SelectItem>
                      <SelectItem value="date">Date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Default Value</Label>
                  <Input
                    placeholder="Optional"
                    value={mapping.default_value || ''}
                    onChange={(e) => updateFieldMapping(mapping.id, { 
                      default_value: e.target.value 
                    })}
                  />
                </div>
              </div>

              <div className="flex items-center space-x-2 mt-3">
                <Switch
                  id={`required-${mapping.id}`}
                  checked={mapping.is_required}
                  onCheckedChange={(checked) => 
                    updateFieldMapping(mapping.id, { is_required: checked })
                  }
                  disabled={mapping.mailerlite_field === 'email'} 
                />
                <Label htmlFor={`required-${mapping.id}`}>Required Field</Label>
              </div>
            </Card>
          ))}
        </CardContent>
      </Card>

      {/* Conflict Resolution */}
      <Card>
        <CardHeader>
          <CardTitle>Conflict Resolution</CardTitle>
          <CardDescription>
            Configure how to handle data conflicts
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center space-x-2">
            <Switch
              id="auto_resolve"
              checked={config.auto_resolve_conflicts}
              onCheckedChange={(checked) => 
                setConfig(prev => ({ ...prev, auto_resolve_conflicts: checked }))
              }
            />
            <Label htmlFor="auto_resolve">Auto-resolve conflicts</Label>
          </div>

          {config.auto_resolve_conflicts && (
            <div className="space-y-2">
              <Label>Conflict Resolution Strategy</Label>
              <Select
                value={config.conflict_resolution_strategy}
                onValueChange={(value: SyncConfig['conflict_resolution_strategy']) => 
                  setConfig(prev => ({ ...prev, conflict_resolution_strategy: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mailerlite_wins">MailerLite Wins</SelectItem>
                  <SelectItem value="supabase_wins">Supabase Wins</SelectItem>
                  <SelectItem value="manual">Manual Resolution</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}