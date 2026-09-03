import { motion } from "framer-motion";
import PageHeader from "@/components/PageHeader";
import { Download, RotateCcw } from "lucide-react";
import BackupManager from "@/components/BackupManager";
import DailyKeyManager from "@/components/DailyKeyManager";

/**
 * Data & Backup: cloud sync status + the BackupManager (backup now, restore
 * from cloud, manual export/import, encryption key) + the Daily.co call key
 * manager. BackupManager already has its own restore-confirmation and
 * progress UI (see components/BackupManager.tsx) — left untouched here per
 * "do not rewrite wholesale"; this page just gives it a dedicated screen
 * instead of a collapsed accordion section.
 */
const DataBackupSettings = () => (
  <motion.div
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
    className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-24 bg-background"
  >
    <PageHeader title="Data & Backup" subtitle="Sync status, backups, and call encryption keys" />

    <div className="px-5 pt-5 space-y-2">
      <div className="bg-card rounded-2xl border border-border/60 divide-y divide-border/40 mb-2">
        <div className="flex items-center gap-3 px-4 py-3">
          <Download className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0"><p className="text-sm font-medium">Cloud Sync</p><p className="text-[11px] text-muted-foreground">All data auto-syncs. Just log in to restore.</p></div>
          <div className="h-2 w-2 rounded-full bg-primary" />
        </div>
        <div className="flex items-center gap-3 px-4 py-3">
          <RotateCcw className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0"><p className="text-sm font-medium">Chat Recovery</p><p className="text-[11px] text-muted-foreground">Deleted chats can be recovered from the chat menu.</p></div>
        </div>
      </div>

      <BackupManager />
      <DailyKeyManager />
    </div>
  </motion.div>
);

export default DataBackupSettings;
