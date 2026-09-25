import { useEffect } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { Heart } from "lucide-react";

/**
 * Envelope — purely presentational, fully controlled 3D-flap envelope used by
 * the chat bubble (closed), the letter reader (open/close sequence) and the
 * composer (seal + send sequence). It owns NO timing: callers flip the props
 * (flapOpen / letterLift / showSeal) and the envelope animates to them, so the
 * three surfaces can choreograph the same object differently.
 *
 * Layers, back to front:  back (1) · flap when OPEN (1) · letter (2) ·
 * front pocket (3) · flap when CLOSED (4). The flap's z-index flips at 90° so
 * it passes from "in front of the pocket" to "behind the letter" mid-swing.
 */

export const ENVELOPE_RATIO = 0.66;
export const envelopeHeight = (width: number) => Math.round(width * ENVELOPE_RATIO);

const C = {
  back: "hsl(346 30% 82%)",
  pocket: "hsl(348 42% 92%)",
  flapOut: "linear-gradient(180deg, hsl(348 46% 94%), hsl(348 40% 88%))",
  flapIn: "linear-gradient(180deg, hsl(346 28% 78%), hsl(346 30% 84%))",
  paper: "hsl(38 48% 97%)",
  paperLine: "hsl(30 22% 82%)",
  ink: "hsl(20 18% 30%)",
};

export interface EnvelopeProps {
  /** Pixel width; height follows ENVELOPE_RATIO. */
  width?: number;
  flapOpen: boolean;
  /** 0 = letter tucked inside, 1 = pulled clear above the pocket, >1 = further out. */
  letterLift?: number;
  showLetter?: boolean;
  showSeal?: boolean;
  /** Shown on the little letter sheet while it is visible. */
  letterTitle?: string;
  flapMs?: number;
  letterMs?: number;
  /** Snap instead of animating (prefers-reduced-motion). */
  instant?: boolean;
  className?: string;
}

const Envelope = ({
  width = 220,
  flapOpen,
  letterLift = 0,
  showLetter = true,
  showSeal = true,
  letterTitle,
  flapMs = 500,
  letterMs = 520,
  instant = false,
  className,
}: EnvelopeProps) => {
  const H = envelopeHeight(width);
  const flapH = Math.round(H * 0.58);
  const seal = Math.round(width * 0.17);

  const rot = useMotionValue(flapOpen ? 180 : 0);
  useEffect(() => {
    const controls = animate(
      rot,
      flapOpen ? 180 : 0,
      instant ? { duration: 0 } : { duration: flapMs / 1000, ease: [0.45, 0, 0.2, 1] },
    );
    return () => controls.stop();
  }, [flapOpen, flapMs, instant, rot]);

  const flapZ = useTransform(rot, (v) => (v > 90 ? 1 : 4));
  const outerOpacity = useTransform(rot, (v) => (v > 90 ? 0 : 1));
  const innerOpacity = useTransform(rot, (v) => (v > 90 ? 1 : 0));

  const tri = "polygon(0 0, 100% 0, 50% 100%)";
  const letterW = Math.round(width * 0.88);
  const letterH = Math.round(H * 0.78);

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ position: "relative", width, height: H, perspective: width * 4 }}
    >
      {/* back of the envelope */}
      <div
        style={{
          position: "absolute", inset: 0, borderRadius: 8, background: C.back, zIndex: 0,
          boxShadow: "0 14px 30px -10px rgba(60,20,30,.5), 0 2px 5px rgba(60,20,30,.18)",
        }}
      />

      {/* the letter sheet */}
      {showLetter && (
        <motion.div
          initial={false}
          animate={{ y: -letterLift * H * 0.85 }}
          transition={instant ? { duration: 0 } : { duration: letterMs / 1000, ease: [0.22, 1, 0.36, 1] }}
          style={{
            position: "absolute", left: Math.round(width * 0.06), top: Math.round(H * 0.14),
            width: letterW, height: letterH, zIndex: 2, borderRadius: 4,
            background: C.paper, border: `1px solid ${C.paperLine}`,
            boxShadow: "0 1px 3px rgba(0,0,0,.18)", padding: Math.round(width * 0.05),
            overflow: "hidden",
          }}
        >
          {letterTitle && (
            <div
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif", fontWeight: 600, color: C.ink,
                fontSize: Math.max(9, Math.round(width * 0.05)), whiteSpace: "nowrap",
                overflow: "hidden", textOverflow: "ellipsis", marginBottom: Math.round(width * 0.03),
              }}
            >
              {letterTitle}
            </div>
          )}
          {[92, 100, 84, 96, 60].map((w, i) => (
            <div
              key={i}
              style={{
                height: 2, width: `${w}%`, background: C.paperLine, borderRadius: 2,
                marginTop: Math.round(width * 0.035),
              }}
            />
          ))}
        </motion.div>
      )}

      {/* front pocket: a V-notched sheet split into three folded panels */}
      <div style={{ position: "absolute", inset: 0, zIndex: 3, pointerEvents: "none" }}>
        <div style={{ position: "absolute", inset: 0, background: C.pocket, borderRadius: 8, clipPath: "polygon(0 0, 50% 58%, 100% 0, 100% 100%, 0 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,.38)", clipPath: "polygon(0 0, 50% 58%, 0 100%)", borderRadius: 8 }} />
        <div style={{ position: "absolute", inset: 0, background: "rgba(90,30,45,.05)", clipPath: "polygon(100% 0, 50% 58%, 100% 100%)", borderRadius: 8 }} />
        <div style={{ position: "absolute", inset: 0, background: "rgba(90,30,45,.09)", clipPath: "polygon(0 100%, 50% 58%, 100% 100%)", borderRadius: 8 }} />
      </div>

      {/* flap — hinged on the top edge */}
      <motion.div
        style={{
          position: "absolute", left: 0, top: 0, width, height: flapH,
          transformOrigin: "50% 0%", rotateX: rot, zIndex: flapZ, pointerEvents: "none",
        }}
      >
        <motion.div style={{ position: "absolute", inset: 0, clipPath: tri, background: C.flapOut, opacity: outerOpacity }} />
        <motion.div style={{ position: "absolute", inset: 0, clipPath: tri, background: C.flapIn, opacity: innerOpacity }} />
        {/* wax seal rides on the outside of the flap, so it lifts away with it */}
        <motion.div
          initial={false}
          animate={{ scale: showSeal ? 1 : 0 }}
          transition={instant ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 16 }}
          style={{
            position: "absolute", left: "50%", top: flapH - Math.round(seal * 0.62),
            width: seal, height: seal, marginLeft: -seal / 2, borderRadius: "50%",
            background: "radial-gradient(circle at 35% 30%, hsl(352 72% 58%), hsl(352 64% 38%) 72%)",
            boxShadow: "0 2px 5px rgba(60,10,20,.45), inset 0 -2px 3px rgba(0,0,0,.25), inset 0 1px 2px rgba(255,255,255,.35)",
            display: "flex", alignItems: "center", justifyContent: "center", opacity: outerOpacity,
          }}
        >
          <Heart style={{ width: seal * 0.5, height: seal * 0.5, color: "hsl(352 80% 88%)" }} fill="currentColor" />
        </motion.div>
      </motion.div>
    </div>
  );
};

export default Envelope;
