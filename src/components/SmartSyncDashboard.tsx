import React, { useMemo, useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ArrowRight, ArrowLeft, ArrowLeftRight, AlertCircle, Eye, AlertTriangle } from "lucide-react";
import { Switch } from "@/components/ui/switch";

type SyncMode = "AtoB" | "BtoA" | "bidirectional" | "full";

type SmartSyncRow =
  | { email: string; b_id?: string; changed?: boolean; skipped?: boolean; reason?: string; error?: string }
  | { email: string; r1?: unknown; r2?: unknown; error?: string };

type SmartSyncResponse = {
  ok: boolean;
  mode: SyncMode;
  count: number;
  out: SmartSyncRow[];
  error?: string;
};

function parseEmails(input: string): string[] {
  return Array.from(
    new Set(
      (input || "")
        .split(/[\s,;]+/g)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.includes("@"))
    )
  ).slice(0, 2000);
}

interface Duplicate {
  name: string;
  count: number;
  ids: string;
}

export default function SmartSyncDashboard() {
  const [emailsText, setEmailsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<SyncMode>("bidirectional");
  const [dryRun, setDryRun] = useState(false);
  const [resp, setResp] = useState<SmartSyncResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const { toast } = useToast();

  const emails = useMemo(() => parseEmails(emailsText), [emailsText]);

  // Check for duplicate advisors on mount
  useEffect(() => {
    async function checkDuplicates() {
      try {
        const { data, error } = await supabase.rpc('check_duplicate_advisors');
        if (error) throw error;
        setDuplicates(data || []);
      } catch (error: any) {
        console.error('Error checking duplicates:', error);
      }
    }
    checkDuplicates();
  }, []);

  async function runSync(runMode: SyncMode, isDryRun = false) {
    setLoading(true);
    setErr(null);
    setResp(null);
    
    try {
      const { data, error } = await supabase.functions.invoke<SmartSyncResponse>("smart-sync", {
        body: { mode: runMode, emails, dryRun: isDryRun }
      });
      
      if (error || !data?.ok) {
        throw new Error(error?.message || data?.error || "Unknown error");
      }
      
      setResp(data);
      
      toast({
        title: isDryRun ? "Dry-run voltooid" : "Sync voltooid",
        description: isDryRun 
          ? `${data.count} records geanalyseerd (geen wijzigingen doorgevoerd)`
          : `${data.count} records verwerkt in ${runMode} modus`,
      });
    } catch (e: any) {
      const errorMsg = String(e?.message || e);
      setErr(errorMsg);
      toast({
        title: "Sync gefaald",
        description: errorMsg,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  const hasDuplicates = duplicates.length > 0;

  return (
    <div className="space-y-6 max-w-5xl mx-auto p-6">
      {hasDuplicates && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Duplicate advisors gedetecteerd:</strong> {duplicates.map(d => `${d.name} (${d.count}x, IDs: ${d.ids})`).join(', ')}
            <br />
            <span className="text-sm">Sync operaties zijn geblokkeerd totdat duplicates zijn opgelost. Ga naar Advisors Management om dit op te lossen.</span>
          </AlertDescription>
        </Alert>
      )}
      
      <Card>
        <CardHeader>
          <CardTitle>Smart Sync</CardTitle>
          <CardDescription>
            Synchroniseer klantdata tussen Supabase en MailerLite met intelligente conflict detectie
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="emails">Optionele e-mail lijst (max 2000)</Label>
            <Textarea
              id="emails"
              value={emailsText}
              onChange={(e) => setEmailsText(e.target.value)}
              placeholder="jan@example.com, piet@example.com&#10;of elk email op nieuwe regel"
              rows={4}
              className="font-mono text-sm"
            />
            <p className="text-sm text-muted-foreground">
              {emails.length > 0 
                ? `${emails.length} e-mail${emails.length === 1 ? '' : 's'} geselecteerd` 
                : "Geen filter: alle klanten worden gesynchroniseerd (batch limiet in functie)"}
            </p>
          </div>

          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-2 flex-1 min-w-[200px]">
              <Label htmlFor="mode">Sync modus</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as SyncMode)}>
                <SelectTrigger id="mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AtoB">
                    <div className="flex items-center gap-2">
                      <ArrowRight className="h-4 w-4" />
                      <span>A→B (Supabase → MailerLite)</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="BtoA">
                    <div className="flex items-center gap-2">
                      <ArrowLeft className="h-4 w-4" />
                      <span>B→A (MailerLite → Supabase)</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="bidirectional">
                    <div className="flex items-center gap-2">
                      <ArrowLeftRight className="h-4 w-4" />
                      <span>Bidirectioneel</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="full">
                    <div className="flex items-center gap-2">
                      <ArrowLeftRight className="h-4 w-4" />
                      <span>Full Sync (Alle contacten)</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="flex items-center gap-2 pb-1">
              <Switch 
                id="dry-run" 
                checked={dryRun} 
                onCheckedChange={setDryRun}
              />
              <Label htmlFor="dry-run" className="cursor-pointer flex items-center gap-1">
                <Eye className="h-4 w-4" />
                Dry-run (alleen preview)
              </Label>
            </div>

          <div className="flex gap-2 flex-wrap">
              <Button
                onClick={() => runSync(mode, dryRun)}
                disabled={loading || hasDuplicates}
                size="default"
                variant={dryRun ? "secondary" : "default"}
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {dryRun && <Eye className="mr-2 h-4 w-4" />}
                Start {mode}
              </Button>

              <Button
                onClick={() => runSync("AtoB", dryRun)}
                disabled={loading || hasDuplicates}
                variant="outline"
                size="icon"
                title="Forceer A→B"
              >
                <ArrowRight className="h-4 w-4" />
              </Button>

              <Button
                onClick={() => runSync("BtoA", dryRun)}
                disabled={loading || hasDuplicates}
                variant="outline"
                size="icon"
                title="Forceer B→A"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>

              <Button
                onClick={() => runSync("bidirectional", dryRun)}
                disabled={loading || hasDuplicates}
                variant="outline"
                size="icon"
                title="Forceer bidirectioneel"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </Button>

              <Button
                onClick={async () => {
                  setLoading(true);
                  setErr(null);
                  setResp(null);
                  try {
                    const { data, error } = await supabase.functions.invoke<SmartSyncResponse>("smart-sync", {
                      body: { mode: "BtoA", emails, repair: true, dryRun }
                    });
                    if (error || !data?.ok) throw new Error(error?.message || data?.error || "unknown error");
                    setResp(data);
                    toast({
                      title: dryRun ? "Repair preview voltooid" : "Repair voltooid",
                      description: dryRun
                        ? `${data.count} records zouden hersteld worden`
                        : `${data.count} records hersteld vanuit MailerLite`,
                    });
                  } catch (e: any) {
                    const errorMsg = String(e?.message || e);
                    setErr(errorMsg);
                    toast({
                      title: "Repair gefaald",
                      description: errorMsg,
                      variant: "destructive",
                    });
                  } finally {
                    setLoading(false);
                  }
                }}
                disabled={loading || hasDuplicates}
                variant="secondary"
                title="Vul lege Supabase-velden met gegevens uit MailerLite"
              >
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Repair from MailerLite
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {err && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}

      {resp && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {(resp as any).dryRun && <Eye className="h-5 w-5 text-muted-foreground" />}
              Resultaat: {resp.ok ? "Succesvol" : "Gefaald"} • {resp.mode} • {resp.count} rijen
              {(resp as any).dryRun && <span className="text-sm font-normal text-muted-foreground">(dry-run)</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left p-3 font-medium">Email</th>
                      <th className="text-left p-3 font-medium">Status</th>
                      <th className="text-left p-3 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {resp.out.slice(0, 200).map((row, i) => {
                      const email = (row as any).email || "-";
                      const error = (row as any).error;
                      const skipped = (row as any).skipped;
                      const changed = (row as any).changed;
                      const reason = (row as any).reason;
                      const bid = (row as any).b_id;

                      let status = "ok";
                      let statusColor = "text-foreground";
                      
                      if (error) {
                        status = "error";
                        statusColor = "text-destructive";
                      } else if (skipped) {
                        status = "overgeslagen";
                        statusColor = "text-muted-foreground";
                      } else if (changed) {
                        status = "bijgewerkt";
                        statusColor = "text-success";
                      } else {
                        status = "geen wijziging";
                      }

                      const details = error
                        ? error
                        : skipped
                        ? reason || "overgeslagen"
                        : changed
                        ? `gewijzigd${bid ? ` • b_id ${bid}` : ""}`
                        : bid
                        ? `geen wijziging • b_id ${bid}`
                        : "—";

                      return (
                        <tr key={`${email}-${i}`} className="hover:bg-muted/50">
                          <td className="p-3 font-mono text-xs">{email}</td>
                          <td className={`p-3 ${statusColor}`}>{status}</td>
                          <td className="p-3 text-muted-foreground">{details}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <details className="space-y-2">
              <summary className="cursor-pointer text-sm font-medium hover:underline">
                Ruwe JSON output
              </summary>
              <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-xs">
                {JSON.stringify(resp, null, 2)}
              </pre>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
