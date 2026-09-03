import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ChevronRight, User, Phone, Heart, Calendar } from "lucide-react";
import { hapticSelection, hapticMedium } from "@/lib/haptics";

const genderOptions = [
  { value: "male", label: "Male", emoji: "👨" },
  { value: "female", label: "Female", emoji: "👩" },
  { value: "non-binary", label: "Non-binary", emoji: "🧑" },
];

interface OnboardingProps {
  onComplete: () => void;
}

const Onboarding = ({ onComplete }: OnboardingProps) => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState(user?.user_metadata?.full_name || "");
  const [gender, setGender] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [cycleLength, setCycleLength] = useState("28");
  const [periodLength, setPeriodLength] = useState("5");
  const [lastPeriodDate, setLastPeriodDate] = useState("");
  const [saving, setSaving] = useState(false);

  const isFemale = gender === "female";

  // Steps: Name → Gender → Phone → (if female) Cycle
  const totalSteps = isFemale ? 4 : 3;

  const steps = [
    { title: "What should we call you?", icon: User },
    { title: "Your gender", icon: Heart },
    { title: "Your contact number", icon: Phone },
    ...(isFemale ? [{ title: "Cycle tracking (optional)", icon: Calendar }] : []),
  ];

  const canProceed = () => {
    if (step === 0) return displayName.trim().length > 0;
    if (step === 1) return gender.length > 0;
    if (step === 2) return true; // phone optional
    if (step === 3) return true; // cycle optional
    return false;
  };

  const handleNext = async (phoneOverride?: string) => {
    if (step < totalSteps - 1) {
      setStep(step + 1);
      return;
    }

    const phoneToSave = phoneOverride !== undefined ? phoneOverride : phone;

    setSaving(true);
    const { error } = await supabase
      .from("profiles")
      .update({
        display_name: displayName.trim(),
        gender,
        phone_number: phoneToSave.trim() || null,
      })
      .eq("user_id", user!.id);

    if (error) {
      toast({ title: "Couldn't save profile", description: error.message, variant: "destructive" });
      setSaving(false);
      return;
    }

    // Save menstrual cycle if female and date provided. This is a second,
    // separate write after the profile save above — if it fails, don't
    // block onboarding completion (the core profile already saved), but
    // don't silently drop it either: tell the user so they know to re-add
    // it rather than assuming it's tracked.
    if (isFemale && lastPeriodDate) {
      const { error: cycleError } = await supabase.from("menstrual_cycles").insert({
        user_id: user!.id,
        cycle_start_date: lastPeriodDate,
        cycle_length: parseInt(cycleLength) || 28,
        period_length: parseInt(periodLength) || 5,
      } as any);
      if (cycleError) {
        toast({ title: "Profile saved, but cycle info didn't", description: "You can add it again later.", variant: "destructive" });
      }
    }

    toast({ title: "Welcome! 🎉", description: "Your profile is all set" });
    onComplete();
    setSaving(false);
  };

  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm space-y-8"
      >
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-serif tracking-tight">Let's set up your profile</h1>
          <div className="flex justify-center gap-2 mt-4">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i <= step ? "w-8 bg-primary" : "w-4 bg-muted"
                }`}
              />
            ))}
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            transition={{ duration: 0.2 }}
            className="space-y-6"
          >
            <div className="text-center">
              <div className="h-14 w-14 rounded-2xl bg-accent flex items-center justify-center mx-auto mb-4">
                {(() => {
                  const Icon = steps[step].icon;
                  return <Icon className="h-6 w-6 text-accent-foreground" />;
                })()}
              </div>
              <h2 className="text-lg font-medium">{steps[step].title}</h2>
            </div>

            {step === 0 && (
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
                className="h-12 rounded-xl bg-card border-border text-center text-lg"
                autoFocus
              />
            )}

            {step === 1 && (
              <div className="grid grid-cols-3 gap-3">
                {genderOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => { hapticSelection(); setGender(opt.value); }}
                    className={`rounded-2xl border-2 p-4 flex flex-col items-center gap-2 transition-all ${
                      gender === opt.value
                        ? "border-primary bg-accent/10"
                        : "border-border bg-card"
                    }`}
                  >
                    <span className="text-3xl">{opt.emoji}</span>
                    <span className="text-xs font-medium">{opt.label}</span>
                  </button>
                ))}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-2">
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 (555) 000-0000"
                  type="tel"
                  className="h-12 rounded-xl bg-card border-border text-center text-lg"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground text-center">Optional — for account recovery</p>
              </div>
            )}

            {step === 3 && isFemale && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">Last period start date</label>
                  <Input
                    value={lastPeriodDate}
                    onChange={(e) => setLastPeriodDate(e.target.value)}
                    type="date"
                    className="h-12 rounded-xl bg-card border-border text-center"
                    autoFocus
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Cycle length (days)</label>
                    <Input
                      value={cycleLength}
                      onChange={(e) => setCycleLength(e.target.value)}
                      type="number"
                      min="20" max="45"
                      className="h-10 rounded-xl bg-card border-border text-center"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Period length (days)</label>
                    <Input
                      value={periodLength}
                      onChange={(e) => setPeriodLength(e.target.value)}
                      type="number"
                      min="2" max="10"
                      className="h-10 rounded-xl bg-card border-border text-center"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground text-center">
                  This helps your partner know when to pamper you 💕<br/>
                  You can skip this and add it later.
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <Button
          onClick={() => { hapticMedium(); handleNext(); }}
          disabled={!canProceed() || saving}
          className="w-full h-12 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium gap-2"
        >
          {step === totalSteps - 1 ? (saving ? "Saving..." : "Let's go!") : "Continue"}
          {step < totalSteps - 1 && <ChevronRight className="h-4 w-4" />}
        </Button>

        {step === 2 && (
          <button
            onClick={() => { handleNext(""); }}
            disabled={saving}
            className="w-full text-center text-xs text-muted-foreground underline underline-offset-2"
          >
            Skip for now
          </button>
        )}

        {step === 3 && isFemale && (
          <button
            onClick={() => { setLastPeriodDate(""); handleNext(); }}
            disabled={saving}
            className="w-full text-center text-xs text-muted-foreground underline underline-offset-2"
          >
            Skip for now
          </button>
        )}

        {step > 0 && (
          <button onClick={() => { setStep(step - 1); }} className="w-full text-center text-xs text-muted-foreground">
            Go back
          </button>
        )}
      </motion.div>
    </div>
  );
};

export default Onboarding;
