import { Button } from "@/components/ui/button";
import { Loader2, LucideIcon } from "lucide-react";

interface SyncButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon: LucideIcon;
  label: string;
  description?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'destructive';
}

export function SyncButton({
  onClick,
  disabled,
  loading,
  icon: Icon,
  label,
  description,
  variant = 'default'
}: SyncButtonProps) {
  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={onClick}
        disabled={disabled || loading}
        variant={variant}
        className="w-full"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Icon className="h-4 w-4 mr-2" />
        )}
        {label}
      </Button>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
