import { useEffect, useState } from "react";
import { dismissPendingReport, formatReport, getPendingReport, subscribePending, type BlackBoxReport } from "@/lib/blackBox";

/** Shown once after a launch that followed a crash/freeze. Tells the owner what the black box recorded. */
export default function BlackBoxNotice() {
  const [report, setReport] = useState<BlackBoxReport | null>(() => getPendingReport());
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => subscribePending(setReport), []);
  if (!report) return null;
  const text = formatReport(report);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setOpen(true); } };
  return (
    <div role="alertdialog" aria-label="Crash report" style={{ position: "fixed", left: 12, right: 12, bottom: "calc(env(safe-area-inset-bottom, 0px) + 84px)", zIndex: 2147483000, background: "rgba(24,24,28,.97)", color: "#fff", borderRadius: 16, padding: 14, boxShadow: "0 8px 30px rgba(0,0,0,.45)", fontSize: 13, lineHeight: 1.4 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
        {report.cause === "died-while-open" ? "DuoSpace stopped unexpectedly last time" : "DuoSpace froze last time"}
      </div>
      <div style={{ opacity: 0.85 }}>{report.summary}</div>
      {open && <pre style={{ maxHeight: 180, overflow: "auto", fontSize: 10, marginTop: 8, whiteSpace: "pre-wrap" }}>{text}</pre>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={copy} style={{ flex: 1, padding: "8px 10px", borderRadius: 10, background: "#fff", color: "#111", fontWeight: 600 }}>{copied ? "Copied" : "Copy report"}</button>
        <button onClick={() => setOpen((o) => !o)} style={{ padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,.14)" }}>{open ? "Hide" : "Details"}</button>
        <button onClick={dismissPendingReport} style={{ padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,.14)" }}>Dismiss</button>
      </div>
    </div>
  );
}
