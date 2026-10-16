/** Shimmer — base building block for skeletons. Respects prefers-reduced-motion. */
import { cn } from "@/lib/utils";

interface Props extends React.HTMLAttributes<HTMLDivElement> {}

export const Shimmer = ({ className, ...rest }: Props) => (
  <div
    aria-hidden
    className={cn(
      "relative overflow-hidden rounded-xl bg-muted/60",
      "before:absolute before:inset-0 before:-translate-x-full before:bg-gradient-to-r",
      "before:from-transparent before:via-foreground/[0.04] before:to-transparent",
      "motion-safe:before:animate-[shimmer_1.6s_infinite]",
      className,
    )}
    {...rest}
  />
);

export default Shimmer;
