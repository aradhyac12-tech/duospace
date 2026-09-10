/**
 * PageSkeleton — universal skeleton used as Suspense fallback for every route.
 * Variants roughly match each page's shape so the transition feels instant.
 */
import Shimmer from "./Shimmer";
import { motion } from "framer-motion";

type Variant = "chat" | "grid" | "list" | "map" | "settings" | "default";

const spring = { type: "spring" as const, stiffness: 280, damping: 26, mass: 0.6 };

const Wrap = ({ children }: { children: React.ReactNode }) => (
  <motion.div
    initial={{ opacity: 0, y: 6 }}
    animate={{ opacity: 1, y: 0 }}
    transition={spring}
    className="flex-1 min-h-0 flex flex-col overflow-hidden px-4 pt-4 pb-2 gap-3"
  >
    {children}
  </motion.div>
);

const ChatSkeleton = () => (
  <Wrap>
    <div className="flex items-center gap-3 pb-2">
      <Shimmer className="h-10 w-10 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Shimmer className="h-3 w-24" />
        <Shimmer className="h-2 w-16 rounded-md" />
      </div>
    </div>
    <div className="flex-1 space-y-3 overflow-hidden">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className={`flex ${i % 2 ? "justify-end" : "justify-start"}`}>
          <Shimmer className={`h-10 rounded-2xl ${i % 2 ? "w-40" : "w-56"}`} />
        </div>
      ))}
    </div>
    <Shimmer className="h-11 rounded-full" />
  </Wrap>
);

const GridSkeleton = () => (
  <Wrap>
    <Shimmer className="h-6 w-32 mb-2" />
    <div className="grid grid-cols-2 gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <Shimmer key={i} className="aspect-square rounded-2xl" />
      ))}
    </div>
  </Wrap>
);

const ListSkeleton = () => (
  <Wrap>
    <Shimmer className="h-6 w-40 mb-2" />
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="flex items-center gap-3 py-1">
        <Shimmer className="h-11 w-11 rounded-2xl" />
        <div className="flex-1 space-y-1.5">
          <Shimmer className="h-3 w-2/3" />
          <Shimmer className="h-2 w-1/3" />
        </div>
      </div>
    ))}
  </Wrap>
);

const MapSkeleton = () => (
  <Wrap>
    <Shimmer className="flex-1 rounded-3xl" />
  </Wrap>
);

const SettingsSkeleton = () => (
  <Wrap>
    <Shimmer className="h-8 w-36" />
    <div className="space-y-2 pt-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Shimmer key={i} className="h-14 rounded-2xl" />
      ))}
    </div>
  </Wrap>
);

const Default = () => (
  <Wrap>
    <Shimmer className="h-7 w-40" />
    <Shimmer className="h-24 rounded-2xl" />
    <Shimmer className="h-24 rounded-2xl" />
    <Shimmer className="h-24 rounded-2xl" />
  </Wrap>
);

export const PageSkeleton = ({ variant = "default" }: { variant?: Variant }) => {
  switch (variant) {
    case "chat": return <ChatSkeleton />;
    case "grid": return <GridSkeleton />;
    case "list": return <ListSkeleton />;
    case "map": return <MapSkeleton />;
    case "settings": return <SettingsSkeleton />;
    default: return <Default />;
  }
};

export default PageSkeleton;
