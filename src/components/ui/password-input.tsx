import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { hapticLight } from "@/lib/haptics";

/**
 * Drop-in replacement for `<Input type="password" />` with a show/hide eye
 * toggle — every password field in the app (login, signup, reset, add
 * email+password) used a bare `<Input type="password">` with no way to
 * reveal what you typed, and all five call sites shared the exact same
 * `"h-11 rounded-xl bg-card border-border"` styling, so this wraps the one
 * shared `Input` primitive rather than duplicating markup five times.
 *
 * `type` isn't in the prop list — it's computed internally from the
 * reveal state, so this can't accidentally be used as a non-password input.
 */
const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<typeof Input>, "type">
>(({ className, disabled, ...props }, ref) => {
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={cn("pr-11", className)}
        {...props}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => { hapticLight(); setVisible((v) => !v); }}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground active:scale-90 transition-transform disabled:opacity-50 disabled:pointer-events-none"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
