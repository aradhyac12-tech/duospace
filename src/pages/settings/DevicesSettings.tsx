import { useState } from "react";
import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import { QrCode, UserPlus, Fingerprint, KeyRound, ChevronRight } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import RecentDevices from "@/components/RecentDevices";
import QRSignInDisplay from "@/components/auth/QRSignInDisplay";
import QRSignInScanner from "@/components/auth/QRSignInScanner";
import PasskeyRegister from "@/components/auth/PasskeyRegister";
import AddEmailPasswordDialog from "@/components/auth/AddEmailPasswordDialog";

/**
 * Devices & Sign-in: everything that lets a *new* device or a *new person*
 * into the account — QR sign-in, QR signup invites, passkeys, and the
 * email+password fallback for QR-only accounts — plus the read-only
 * Recent devices list. Kept together because they're all "how does
 * something authenticate as me" concerns, distinct from Security &
 * Privacy's "how is this device locked" concerns.
 */
const DevicesSettings = () => {
  const { user } = useAuth();
  const { toast } = useToast();

  const [showDeviceQr, setShowDeviceQr] = useState(false);
  const [devicesQrPanel, setDevicesQrPanel] = useState<"scan" | "show">("show");
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [showPasskeyDialog, setShowPasskeyDialog] = useState(false);
  const [showAddEmailPw, setShowAddEmailPw] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
    >
      <PageHeader title="Devices & Sign-in" subtitle="How you and new devices get into this account" />

      <div className="px-5 pt-5 space-y-2">
        <button onClick={() => { setDevicesQrPanel("show"); setShowDeviceQr(true); }}
          className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
          <QrCode className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">QR code</p>
            <p className="text-[11px] text-muted-foreground">Show yours to sign in elsewhere, or scan one to sign in, link, or invite</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        <button onClick={() => { setShowInviteQr(true); }}
          className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
          <UserPlus className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Invite a new user via QR</p>
            <p className="text-[11px] text-muted-foreground">Scanning routes them straight to the Sign Up screen</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        <button onClick={() => { setShowPasskeyDialog(true); }}
          className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
          <Fingerprint className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Add a passkey</p>
            <p className="text-[11px] text-muted-foreground">Use Face ID / Touch ID / Windows Hello to sign in</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        {user && (!user.email || user.app_metadata?.provider === "qr") && (
          <button onClick={() => { setShowAddEmailPw(true); }}
            className="w-full bg-card rounded-2xl border border-border/60 p-4 flex items-center gap-3 active:scale-[0.98] transition-transform">
            <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 text-left">
              <p className="text-sm font-medium">Add email + password</p>
              <p className="text-[11px] text-muted-foreground">Verified via a 6-digit code — needed if you signed up via QR</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        )}

        <div className="mt-3">
          <RecentDevices />
        </div>
      </div>

      <Dialog open={showDeviceQr} onOpenChange={setShowDeviceQr}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">QR code</DialogTitle>
            <DialogDescription>Show your code, or scan one from another device.</DialogDescription>
          </DialogHeader>
          {showDeviceQr && (
            <Tabs value={devicesQrPanel} onValueChange={(v) => setDevicesQrPanel(v as "scan" | "show")} className="w-full">
              <TabsList className="grid w-full grid-cols-2 rounded-xl bg-muted/50">
                <TabsTrigger value="scan" className="rounded-lg text-xs">Scan a QR</TabsTrigger>
                <TabsTrigger value="show" className="rounded-lg text-xs">Show my QR</TabsTrigger>
              </TabsList>
              <TabsContent value="scan" className="mt-4">
                <QRSignInScanner
                  onClose={() => setShowDeviceQr(false)}
                  onSuccess={() => setShowDeviceQr(false)}
                  onPartnerLinked={() => setShowDeviceQr(false)}
                  onSignupInvite={() => { setShowDeviceQr(false); toast({ title: "That QR is for someone else's signup", description: "Have them scan it from the Auth screen instead." }); }}
                />
              </TabsContent>
              <TabsContent value="show" className="mt-4">
                <p className="text-xs text-muted-foreground text-center mb-3 px-2">Open the Auth screen on your other device, tap "Sign in with QR", and scan this code.</p>
                <QRSignInDisplay
                  mode="device_pairing"
                  onClose={() => setShowDeviceQr(false)}
                  onRedeemed={() => { toast({ title: "New device signed in ✓" }); }}
                />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showInviteQr} onOpenChange={setShowInviteQr}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Invite a new user</DialogTitle>
            <DialogDescription>They open the Auth screen, tap "Sign in with QR", scan this — they'll land on the Sign Up form.</DialogDescription>
          </DialogHeader>
          {showInviteQr && (
            <QRSignInDisplay
              mode="signup_invite"
              onClose={() => setShowInviteQr(false)}
              onRedeemed={() => { toast({ title: "Scanned ✓", description: "They're finishing signup on their device." }); }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showPasskeyDialog} onOpenChange={setShowPasskeyDialog}>
        <DialogContent className="rounded-2xl max-w-[360px]">
          <DialogHeader>
            <DialogTitle className="text-base">Add a passkey</DialogTitle>
            <DialogDescription>Use your device's biometrics to sign in without a password.</DialogDescription>
          </DialogHeader>
          {showPasskeyDialog && <PasskeyRegister onDone={() => setShowPasskeyDialog(false)} />}
        </DialogContent>
      </Dialog>

      <AddEmailPasswordDialog open={showAddEmailPw} onOpenChange={setShowAddEmailPw} />
    </motion.div>
  );
};

export default DevicesSettings;
