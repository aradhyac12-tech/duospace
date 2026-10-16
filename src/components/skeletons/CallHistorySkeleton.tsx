/**
 * CallHistorySkeleton — placeholder rows for the "Recent" list on the Calls
 * tab while call history is loading for the first time.
 *
 * Mirrors CallHistoryRow's layout (36px leading circle, two text lines,
 * trailing duration) so nothing shifts when real rows replace it. Also
 * prevents the misleading "No calls yet" empty state from flashing on every
 * launch before the first fetch has actually returned.
 */
import Shimmer from "./Shimmer";

const ROW_COUNT = 5;

export const CallHistorySkeleton = () => (
  <div role="status" aria-busy="true">
    <span className="sr-only">Loading recent calls</span>
    {Array.from({ length: ROW_COUNT }).map((_, i) => (
      <div
        key={i}
        className={`flex items-center gap-3 py-3 ${i === ROW_COUNT - 1 ? "" : "border-b border-border/10"}`}
      >
        <Shimmer className="h-9 w-9 rounded-full shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <Shimmer className="h-3.5 w-28 rounded-md" />
          <Shimmer className="h-2.5 w-40 rounded-md" />
        </div>
        <Shimmer className="h-3 w-10 rounded-md shrink-0" />
      </div>
    ))}
  </div>
);

export default CallHistorySkeleton;
