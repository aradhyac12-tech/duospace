// Legal contact details shown on public pages. Set these in the build env; the
// pages never invent a name or address. DMCA agent registration itself (about
// $6, https://dmca.copyright.gov/) is something only the app owner can file.

const env = (k: string): string => String((import.meta as any)?.env?.[k] ?? "").trim();

export const SUPPORT_EMAIL = env("VITE_SUPPORT_EMAIL") || "duospace.auth@gmail.com";

export interface DmcaAgent { name: string; email: string; address: string }

/** Registered designated agent, or null until VITE_DMCA_AGENT_NAME/EMAIL/ADDRESS are all set. */
export function dmcaAgentFrom(read: (k: string) => string = env): DmcaAgent | null {
  const name = read("VITE_DMCA_AGENT_NAME");
  const email = read("VITE_DMCA_AGENT_EMAIL");
  const address = read("VITE_DMCA_AGENT_ADDRESS");
  return name && email && address ? { name, email, address } : null;
}

export const DMCA_AGENT = dmcaAgentFrom();
