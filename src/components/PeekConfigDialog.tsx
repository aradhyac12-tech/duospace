/**
 * PeekConfigDialog — fine-tune the owner-recognition peek pipeline.
 *
 * Surfaced from Settings → Security & Privacy → Peek Guard "Configure".
 * Controls map 1:1 to the AppSettings peek* fields and feed PeekGuard / hook.
 */

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/contexts/ThemeContext";
import { Camera, Eye, Users, UserX, Gauge } from "lucide-react";
import { useState, useEffect } from "react";
import { loadOwnerProfile } from "@/lib/faceRecognition";
import FaceEnrollmentDialog from "./FaceEnrollmentDialog";
import { hapticLight } from "@/lib/haptics";

interface Props { open: boolean; onClose: () => void; }

const PeekConfigDialog = ({ open, onClose }: Props) => {
  const { appSettings, updateSetting } = useTheme();
  const [enrolled, setEnrolled]       = useState(0);
  const [enrollOpen, setEnrollOpen]   = useState(false);

  const refresh = () => loadOwnerProfile().then((p) => setEnrolled(p?.count ?? 0));
  useEffect(() => { if (open) refresh(); }, [open]);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Eye className="h-4 w-4" /> Peek Guard
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              Locks the screen when someone other than you is looking.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 mt-2">
            {/* Owner enrollment */}
            <section className="rounded-xl border border-border/60 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Camera className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium flex-1">Owner face</p>
                <span className="text-[10px] text-muted-foreground">
                  {enrolled > 0 ? `${enrolled} samples` : "Not enrolled"}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Without enrollment, only multi-face detection works.
                Enroll to detect strangers specifically.
              </p>
              <Button size="sm" variant="secondary" className="w-full"
                onClick={() => { hapticLight(); setEnrollOpen(true); }}>
                {enrolled > 0 ? "Re-enroll / manage" : "Enroll my face"}
              </Button>
            </section>

            {/* Triggers */}
            <section className="space-y-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Triggers</p>
              <Row icon={UserX} label="Stranger detected"
                desc="A non-owner face appears (requires enrollment)"
                checked={appSettings.peekAlertOnStranger}
                onChange={(v) => updateSetting("peekAlertOnStranger", v)} />
              <Row icon={Users} label="Multiple faces"
                desc="Two or more people in the frame"
                checked={appSettings.peekAlertOnMultipleFaces}
                onChange={(v) => updateSetting("peekAlertOnMultipleFaces", v)} />
              <Row icon={Eye} label="No face"
                desc="Lock when nobody is looking"
                checked={appSettings.peekAlertOnNoFace}
                onChange={(v) => updateSetting("peekAlertOnNoFace", v)} />
            </section>

            {/* Sensitivity */}
            <section className="space-y-4">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <Gauge className="h-3 w-3" /> Sensitivity
              </p>

              <SliderRow
                label="Match threshold"
                value={appSettings.peekMatchThreshold}
                hint={`${(appSettings.peekMatchThreshold * 100).toFixed(0)}% similarity to owner`}
                min={0.5} max={0.9} step={0.02}
                onChange={(v) => updateSetting("peekMatchThreshold", v)} />

              <SliderRow
                label="Lock delay"
                value={appSettings.peekLockDelay}
                hint={`${(appSettings.peekLockDelay / 1000).toFixed(1)}s before lock`}
                min={500} max={3000} step={100}
                onChange={(v) => updateSetting("peekLockDelay", v)} />

              <SliderRow
                label="Frame consistency"
                value={appSettings.peekConsistencyFrames}
                hint={`${appSettings.peekConsistencyFrames} consecutive frames`}
                min={2} max={8} step={1}
                onChange={(v) => updateSetting("peekConsistencyFrames", v)} />

              <SliderRow
                label="Min face size"
                value={appSettings.peekMinFaceArea}
                hint={`Ignore faces below ${(appSettings.peekMinFaceArea * 100).toFixed(1)}% of frame`}
                min={0.005} max={0.1} step={0.005}
                onChange={(v) => updateSetting("peekMinFaceArea", v)} />

              <SliderRow
                label="Check interval"
                value={appSettings.peekCheckInterval}
                hint={`Every ${appSettings.peekCheckInterval}ms`}
                min={300} max={1500} step={100}
                onChange={(v) => updateSetting("peekCheckInterval", v)} />
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <FaceEnrollmentDialog
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        onEnrolled={refresh}
      />
    </>
  );
};

const Row = ({ icon: Icon, label, desc, checked, onChange }: {
  icon: any; label: string; desc: string;
  checked: boolean; onChange: (v: boolean) => void;
}) => (
  <div className="flex items-center gap-3">
    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
    <div className="flex-1 min-w-0">
      <p className="text-sm">{label}</p>
      <p className="text-[10px] text-muted-foreground">{desc}</p>
    </div>
    <Switch checked={checked} onCheckedChange={(v) => { hapticLight(); onChange(v); }} />
  </div>
);

const SliderRow = ({ label, value, hint, min, max, step, onChange }: {
  label: string; value: number; hint: string;
  min: number; max: number; step: number;
  onChange: (v: number) => void;
}) => (
  <div className="space-y-1.5">
    <div className="flex justify-between items-baseline">
      <p className="text-xs">{label}</p>
      <p className="text-[10px] text-muted-foreground">{hint}</p>
    </div>
    <Slider value={[value]} min={min} max={max} step={step}
      onValueChange={([v]) => onChange(v)} />
  </div>
);

export default PeekConfigDialog;
