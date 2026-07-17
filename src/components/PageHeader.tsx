import { cn } from "@/lib/utils";
import { ChevronLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { hapticLight } from "@/lib/haptics";

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
    <header className={cn("safe-top px-5 pt-4 pb-3", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {showBack && (
            <button
              onClick={() => { hapticLight(); navigate(-1); }}
              className="h-8 w-8 rounded-full bg-accent/60 flex items-center justify-center active:scale-95 transition-transform shrink-0"
            >
              <ChevronLeft className="h-4 w-4 text-foreground" />
            </button>
          )}
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {subtitle && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
        </div>
        {children}
      </div>
    </header>
  );
};

export default PageHeader;
