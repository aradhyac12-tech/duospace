import { useState } from "react";
import { ExternalLink, Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { isEmbeddedInIframe, loginWithPasskey, passkeysSupported } from "@/lib/webauthn";

// Auth screen surface. Discoverable-credential (usernameless) login: the
// browser prompts the user to pick a passkey.
const PasskeyLogin = ({ email }: { email?: string }) => {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  if (!passkeysSupported()) return null;

  // Inside the Lovable preview iframe, WebAuthn is blocked by Permissions
  // Policy ("publickey-credentials-get is not enabled in this document").
  // Only the parent frame can grant that capability, so we route the user
  // to a top-level tab instead of crashing them into that error.
  if (isEmbeddedInIframe()) {
    return (
      <Button
        variant="outline"
        onClick={() => window.open(window.location.href, "_blank", "noopener,noreferrer")}
        className="w-full h-11 rounded-xl gap-2"
      >
        <ExternalLink className="h-4 w-4" />
        Open in new tab to use passkey
      </Button>
    );
  }

  const handle = async () => {
    setLoading(true);
    try {
      await loginWithPasskey(email?.trim() || undefined);
      toast({ title: "Signed in", description: "Welcome back." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      // NotAllowedError = user cancelled; keep it quiet.
      if (!/NotAllowedError|cancel/i.test(msg)) {
        toast({ title: "Passkey sign-in failed", description: msg, variant: "destructive" });
      }
    }
    setLoading(false);
  };

  return (
    <Button variant="outline" onClick={handle} disabled={loading}
      className="w-full h-11 rounded-xl gap-2 relative overflow-hidden transition-all">
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Waiting for passkey…</span>
        </>
      ) : (
        <>
          <Fingerprint className="h-4 w-4" />
          <span>Sign in with passkey</span>
        </>
      )}
    </Button>
  );
};

export default PasskeyLogin;
