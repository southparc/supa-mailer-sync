import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Loader2 } from 'lucide-react';

export const BackfillTriggerButton: React.FC = () => {
  const [showDialog, setShowDialog] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const { toast } = useToast();

  const handleTriggerBackfill = async () => {
    setIsTriggering(true);
    
    try {
      const { data, error } = await supabase.functions.invoke('backfill-sync', {
        method: 'POST',
      });

      if (error) throw error;

      toast({
        title: "Backfill Started",
        description: "The backfill process has been initiated. Monitor progress below.",
        duration: 5000,
      });

      setShowDialog(false);
    } catch (error) {
      console.error('Error triggering backfill:', error);
      toast({
        title: "Failed to Start Backfill",
        description: error instanceof Error ? error.message : "An unexpected error occurred",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setIsTriggering(false);
    }
  };

  return (
    <>
      <Button
        onClick={() => setShowDialog(true)}
        variant="outline"
        className="gap-2"
        disabled={isTriggering}
      >
        {isTriggering ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        Run Backfill
      </Button>

      <AlertDialog open={showDialog} onOpenChange={setShowDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start Backfill Process?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                This will initiate a bulk synchronization process to create shadow records
                for all crosswalk entries that are missing them.
              </p>
              <p className="text-sm text-muted-foreground">
                The process will:
              </p>
              <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
                <li>Fetch all crosswalks with missing shadows</li>
                <li>Process them in batches of 50</li>
                <li>Create shadow records from client and MailerLite data</li>
                <li>Validate completion at the end</li>
              </ul>
              <p className="text-sm font-semibold text-foreground mt-4">
                This may take several minutes depending on the number of missing records.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isTriggering}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTriggerBackfill}
              disabled={isTriggering}
              className="gap-2"
            >
              {isTriggering ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                'Start Backfill'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
