import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { describeNotificationIssue } from "./notificationIssue";

/** Tells the person why the music notification isn't showing, with a one-tap route to the fix when it's an OS setting. */
export function showNotificationIssueToast(reason: string, openSettings: () => Promise<void>): void {
  const info = describeNotificationIssue(reason);
  toast({
    title: info.title,
    description: info.description,
    duration: 12000,
    action: info.canOpenSettings ? (
      <ToastAction altText="Open notification settings" onClick={() => { openSettings().catch(() => {}); }}>
        Open settings
      </ToastAction>
    ) : undefined,
  });
}
