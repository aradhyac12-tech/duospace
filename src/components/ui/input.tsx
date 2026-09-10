import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // h-11 = --touch-target-min (44px), consistent with Button/Textarea/Tabs.
          // Focus treatment: a soft accent border + faint ring INSTEAD of the old
          // ring-2/ring-offset-2 — that offset ring drew a hard detached rectangle
          // around the field on focus (part of the app-wide "box appears while
          // typing" complaint; see index.css's matching :focus-visible fix).
          "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-[hsl(var(--input-hover))] focus-visible:outline-none focus-visible:border-[hsl(var(--ring)/0.5)] focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring)/0.3)] disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
