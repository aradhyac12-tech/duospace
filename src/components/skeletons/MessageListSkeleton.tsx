/**
 * MessageListSkeleton — shown inside the chat timeline while the conversation
 * is loading (partner lookup -> E2E key exchange -> fetch -> decrypt).
 *
 * Replaces the old centered "Loading messages…" text. Bubble shapes alternate
 * left/right like a real conversation so the layout doesn't jump when the
 * real messages land. Purely presentational; no data, no timers.
 */
import Shimmer from "./Shimmer";

const ROWS: { mine: boolean; w: string; h: string }[] = [
  { mine: false, w: "w-52", h: "h-10" },
  { mine: false, w: "w-36", h: "h-10" },
  { mine: true, w: "w-44", h: "h-10" },
  { mine: true, w: "w-60", h: "h-14" },
  { mine: false, w: "w-64", h: "h-14" },
  { mine: true, w: "w-32", h: "h-10" },
  { mine: false, w: "w-48", h: "h-10" },
  { mine: true, w: "w-52", h: "h-10" },
];

export const MessageListSkeleton = () => (
  <div role="status" aria-busy="true" className="flex flex-col gap-2.5 py-2">
    <span className="sr-only">Loading messages</span>
    <div className="flex justify-center pb-1">
      <Shimmer className="h-5 w-16 rounded-full" />
    </div>
    {ROWS.map((row, i) => (
      <div key={i} className={`flex ${row.mine ? "justify-end" : "justify-start"}`}>
        <Shimmer
          className={`${row.h} ${row.w} max-w-[75%] ${
            row.mine ? "rounded-2xl rounded-br-md" : "rounded-2xl rounded-bl-md"
          }`}
        />
      </div>
    ))}
  </div>
);

export default MessageListSkeleton;
