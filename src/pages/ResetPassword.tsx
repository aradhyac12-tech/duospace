import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { Loader2, Lock } from "lucide-react";
import { cleanAuthCallbackUrl, completeAuthCallback, hasAuthCallback, parseAuthCallbackUrl } from "@/lib/auth-callback";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { isNativePlatform } from "@/lib/auth-redirect";

const ResetPassword = () => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingLink, setCheckingLink] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    const parseRecovery = async () => {
      // BUG FIX: on native (Capacitor), the recovery deep link
      // (duospace://auth/reset-password?...code=XXX) is caught by the
      // global appUrlOpen listener (useNativeAuthDeepLink, mounted once in
      // App.tsx — see that hook's header comment for why it's global and
      // not scoped to Auth.tsx), NOT by this page — that listener already
      // calls completeAuthCallback(url) itself (establishing the session) and
      // THEN does a plain client-side `navigate("/reset-password")` with no
      // query string attached, since the code was consumed directly from
      // the duospace:// URL string, never touching window.location. By the
      // time THIS component mounts, window.location.href is just
      // "https://localhost/reset-password" — hasAuthCallback() below
      // (which only looks at window.location.href) correctly finds nothing,
      // and the PASSWORD_RECOVERY onAuthStateChange event has ALREADY fired
      // and been missed (it fired the moment Auth.tsx did the exchange,
      // before this component's own listener could subscribe). Both of
      // this page's existing detection paths return false negatives on
      // native — the user lands on "Invalid reset link" even though a
      // valid recovery session was already established seconds earlier.
      // Fix: also check getSession() directly on native — if Auth.tsx
      // already did the work, a session simply exists by the time we get
      // here, which is sufficient grounds to show the reset form. Scoped to
      // native only (not a blanket getSession()-means-recovery rule) so
      // this doesn't change web's behavior, where the browser preserves the
      // full URL and the existing hasAuthCallback() check already works
      // correctly on its own.
      if (isNativePlatform()) {
        const { data } = await supabase.auth.getSession();
        if (data.session && !cancelled) {
          setIsRecovery(true);
          return;
        }
      }
      if (!hasAuthCallback()) return;
      const callback = parseAuthCallbackUrl();
      const isRecoveryLink = callback.get("type") === "recovery";
      if (!isRecoveryLink) return;
      try {
        await completeAuthCallback();
        if (!cancelled) {
          setIsRecovery(true);
          cleanAuthCallbackUrl("/reset-password");
        }
      } catch (error) {
        if (!cancelled) {
          toast({
            title: "Invalid reset link",
            description: getAuthErrorMessage(error),
            variant: "destructive",
          });
        }
      }
    };

    void parseRecovery().finally(() => {
      if (!cancelled) setCheckingLink(false);
    });

    // Listen for PASSWORD_RECOVERY event
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setIsRecovery(true);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [toast]);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    // BUG FIX: this only checked length >= 6, but signup (Auth.tsx's
    // handleSignUp) requires 8+ characters with at least one letter and one
    // number — the actual policy enforced server-side too (Supabase's
    // project-level minimum matches signup's client check). A 6-7 char or
    // letters-only password passed this check, then got rejected by
    // supabase.auth.updateUser() with a real error, after the person had
    // already gone through the whole "click the email link" flow. Matching
    // signup's check here catches it before that round trip, with the same
    // message signup already uses.
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      toast({
        title: "Weak password",
        description: "Use at least 8 characters with letters and numbers.",
        variant: "destructive",
      });
      return;
    }
    if (password !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        toast({ title: "Failed to reset password", description: getAuthErrorMessage(error), variant: "destructive" });
      } else {
        toast({ title: "Password updated", description: "You can now sign in with your new password." });
        navigate("/chat");
      }
    } catch (err: unknown) {
      toast({ title: "Error", description: getAuthErrorMessage(err), variant: "destructive" });
    }
    setLoading(false);
  };

  if (checkingLink) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background px-6">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isRecovery) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background px-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center space-y-4">
          <Lock className="h-12 w-12 text-muted-foreground mx-auto" />
          <h1 className="text-xl font-semibold">Invalid reset link</h1>
          <p className="text-sm text-muted-foreground">This link is expired or invalid. Request a new password reset.</p>
          <Button onClick={() => navigate("/auth")} className="rounded-xl bg-primary text-primary-foreground">Back to Sign In</Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Password</h1>
          <p className="text-sm text-muted-foreground">Enter your new password below</p>
        </div>

        <form onSubmit={handleReset} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-pw" className="text-[11px] text-muted-foreground uppercase tracking-wider">New Password</Label>
            <PasswordInput id="new-pw" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 8 chars, letters + numbers" className="h-11 rounded-xl bg-card border-border" required minLength={8} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-pw" className="text-[11px] text-muted-foreground uppercase tracking-wider">Confirm Password</Label>
            <PasswordInput id="confirm-pw" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password" className="h-11 rounded-xl bg-card border-border" required />
          </div>
          <Button type="submit" disabled={loading}
            className="w-full h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update Password"}
          </Button>
        </form>
      </motion.div>
    </div>
  );
};

export default ResetPassword;
