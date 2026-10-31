import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import PasswordSetupDialog from "@/components/auth/PasswordSetupDialog";
import { hasSeenPasswordPrompt, markPasswordPromptSeen, userHasPassword } from "@/lib/passwordStatus";

/**
 * One-time popup for people who signed in without a password (Google / Apple /
 * QR): "add a password for your email", verified with a code. Shown once per
 * account — closing it counts as seen; Settings > Security always offers it again.
 * Mounted in AppLayout (so only after onboarding, never over the auth screens).
 */
const PasswordPromptHost = () => {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user || !user.email) return;
    if (userHasPassword(user) || hasSeenPasswordPrompt(user.id)) return;
    // Let the app settle first so it doesn't stack on the splash / permission gates.
    const t = setTimeout(() => setOpen(true), 2500);
    return () => clearTimeout(t);
  }, [user]);

  if (!user) return null;
  return (
    <PasswordSetupDialog
      open={open}
      mode="set"
      onOpenChange={(v) => { setOpen(v); if (!v) markPasswordPromptSeen(user.id); }}
      onDone={() => markPasswordPromptSeen(user.id)}
    />
  );
};

export default PasswordPromptHost;
