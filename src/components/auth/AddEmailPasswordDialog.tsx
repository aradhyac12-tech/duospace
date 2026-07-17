import { useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

// Signed-in surface for QR-signed-up users who don't have email+password yet.
// Two-step OTP: request → verify+set.

const AddEmailPasswordDialog = ({
  open, onOpenChange, onSuccess,
}: {
  open: boolean; onOpenChange: (v: boolean) => void; onSuccess?: () => void;
}) => {
  const [step, setStep] = useState<"email" | "verify">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const reset = () => {
    setStep("email"); setEmail(""); setOtp(""); setPassword(""); setLoading(false);
  };

  const request = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast({ title: "Enter a valid email", variant: "destructive" }); return;
    }
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("set-email-password", {
      body: { step: "request", email: email.trim() },
    });
    setLoading(false);
    if (error || data?.error) {
      toast({
        title: "Couldn't send code",
        description: error?.message ?? data?.error ?? "",
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Code sent", description: "Check your email." });
    setStep("verify");
  };

  const verify = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("set-email-password", {
      body: { step: "verify", email: email.trim(), otp: otp.trim(), password },
    });
    setLoading(false);
    if (error || data?.error) {
      toast({
        title: "Couldn't verify",
        description: error?.message ?? data?.error ?? "",
        variant: "destructive",
      });
      return;
    }
    toast({ title: "Email + password set", description: "You can now sign in with email." });
    onSuccess?.();
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" /> Add email + password
          </DialogTitle>
        </DialogHeader>
        {step === "email" ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com" className="h-11 rounded-xl bg-card border-border" />
            </div>
            <Button onClick={request} disabled={loading}
              className="w-full h-11 rounded-xl bg-foreground text-background hover:bg-foreground/90">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send code"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              We sent a 6-digit code to <span className="font-medium">{email}</span>.
            </p>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">Code</Label>
              <Input inputMode="numeric" maxLength={6} value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                placeholder="123456" className="h-11 rounded-xl bg-card border-border tracking-widest text-center" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground uppercase tracking-wider">New password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters" className="h-11 rounded-xl bg-card border-border" />
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setStep("email")} className="flex-1">Back</Button>
              <Button onClick={verify} disabled={loading || otp.length !== 6 || password.length < 8}
                className="flex-1 rounded-xl bg-foreground text-background hover:bg-foreground/90">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default AddEmailPasswordDialog;
