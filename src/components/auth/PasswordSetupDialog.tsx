import { KeyRound } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import PasswordOtpForm from "@/components/auth/PasswordOtpForm";

const PasswordSetupDialog = ({
  open, onOpenChange, mode, onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  mode: "set" | "change";
  onDone?: () => void;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-sm rounded-2xl">
      <DialogHeader>
        <DialogTitle className="text-base flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> {mode === "change" ? "Change password" : "Add a password for your email"}
        </DialogTitle>
        <DialogDescription>
          {mode === "change"
            ? "We'll email you a code to confirm it's you."
            : "Sign in with your email and password too. We'll email you a code to verify it. You only need to do this once."}
        </DialogDescription>
      </DialogHeader>
      <PasswordOtpForm mode={mode} onDone={() => { onDone?.(); onOpenChange(false); }} />
    </DialogContent>
  </Dialog>
);

export default PasswordSetupDialog;
