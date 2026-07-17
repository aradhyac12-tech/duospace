/**
 * BackupManager — Cloud backup + manual JSON export/import.
 * Replaces the previous Google Drive flow (no external account required).
 */
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CloudUpload, RotateCcw, Check, AlertCircle, ChevronRight,
  Loader2, Download, Upload, Trash2, KeyRound, Copy, X,
} from "lucide-react";
import { useCloudBackup, CloudBackupInfo } from "@/hooks/useCloudBackup";
import { useToast } from "@/hooks/use-toast";

const formatBytes = (b: number) => {
  if (!b) return "0 B";
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};
const formatDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    " at " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const BackupManager = () => {
  const { toast } = useToast();
  const {
    status, error, progress, backups, lastBackup,
    listBackups, backup, restore, deleteBackup,
    exportJSON, importJSON, exportDeviceSecret,
  } = useCloudBackup();

  const [showList, setShowList] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<CloudBackupInfo | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [secret, setSecret] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const isRunning = status === "backing_up" || status === "restoring";

  useEffect(() => {
    if (status === "done") toast({ title: "Done ✓" });
    if (status === "error" && error) toast({ title: "Failed", description: error, variant: "destructive" });
  }, [status, error, toast]);

  const handleShowList = async () => {
    setLoadingList(true);
    await listBackups();
    setLoadingList(false);
    setShowList(true);
  };

  const handleRestore = async (b: CloudBackupInfo) => {
    setConfirmRestore(null);
    setShowList(false);
    await restore(b.path);
  };

  const handleDelete = async (b: CloudBackupInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteBackup(b.path);
    toast({ title: "Backup deleted" });
  };

  const handleImportClick = () => importRef.current?.click();
  const handleImportChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await importJSON(file);
    e.target.value = "";
  };

  const handleShowSecret = async () => {
    const s = await exportDeviceSecret();
    setSecret(s);
    setShowSecret(true);
  };
  const copySecret = () => {
    navigator.clipboard.writeText(secret);
    toast({ title: "Encryption key copied" });
  };

  return (
    <section>
      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2.5">
        Backup &amp; Restore
      </p>

      <div className="bg-card rounded-2xl border border-border/60 overflow-hidden divide-y divide-border/40">
        {/* Status row */}
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <CloudUpload className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Cloud Backup</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {lastBackup ? `Last: ${formatDate(lastBackup)}` : "Encrypted, stored privately to your account"}
            </p>
          </div>
        </div>

        {/* Progress */}
        <AnimatePresence>
          {isRunning && (
            <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
              <div className="px-4 py-3 space-y-1.5">
                <div className="flex justify-between items-center">
                  <p className="text-[11px] text-muted-foreground">
                    {status === "backing_up" ? "Backing up…" : "Restoring…"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{progress}%</p>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <motion.div className="h-full bg-primary rounded-full" animate={{ width: `${progress}%` }} transition={{ duration: 0.3 }} />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {error && !isRunning && (
          <div className="px-4 py-2 flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
            <p className="text-[11px] text-destructive leading-relaxed">{error}</p>
          </div>
        )}

        {/* Backup now */}
        <button onClick={backup} disabled={isRunning} className="w-full flex items-center gap-3 px-4 py-3 active:bg-muted/40 disabled:opacity-40">
          {isRunning && status === "backing_up"
            ? <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />
            : <CloudUpload className="h-4 w-4 text-primary shrink-0" />}
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Backup Now</p>
            <p className="text-[11px] text-muted-foreground">Encrypted snapshot to cloud</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Restore */}
        <button onClick={handleShowList} disabled={isRunning} className="w-full flex items-center gap-3 px-4 py-3 active:bg-muted/40 disabled:opacity-40">
          {loadingList
            ? <Loader2 className="h-4 w-4 text-muted-foreground animate-spin shrink-0" />
            : <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />}
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Restore from Cloud</p>
            <p className="text-[11px] text-muted-foreground">Choose a previous backup</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Manual export */}
        <button onClick={exportJSON} disabled={isRunning} className="w-full flex items-center gap-3 px-4 py-3 active:bg-muted/40 disabled:opacity-40">
          <Download className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Export to File</p>
            <p className="text-[11px] text-muted-foreground">Download .json — save off-device</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Manual import */}
        <button onClick={handleImportClick} disabled={isRunning} className="w-full flex items-center gap-3 px-4 py-3 active:bg-muted/40 disabled:opacity-40">
          <Upload className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Import from File</p>
            <p className="text-[11px] text-muted-foreground">Load a previously exported .json</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
        <input ref={importRef} type="file" accept="application/json,.json" onChange={handleImportChange} className="hidden" />

        {/* Show device key */}
        <button onClick={handleShowSecret} className="w-full flex items-center gap-3 px-4 py-3 active:bg-muted/40">
          <KeyRound className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-sm font-medium">Show Encryption Key</p>
            <p className="text-[11px] text-muted-foreground">Save it to restore on a new device</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Restore list */}
      <AnimatePresence>
        {showList && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60" onClick={() => setShowList(false)}>
            <motion.div initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 420, damping: 38 }}
              className="absolute bottom-0 left-0 right-0 bg-card rounded-t-3xl pb-safe"
              onClick={(e) => e.stopPropagation()}>
              <div className="pt-3 pb-2 px-4 flex items-center justify-between border-b border-border/40">
                <p className="text-sm font-semibold">Your Backups</p>
                <button onClick={() => setShowList(false)} className="text-[11px] text-muted-foreground">Done</button>
              </div>
              <div className="max-h-[60vh] overflow-y-auto">
                {backups.length === 0 ? (
                  <div className="py-10 text-center">
                    <p className="text-sm text-muted-foreground">No backups yet</p>
                    <p className="text-[11px] text-muted-foreground mt-1">Tap "Backup Now" to create one</p>
                  </div>
                ) : backups.map((b) => (
                  <div key={b.path} className="flex items-center gap-3 px-4 py-3.5 border-b border-border/30 active:bg-muted/40">
                    <button onClick={() => setConfirmRestore(b)} className="flex-1 flex items-center gap-3 text-left min-w-0">
                      <CloudUpload className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{formatDate(b.createdAt)}</p>
                        <p className="text-[11px] text-muted-foreground">{formatBytes(b.size)}</p>
                      </div>
                    </button>
                    <button onClick={(e) => handleDelete(b, e)} className="h-8 w-8 rounded-full flex items-center justify-center active:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Confirm restore */}
      <AnimatePresence>
        {confirmRestore && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center px-6">
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="bg-card rounded-2xl p-5 w-full max-w-sm">
              <p className="text-base font-semibold mb-1">Restore this backup?</p>
              <p className="text-sm text-muted-foreground mb-4">
                From {formatDate(confirmRestore.createdAt)}. This will merge data into your current history.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setConfirmRestore(null)} className="flex-1 h-10 rounded-xl border border-border text-sm">Cancel</button>
                <button onClick={() => handleRestore(confirmRestore)} className="flex-1 h-10 rounded-xl bg-primary text-primary-foreground text-sm font-medium">Restore</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Device secret modal */}
      <AnimatePresence>
        {showSecret && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center px-6">
            <motion.div initial={{ scale: 0.92 }} animate={{ scale: 1 }} exit={{ scale: 0.92 }}
              className="bg-card rounded-2xl p-5 w-full max-w-sm">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-amber-500" />
                  <p className="text-base font-semibold">Encryption key</p>
                </div>
                <button onClick={() => setShowSecret(false)} className="h-7 w-7 rounded-full flex items-center justify-center active:bg-muted">
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
              <p className="text-[12px] text-muted-foreground mb-3">
                Used to decrypt cloud backups. Save it in a password manager — required if you switch device or browser.
              </p>
              <div className="bg-muted rounded-xl px-3 py-2 mb-3 break-all font-mono text-[11px] select-all">{secret}</div>
              <button onClick={copySecret} className="w-full h-10 rounded-xl bg-amber-500 text-white text-sm font-medium flex items-center justify-center gap-1.5">
                <Copy className="h-3.5 w-3.5" /> Copy key
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

export default BackupManager;
