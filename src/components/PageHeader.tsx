import { cn } from "@/lib/utils";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  className?: string;
  children?: React.ReactNode;
  showBack?: boolean;
}

const PageHeader = ({ title, subtitle, className, children, showBack = true }: PageHeaderProps) => {
  const navigate = useNavigate();

  return (
    <header className={cn("safe-top px-5 pt-4 pb-3 sticky top-0 z-20 bg-background/90 backdrop-blur-md border-b border-border/25", className)}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {showBack && (
            <button
              onClick={() => { navigate(-1); }}
              aria-label="Back"
              className="h-11 w-11 rounded-full bg-accent/15 flex items-center justify-center active:scale-95 transition-transform shrink-0"
            >
              <ChevronLeft className="h-5 w-5 text-accent" />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground truncate">{title}</h1>
            {subtitle && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>
            )}
          </div>
        </div>
        {children}
      </div>
    </header>
  );
};

export default PageHeader;
