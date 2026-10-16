import { useEffect, useState } from "react";
import { getMediaInfo, type MediaVariant, type ResolvedMedia } from "@/services/media/mediaService";

/** Resolve any stored media reference (Cloudinary "media:<uuid>" or legacy URL) for display. */
export function useMediaUrl(ref: string | null | undefined, opts: { bucket: string; variant?: MediaVariant }) {
  const [state, setState] = useState<{ info: ResolvedMedia | null; loading: boolean; failed: boolean }>({ info: null, loading: !!ref, failed: false });
  useEffect(() => {
    let live = true;
    if (!ref) { setState({ info: null, loading: false, failed: false }); return; }
    setState((s) => ({ ...s, loading: true, failed: false }));
    getMediaInfo(ref, opts).then((info) => { if (live) setState({ info, loading: false, failed: !info }); })
      .catch(() => { if (live) setState({ info: null, loading: false, failed: true }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, opts.bucket, opts.variant]);
  return { url: state.info?.url ?? null, info: state.info, loading: state.loading, failed: state.failed };
}
