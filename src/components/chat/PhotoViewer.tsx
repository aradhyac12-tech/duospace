import { motion } from "framer-motion";
import { X, Download, Share2 } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { useState } from "react";

interface PhotoViewerProps {
  src: string;
  onClose: () => void;
}

const PhotoViewer = ({ src, onClose }: PhotoViewerProps) => {
  const [saving, setSaving] = useState(false);

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    try {
      if (Capacitor.isNativePlatform()) {
        // Native: save to Documents via Capacitor Filesystem
        const { Filesystem, Directory } = await import("@capacitor/filesystem");
        const response = await fetch(src);
        const blob = await response.blob();
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(",")[1];
          await Filesystem.writeFile({
            path: `duospace_${Date.now()}.jpg`,
            data: base64,
            directory: Directory.Documents,
          });
        };
        reader.readAsDataURL(blob);
      } else {
        // Web: download via <a>
        const response = await fetch(src);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `duospace_${Date.now()}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      window.open(src, "_blank");
    }
    setSaving(false);
  };

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigator.share) {
      try { await navigator.share({ url: src }); } catch { /* cancelled */ }
    } else {
      await navigator.clipboard.writeText(src);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black flex flex-col"
      onClick={onClose}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 pt-12 pb-3 safe-top bg-gradient-to-b from-black/60 to-transparent">
        <button onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="h-9 w-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
          <X className="h-4 w-4 text-white" />
        </button>
        <div className="flex items-center gap-2">
          <button onClick={handleShare}
            className="h-9 w-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <Share2 className="h-4 w-4 text-white" />
          </button>
          <button onClick={handleSave} disabled={saving}
            className="h-9 w-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center disabled:opacity-50">
            <Download className="h-4 w-4 text-white" />
          </button>
        </div>
      </div>

      {/* Image — pinch-zoom on mobile */}
      <div className="flex-1 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt=""
          className="max-w-full max-h-full object-contain"
          style={{ touchAction: "pinch-zoom" }}
        />
      </div>
    </motion.div>
  );
};

export default PhotoViewer;
