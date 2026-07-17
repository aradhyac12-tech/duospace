import { useState, useRef, useCallback, useEffect } from "react";
import { motion } from "framer-motion";
import { X, RotateCcw, Send, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { acquireCamera, explainGumError, type CameraLease } from "@/lib/cameraBus";

interface FilterDef {
  name: string;
  emoji: string;
  css: string;
  category: string;
}

const FILTERS: FilterDef[] = [
  // Basic
  { name: "Normal", emoji: "📷", css: "none", category: "Basic" },
  { name: "B&W", emoji: "🖤", css: "grayscale(1) contrast(1.2)", category: "Basic" },
  { name: "Sepia", emoji: "📜", css: "sepia(0.8) contrast(1.1)", category: "Basic" },
  
  // Warm
  { name: "Warm", emoji: "🌅", css: "sepia(0.3) saturate(1.4) brightness(1.1)", category: "Warm" },
  { name: "Sunset", emoji: "🌇", css: "sepia(0.2) saturate(1.5) hue-rotate(-15deg) brightness(1.1)", category: "Warm" },
  { name: "Golden", emoji: "🌟", css: "sepia(0.35) saturate(1.3) brightness(1.15) hue-rotate(-10deg)", category: "Warm" },
  { name: "Honey", emoji: "🍯", css: "sepia(0.4) saturate(1.6) brightness(1.1) hue-rotate(-5deg)", category: "Warm" },
  { name: "Amber", emoji: "🔶", css: "sepia(0.5) saturate(1.2) brightness(1.05) hue-rotate(-20deg)", category: "Warm" },
  { name: "Peach", emoji: "🍑", css: "sepia(0.15) saturate(1.3) brightness(1.15) hue-rotate(-8deg)", category: "Warm" },

  // Cool
  { name: "Cool", emoji: "❄️", css: "saturate(0.8) brightness(1.1) hue-rotate(20deg)", category: "Cool" },
  { name: "Arctic", emoji: "🧊", css: "saturate(0.6) brightness(1.15) hue-rotate(30deg) contrast(1.05)", category: "Cool" },
  { name: "Ocean", emoji: "🌊", css: "saturate(1.2) brightness(1.05) hue-rotate(15deg)", category: "Cool" },
  { name: "Frozen", emoji: "🥶", css: "saturate(0.5) brightness(1.2) hue-rotate(40deg) contrast(1.1)", category: "Cool" },
  { name: "Aqua", emoji: "💎", css: "saturate(1.1) brightness(1.1) hue-rotate(25deg) contrast(0.95)", category: "Cool" },

  // Vintage
  { name: "Vintage", emoji: "📻", css: "sepia(0.5) contrast(1.1) brightness(0.9)", category: "Vintage" },
  { name: "Lomo", emoji: "🎞️", css: "saturate(1.5) contrast(1.3) brightness(0.9) sepia(0.1)", category: "Vintage" },
  { name: "Retro", emoji: "📺", css: "sepia(0.3) contrast(1.15) saturate(1.1) brightness(0.95)", category: "Vintage" },
  { name: "Film", emoji: "🎥", css: "contrast(1.1) saturate(0.85) brightness(1.05) sepia(0.2)", category: "Vintage" },
  { name: "Kodak", emoji: "📸", css: "sepia(0.15) saturate(1.4) contrast(1.05) brightness(1.08)", category: "Vintage" },
  { name: "Polaroid", emoji: "🖼️", css: "sepia(0.25) contrast(0.95) saturate(1.2) brightness(1.12)", category: "Vintage" },

  // Vibrant
  { name: "Pop", emoji: "🎨", css: "saturate(1.8) contrast(1.2) brightness(1.05)", category: "Vibrant" },
  { name: "Neon", emoji: "💜", css: "saturate(2.2) contrast(1.1) brightness(1.15)", category: "Vibrant" },
  { name: "Vivid", emoji: "🌈", css: "saturate(2.0) contrast(1.15) brightness(1.08)", category: "Vibrant" },
  { name: "Electric", emoji: "⚡", css: "saturate(1.9) contrast(1.25) brightness(1.1) hue-rotate(5deg)", category: "Vibrant" },
  { name: "Candy", emoji: "🍬", css: "saturate(1.7) contrast(1.05) brightness(1.15) hue-rotate(-10deg)", category: "Vibrant" },

  // Mood
  { name: "Dreamy", emoji: "💫", css: "brightness(1.15) contrast(0.9) saturate(1.3) blur(0.5px)", category: "Mood" },
  { name: "Fade", emoji: "🌫️", css: "contrast(0.85) brightness(1.1) saturate(0.7)", category: "Mood" },
  { name: "Moody", emoji: "🌑", css: "contrast(1.3) brightness(0.85) saturate(0.8)", category: "Mood" },
  { name: "Glow", emoji: "✨", css: "brightness(1.2) saturate(1.3) contrast(0.95)", category: "Mood" },
  { name: "Haze", emoji: "🫧", css: "brightness(1.18) contrast(0.8) saturate(0.9) blur(0.3px)", category: "Mood" },
  { name: "Mist", emoji: "🌬️", css: "brightness(1.1) contrast(0.88) saturate(0.75)", category: "Mood" },

  // Dark
  { name: "Noir", emoji: "🕶️", css: "grayscale(0.8) contrast(1.4) brightness(0.85)", category: "Dark" },
  { name: "Cinema", emoji: "🎬", css: "contrast(1.2) saturate(0.9) brightness(0.95) sepia(0.15)", category: "Dark" },
  { name: "Shadow", emoji: "🌑", css: "contrast(1.35) brightness(0.8) saturate(0.7)", category: "Dark" },
  { name: "Gothic", emoji: "🦇", css: "grayscale(0.5) contrast(1.5) brightness(0.78)", category: "Dark" },
  { name: "Dark", emoji: "🕳️", css: "contrast(1.4) brightness(0.75) saturate(0.6) sepia(0.05)", category: "Dark" },

  // Color shift
  { name: "Berry", emoji: "🫐", css: "hue-rotate(330deg) saturate(1.4) brightness(1.05)", category: "Color" },
  { name: "Fresh", emoji: "🌿", css: "hue-rotate(60deg) saturate(1.2) brightness(1.1)", category: "Color" },
  { name: "Rose", emoji: "🌹", css: "hue-rotate(340deg) saturate(1.3) brightness(1.08)", category: "Color" },
  { name: "Lime", emoji: "🍋", css: "hue-rotate(80deg) saturate(1.4) brightness(1.12)", category: "Color" },
  { name: "Violet", emoji: "🪻", css: "hue-rotate(270deg) saturate(1.3) brightness(1.05)", category: "Color" },
  { name: "Coral", emoji: "🪸", css: "hue-rotate(350deg) saturate(1.5) brightness(1.1)", category: "Color" },
  { name: "Teal", emoji: "🦚", css: "hue-rotate(160deg) saturate(1.2) brightness(1.08)", category: "Color" },
  { name: "Plum", emoji: "🍇", css: "hue-rotate(290deg) saturate(1.4) brightness(0.95)", category: "Color" },
];

interface CameraWithFiltersProps {
  onClose: () => void;
  onCapture: (blob: Blob, filterName: string) => void;
}

const CameraWithFilters = ({ onClose, onCapture }: CameraWithFiltersProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const leaseRef = useRef<CameraLease | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [selectedFilter, setSelectedFilter] = useState(0);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("Basic");
  const { toast } = useToast();

  const categories = [...new Set(FILTERS.map((f) => f.category))];
  const categoryFilters = FILTERS.filter((f) => f.category === selectedCategory);

  const releaseLease = useCallback(() => {
    try { leaseRef.current?.release(); } catch { /* ignore */ }
    leaseRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreamReady(false);
  }, []);

  const startCamera = useCallback(async (facing: "user" | "environment") => {
    releaseLease();
    try {
      const lease = await acquireCamera(facing);
      leaseRef.current = lease;
      if (videoRef.current) videoRef.current.srcObject = lease.stream;
      setStreamReady(true);
      setCameraError(null);
    } catch (err) {
      const { message } = explainGumError(err);
      setCameraError(message);
      toast({ title: "Camera unavailable", description: message, variant: "destructive" });
    }
  }, [releaseLease, toast]);

  useEffect(() => {
    startCamera(facingMode);
    return () => { releaseLease(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flipCamera = () => {
    const newFacing = facingMode === "user" ? "environment" : "user";
    setFacingMode(newFacing);
    startCamera(newFacing);
  };

  const capture = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.filter = FILTERS[selectedFilter].css;
    if (facingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    setCapturedImage(canvas.toDataURL("image/jpeg", 0.92));
  };

  const retake = () => setCapturedImage(null);

  const sendPhoto = () => {
    if (!capturedImage || !canvasRef.current) return;
    canvasRef.current.toBlob((blob) => {
      if (blob) onCapture(blob, FILTERS[selectedFilter].name);
    }, "image/jpeg", 0.92);
  };

  if (cameraError) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
        <div className="text-center space-y-4 px-8">
          <Sparkles className="h-12 w-12 text-white/40 mx-auto" />
          <p className="text-white text-sm">{cameraError}</p>
          <button onClick={onClose} className="bg-white/20 text-white px-6 py-2.5 rounded-xl text-sm">Close</button>
        </div>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 bg-black flex flex-col">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between p-4 safe-top">
        <button onClick={onClose} className="h-10 w-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
          <X className="h-5 w-5 text-white" />
        </button>
        <div className="bg-black/40 backdrop-blur-sm rounded-full px-3 py-1.5">
          <span className="text-xs text-white font-medium">{FILTERS[selectedFilter].name}</span>
        </div>
        <button onClick={flipCamera} className="h-10 w-10 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
          <RotateCcw className="h-5 w-5 text-white" />
        </button>
      </div>

      {/* Camera / captured view */}
      <div className="flex-1 relative overflow-hidden">
        {!capturedImage ? (
          <video ref={videoRef} autoPlay playsInline muted
            className="absolute inset-0 w-full h-full object-cover"
            style={{
              filter: FILTERS[selectedFilter].css,
              transform: facingMode === "user" ? "scaleX(-1)" : "none",
            }} />
        ) : (
          <img src={capturedImage} alt="Captured" className="absolute inset-0 w-full h-full object-cover" />
        )}
      </div>

      {/* Bottom controls */}
      <div className="bg-black/80 backdrop-blur-md safe-bottom">
        {!capturedImage ? (
          <>
            {/* Category tabs */}
            <div className="flex overflow-x-auto gap-1 px-3 pt-2 no-scrollbar">
              {categories.map((cat) => (
                <button key={cat} onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 rounded-full text-[10px] font-medium whitespace-nowrap transition-colors ${
                    selectedCategory === cat ? "bg-white text-black" : "bg-white/10 text-white/70"
                  }`}>
                  {cat}
                </button>
              ))}
            </div>

            {/* Filter strip */}
            <div className="flex overflow-x-auto gap-2.5 px-4 py-2.5 no-scrollbar">
              {categoryFilters.map((f) => {
                const globalIdx = FILTERS.indexOf(f);
                return (
                  <button key={f.name} onClick={() => setSelectedFilter(globalIdx)}
                    className={`flex flex-col items-center gap-0.5 shrink-0 transition-opacity ${selectedFilter === globalIdx ? "opacity-100" : "opacity-50"}`}>
                    <div className={`h-11 w-11 rounded-full bg-white/10 flex items-center justify-center text-base ${selectedFilter === globalIdx ? "ring-2 ring-white" : ""}`}>
                      {f.emoji}
                    </div>
                    <span className="text-[8px] text-white">{f.name}</span>
                  </button>
                );
              })}
            </div>

            {/* Capture button */}
            <div className="flex items-center justify-center py-3">
              <button onClick={capture}
                className="h-18 w-18 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform"
                style={{ width: 72, height: 72 }}>
                <div className="rounded-full bg-white" style={{ width: 60, height: 60 }} />
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center gap-6 py-6">
            <button onClick={retake} className="flex flex-col items-center gap-1.5">
              <div className="h-14 w-14 rounded-full bg-white/10 flex items-center justify-center">
                <RotateCcw className="h-6 w-6 text-white" />
              </div>
              <span className="text-[10px] text-white">Retake</span>
            </button>
            <button onClick={sendPhoto} className="flex flex-col items-center gap-1.5">
              <div className="h-14 w-14 rounded-full bg-primary flex items-center justify-center">
                <Send className="h-6 w-6 text-white" />
              </div>
              <span className="text-[10px] text-white">Send</span>
            </button>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </motion.div>
  );
};

export default CameraWithFilters;
