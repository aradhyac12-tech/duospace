import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

const VARIANT_ICON = {
  default: { Icon: Info, chip: "bg-primary/10 text-primary" },
  destructive: { Icon: AlertCircle, chip: "bg-destructive/10 text-destructive" },
  success: { Icon: CheckCircle2, chip: "bg-success/10 text-success" },
  warning: { Icon: TriangleAlert, chip: "bg-warning/10 text-warning" },
} as const;

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const { Icon, chip } = VARIANT_ICON[(variant ?? "default") as keyof typeof VARIANT_ICON];
        return (
          <Toast key={id} variant={variant} {...props}>
            <div className={cn("h-9 w-9 shrink-0 rounded-full flex items-center justify-center", chip)} aria-hidden="true">
              <Icon className="h-[18px] w-[18px]" />
            </div>
            <div className="grid gap-0.5 flex-1 min-w-0">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
