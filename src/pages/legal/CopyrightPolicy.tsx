import { useNavigate } from "react-router-dom";
import { DMCA_AGENT, SUPPORT_EMAIL } from "@/lib/legal/legalConfig";

/**
 * Public copyright / takedown policy (reachable without signing in).
 * Wording follows 17 U.S.C. § 512(c)(3) notice elements. Not legal advice:
 * have it reviewed before relying on it.
 */
const CopyrightPolicy = () => {
  const navigate = useNavigate();
  const contact = DMCA_AGENT?.email ?? SUPPORT_EMAIL;
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-xl px-5 py-8 space-y-5 text-sm leading-relaxed">
        <button onClick={() => navigate(-1)} className="text-xs text-muted-foreground underline">Back</button>
        <h1 className="text-2xl font-semibold tracking-tight">Copyright policy</h1>
        <p>
          DuoSpace lets people upload photos, profile pictures and other content. Only upload things you
          own or have permission to share. We respond to valid notices of copyright infringement and
          remove or disable access to infringing content.
        </p>

        <h2 className="text-base font-semibold">Report infringement</h2>
        <p>Send a written notice to <a className="underline" href={`mailto:${contact}`}>{contact}</a> that includes:</p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Your physical or electronic signature.</li>
          <li>The copyrighted work you say was infringed.</li>
          <li>Where the material is in DuoSpace, with enough detail for us to find it.</li>
          <li>Your name, address, phone number and email.</li>
          <li>A statement that you believe in good faith the use is not authorized by the owner, its agent or the law.</li>
          <li>A statement, under penalty of perjury, that the notice is accurate and that you are the owner or authorized to act for the owner.</li>
        </ol>

        {DMCA_AGENT && (
          <div className="rounded-xl border border-border/60 bg-card p-3 text-xs">
            <p className="font-medium text-foreground">Designated copyright agent</p>
            <p>{DMCA_AGENT.name}</p>
            <p>{DMCA_AGENT.address}</p>
            <p><a className="underline" href={`mailto:${DMCA_AGENT.email}`}>{DMCA_AGENT.email}</a></p>
          </div>
        )}

        <h2 className="text-base font-semibold">Counter-notice</h2>
        <p>
          If your content was removed and you believe that was a mistake, email the same address with your
          signature, a description of the removed content and where it appeared, a statement under penalty of
          perjury that you believe it was removed by mistake, your name, address and phone, and consent to the
          jurisdiction of your local federal court. We may restore it after the legally required waiting
          period unless the sender files a court action.
        </p>

        <h2 className="text-base font-semibold">Repeat infringers</h2>
        <p>We terminate the accounts of people who are repeatedly found to infringe copyright.</p>
        <p className="text-[11px] text-muted-foreground">Knowingly sending a false notice can make you liable for damages.</p>
      </div>
    </div>
  );
};

export default CopyrightPolicy;
