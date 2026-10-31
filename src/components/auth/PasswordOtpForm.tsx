import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/appClient";
import { passwordProblem } from "@/lib/passwordStatus";

/**
 * Set or change the email+password login for the signed-in account, with the
 * email verified by a 6-digit code (set-email-password edge function).
 *
 *   step 1: choose password (+ confirm)  -> we email a code to the ACCOUNT email
 *   step 2: enter the code               -> password saved
 *
 * The same component backs the onboarding step, the one-time "add a password"
 * popup for existing OAuth users, and Settings > Security > Change password.
 */
const PasswordOtpForm = ({
  mode, onDone, submitLabel,
}: {
  mode: "set" | "change";
  onDone: () => void;
  submitLabel?: string;
}) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<"password" | "code">("password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const email = user?.email ?? "";

  const errText = (err: unknown) =>
    err instanceof Error && err.message ? err.message : "Please try again.";

  const sendCode = async () => {
    const problem = passwordProblem(password);
    if (problem) { toast({ title: "Weak password", description: problem, variant: "destructive" }); return; }
    if (password !== confirm) { toast({ title: "Passwords don't match", variant: "destructive" }); return; }
    setLoading(true);
    try {
      // Supabase emails the code itself (your Gmail SMTP + the "Reauthentication" template).
      const { error } = await supabase.auth.reauthenticate();
      if (error) throw error;
      toast({ title: "Code sent", description: `Check ${email} for a 6-digit code.` });
      setStep("code");
    } catch (err) {
      toast({ title: "Couldn't send code", description: errText(err), variant: "destructive" });
    }
    setLoading(false);
  };

  const verify = async () => {
    setLoading(true);
    try {
      // The code is the nonce: Supabase rejects the change unless it matches.
      const { error } = await supabase.auth.updateUser({
        password,
        nonce: otp.trim(),
        data: { has_password: true },
      });
      if (error) throw error;
      // Pull the updated user_metadata.has_password into the local session.
      try { await supabase.auth.refreshSession(); } catch { /* next token refresh picks it up */ }
      toast({
        title: mode === "change" ? "Password changed" : "Password added",
        description: "You can now sign in with your email and password.",
      });
      onDone();
    } catch (err) {
      toast({ title: "Couldn't verify", description: errText(err), variant: "destructive" });
    }
    setLoading(false);
  };

  if (!email) {
    return <p className="text-sm text-muted-foreground">This account has no email yet. Add one from Devices first.</p>;
  }

  return step === "password" ? (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">Email</Label>
        <Input value={email} readOnly className="h-11 rounded-xl bg-muted/40 border-border" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">{mode === "change" ? "New password" : "Password"}</Label>
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)}
          placeholder="Min 8 chars, letters + numbers" className="h-11 rounded-xl bg-card border-border" autoComplete="new-password" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">Confirm password</Label>
        <PasswordInput value={confirm} onChange={(e) => setConfirm(e.target.value)}
          placeholder="Repeat password" className="h-11 rounded-xl bg-card border-border" autoComplete="new-password" />
      </div>
      <Button onClick={sendCode} disabled={loading || !password || !confirm}
        className="w-full h-11 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : (submitLabel ?? "Send verification code")}
      </Button>
    </div>
  ) : (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
      </p>
      <div className="space-y-1.5">
        <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">Code</Label>
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
          placeholder="123456" className="h-11 rounded-xl bg-card border-border tracking-widest text-center" />
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => { setStep("password"); setOtp(""); }} className="flex-1" disabled={loading}>Back</Button>
        <Button onClick={verify} disabled={loading || otp.length !== 6}
          className="flex-1 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
        </Button>
      </div>
      <button type="button" onClick={sendCode} disabled={loading}
        className="w-full text-[11px] text-muted-foreground underline underline-offset-2 disabled:opacity-50">
        Resend code
      </button>
    </div>
  );
};

export default PasswordOtpForm;
