import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { Loader2, Lock } from "lucide-react";

const ResetPassword = () => {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [isRecovery, setIsRecovery] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    // Check if this is a recovery flow from the URL hash
    const hash = window.location.hash;
    if (hash.includes("type=recovery")) {
      setIsRecovery(true);
    }

    // Listen for PASSWORD_RECOVERY event
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setIsRecovery(true);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast({ title: "Password too short", description: "Minimum 6 characters", variant: "destructive" });
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
        toast({ title: "Failed to reset password", description: error.message, variant: "destructive" });
      } else {
        toast({ title: "Password updated", description: "You can now sign in with your new password." });
        navigate("/chat");
      }
    } catch (err: unknown) {
      toast({ title: "Error", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
    }
    setLoading(false);
  };

  if (!isRecovery) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm text-center space-y-4">
          <Lock className="h-12 w-12 text-muted-foreground mx-auto" />
          <h1 className="text-xl font-semibold">Invalid reset link</h1>
          <p className="text-sm text-muted-foreground">This link is expired or invalid. Request a new password reset.</p>
          <Button onClick={() => navigate("/auth")} className="rounded-xl bg-foreground text-background">Back to Sign In</Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">New Password</h1>
          <p className="text-sm text-muted-foreground">Enter your new password below</p>
        </div>

        <form onSubmit={handleReset} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-pw" className="text-[11px] text-muted-foreground uppercase tracking-wider">New Password</Label>
            <Input id="new-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="Min 6 characters" className="h-11 rounded-xl bg-card border-border" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-pw" className="text-[11px] text-muted-foreground uppercase tracking-wider">Confirm Password</Label>
            <Input id="confirm-pw" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password" className="h-11 rounded-xl bg-card border-border" required />
          </div>
          <Button type="submit" disabled={loading}
            className="w-full h-11 rounded-xl bg-foreground text-background hover:bg-foreground/90 text-sm font-medium">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Update Password"}
          </Button>
        </form>
      </motion.div>
    </div>
  );
};

export default ResetPassword;
