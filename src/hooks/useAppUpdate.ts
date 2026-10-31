import { useMemo, useSyncExternalStore } from "react";
import { appUpdateController } from "@/lib/appUpdate";
import type { CellularPolicy } from "@/lib/appUpdate";

/** React view of the singleton update controller. */
export function useAppUpdate() {
  const state = useSyncExternalStore(
    appUpdateController.subscribe,
    appUpdateController.getSnapshot,
    appUpdateController.getSnapshot,
  );
  const actions = useMemo(
    () => ({
      check: (silent = false) => appUpdateController.check({ silent }),
      startDownload: (allowCellular?: boolean) => appUpdateController.startDownload({ allowCellular }),
      install: () => appUpdateController.install(),
      cancel: () => appUpdateController.cancel(),
      dismiss: () => appUpdateController.dismiss(),
      undismiss: () => appUpdateController.undismiss(),
      openInstallSettings: () => appUpdateController.openInstallSettings(),
      setCellularPolicy: (p: CellularPolicy) => appUpdateController.setCellularPolicy(p),
    }),
    [],
  );
  return { ...state, ...actions };
}
