# Handoff: chat date / call / message overlap

Affects the virtualized timeline (long chats; MessageTimeline isVirtualized path), where rows are absolutely
positioned from measured heights. Two bugs made rows draw on top of each other:

1. VirtualRow's ResizeObserver reported `contentRect.height` (EXCLUDES the wrapper's padding: 12+12 on date
   chips, 2 on messages) while the first measurement used getBoundingClientRect (includes it). After the first
   resize callback every slot was too short -> next row slid up under it (worst at date chips and call events).
   Now uses borderBoxSize / getBoundingClientRect.
2. useVirtualList cached heights by row INDEX. Any insert/remove above (new date chip, incoming call event,
   deleted message, load-older prepend) shifted indices onto the wrong cached heights. Cache is now keyed by
   the row's stable key (`getKey`, passed from MessageTimeline as flatRows[i].key). measureItem also ignores
   <=0.5px jitter to avoid re-layout loops.

Files: src/hooks/useVirtualList.ts, src/components/chat/MessageTimeline.tsx.
Not verified: no build/tests/device here (both files transpile with 0 syntax errors). Please scroll a long chat
across a date change with a call event and send a message while scrolled up.
If overlap still appears in a SHORT chat (non-virtualized path), send a screenshot - that path is plain flow
layout and would be a different cause.
