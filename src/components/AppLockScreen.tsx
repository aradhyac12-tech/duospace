import { motion, AnimatePresence } from "framer-motion";
import { Fingerprint, Scan, Lock, KeyRound } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { useBiometricLock } from "@/hooks/useBiometricLock";
import { useState, useRef, useEffect } from "react";
import { Capacitor } from "@capacitor/core";
import storage from "@/lib/storage";
import { hashPin, verifyPin, migratePinIfNeeded } from "@/lib/crypto";

const PIN_LENGTH = 6;
const STORED_PIN_KEY = "duo-lock-pin";
const LOCKOUT_SECONDS = 30;

const AppLockScreen = () => {
  const { isAppLocked, setIsAppLocked, appSettings, appIcon, appName } = useTheme();
  const { authenticate, capabilities, biometricError, setBiometricError } = useBiometricLock(
    isAppLocked, setIsAppLocked, appSettings.biometricLock
  );

  const [mode, setMode] = useState<"biometric" | "pin">("biometric");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);
  // FIX: live countdown
  const [lockoutRemaining, setLockoutRemaining] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isNative  = Capacitor.isNativePlatform();
  const hasBiometric = capabilities.available && isNative;

  // One-time migration: upgrade plaintext PIN → hashed
  useEffect(() => { migratePinIfNeeded(STORED_PIN_KEY); }, []);

  // FIX: live lockout countdown tick
  useEffect(() => {
    if (!lockoutUntil) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockoutUntil - Date.now()) / 1000));
      setLockoutRemaining(remaining);
      if (remaining === 0) setLockoutUntil(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockoutUntil]);

  useEffect(() => { if (mode === "pin") setTimeout(() => inputRef.current?.focus(), 100); }, [mode]);
  useEffect(() => { if (!hasBiometric && isAppLocked) setMode("pin"); }, [hasBiometric, isAppLocked]);

  const getIcon = () => {
    if (!hasBiometric) return <KeyRound className="h-10 w-10 text-foreground" />;
    if (capabilities.method === "face") return <Scan className="h-10 w-10 text-foreground" />;
    return <Fingerprint className="h-10 w-10 text-foreground" />;
  };
  const getMethodLabel = () => {
    if (!hasBiometric) return "PIN";
    if (capabilities.method === "face") return "Face ID";
    return "Fingerprint";
  };

  const handlePinDigit = async (digit: string) => {
    if (lockoutUntil && Date.now() < lockoutUntil) return;
    const next = pin + digit;
    setPin(next);
    setPinError(false);

    if (next.length === PIN_LENGTH) {
      const stored = storage.get(STORED_PIN_KEY);
      if (!stored) {
        // First time — hash and save
        const hashed = await hashPin(next);
        storage.set(STORED_PIN_KEY, hashed);
        setPin("");
        setIsAppLocked(false);
        return;
      }
      // FIX: constant-time PBKDF2 compare
      const ok = await verifyPin(next, stored);
      if (ok) {
        setPin(""); setAttempts(0); setIsAppLocked(false);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPinError(true);
        setTimeout(() => { setPin(""); setPinError(false); }, 600);
        if (newAttempts >= 5) {
          const until = Date.now() + LOCKOUT_SECONDS * 1000;
          setLockoutUntil(until);
          setTimeout(() => { setLockoutUntil(null); setAttempts(0); }, LOCKOUT_SECONDS * 1000);
        }
      }
    }
  };

  const handlePinBackspace = () => setPin(p => p.slice(0, -1));
  const isLockedOut = !!lockoutUntil && Date.now() < lockoutUntil;

  const DIGITS = [
    ["1","2","3"],
    ["4","5","6"],
    ["7","8","9"],
    ["","0","⌫"],
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[9999] bg-background flex flex-col items-center justify-between safe-top safe-bottom py-12"
    >
      {/* App identity */}
      <div className="flex flex-col items-center gap-3 mt-6">
        {appIcon ? (
          <img src={appIcon} alt={appName} className="h-16 w-16 rounded-2xl object-cover shadow-lg" />
        ) : (
          <div className="h-16 w-16 rounded-2xl bg-accent flex items-center justify-center">
            <Lock className="h-7 w-7 text-foreground" />
          </div>
        )}
        <p className="text-lg font-semibold text-foreground">{appName}</p>
      </div>

      {/* Auth UI */}
      <AnimatePresence mode="wait">
        {mode === "biometric" ? (
          <motion.div key="bio" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            className="flex flex-col items-center gap-6">
            <motion.button whileTap={{ scale: 0.92 }} onClick={authenticate}
              className="h-24 w-24 rounded-full bg-accent flex items-center justify-center shadow-lg active:scale-95 transition-transform">
              {getIcon()}
            </motion.button>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-foreground">Use {getMethodLabel()}</p>
              {biometricError && <p className="text-xs text-destructive">{biometricError}</p>}
              <p className="text-xs text-muted-foreground">Tap to authenticate</p>
            </div>
            <button onClick={() => { setMode("pin"); setBiometricError(null); }} className="text-xs text-primary underline">
              Use PIN instead
            </button>
          </motion.div>
        ) : (
          <motion.div key="pin" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            className="flex flex-col items-center gap-8 w-full px-8">
            {isLockedOut ? (
              <div className="text-center space-y-2">
                <Lock className="h-8 w-8 text-destructive mx-auto" />
                <p className="text-sm font-medium text-destructive">Too many attempts</p>
                {/* FIX: live countdown */}
                <p className="text-xs text-muted-foreground">
                  Try again in{" "}
                  <span className="font-mono font-semibold text-destructive">{lockoutRemaining}s</span>
                </p>
              </div>
            ) : (
              <>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-foreground">Enter PIN</p>
                  {!storage.get(STORED_PIN_KEY) && (
                    <p className="text-xs text-muted-foreground">Set a 6-digit PIN to secure your app</p>
                  )}
                </div>
                {/* PIN dots */}
                <div className="flex gap-3">
                  {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                    <motion.div key={i}
                      animate={pinError ? { x: [0, -6, 6, -6, 6, 0] } : {}}
                      transition={{ duration: 0.3 }}
                      className={`h-4 w-4 rounded-full border-2 transition-all ${
                        pin.length > i ? "bg-foreground border-foreground" : "bg-transparent border-border"
                      } ${pinError ? "border-destructive" : ""}`}
                    />
                  ))}
                </div>
                {/* Numpad */}
                <div className="grid grid-cols-3 gap-4 w-full max-w-[260px]">
                  {DIGITS.flat().map((d, i) => (
                    <button key={i}
                      onClick={() => d === "⌫" ? handlePinBackspace() : d ? handlePinDigit(d) : null}
                      className={`h-16 rounded-2xl flex items-center justify-center text-xl font-medium transition-all active:scale-90 ${
                        d ? "bg-card border border-border text-foreground hover:bg-accent" : "invisible"
                      } ${d === "⌫" ? "text-muted-foreground text-base" : ""}`}>
                      {d}
                    </button>
                  ))}
                </div>
              </>
            )}
            {hasBiometric && (
              <button onClick={() => { setMode("biometric"); setPin(""); }}
                className="text-xs text-primary underline">
                Use {getMethodLabel()} instead
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="h-8" />
    </motion.div>
  );
};

export default AppLockScreen;
