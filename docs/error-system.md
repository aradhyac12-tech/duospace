# DuoSpace Error System

A centralized, typed error framework: every error in the app is normalized
into one shape (`DuoSpaceErrorPayload`), logged consistently, optionally
auto-recovered, and — when it reaches the UI — rendered as the same premium
error card everywhere.

## What's included

```
src/lib/errors/
  types.ts                  Categories, severities, error codes, payload shape
  registry.ts                DS-<MODULE>-<NUMBER> catalog (title/message/recovery per code)
  DuoSpaceError.ts            The error class + factory; captures device/session/stack automatically
  errorManager.ts             Singleton: capture(), init() global handlers, log store, stats, search/filter/export
  recovery.ts                 Pluggable recovery-strategy registry
  registerAppRecoveries.ts    Wires real recovery handlers (session refresh, Supabase reachability probe)
  useErrorManager.ts          React hook: useErrorManager(screen), useErrorStream(onError)
  index.ts                    Barrel export — `import { errorManager, ... } from "@/lib/errors"`

src/components/errors/
  ErrorCard.tsx                Premium error card: icon, title, code, retry/copy/report, expandable details
  ErrorLogPanel.tsx            Developer Mode log viewer: search, filter, frequency + recovery stats, export
```

Wired in automatically:
- `src/main.tsx` — calls `errorManager.init()` (installs `window.onerror` /
  `unhandledrejection` handlers) and `registerAppRecoveries()` at boot.
- `src/components/ErrorBoundary.tsx` — every render error caught by an
  `<ErrorBoundary>` anywhere in the tree now also flows through
  `errorManager.capture()` and renders an `<ErrorCard>` by default (existing
  `fallback` prop still works unchanged — nothing that already passes a
  custom fallback is affected).
- `src/lib/edgeFunction.ts` — every failure mode already handled there
  (network unreachable, timeout, 404/not-deployed, generic HTTP error) also
  raises the matching `DS-NET-*` / `DS-API-*` code, in addition to its
  existing `logWarn` calls and `EdgeFunctionError` throw (unchanged, so no
  caller's catch logic needs to change).

## Raising an error from anywhere else

```ts
import { errorManager } from "@/lib/errors";

try {
  await sendMessage();
} catch (err) {
  errorManager.capture("DS-CHAT-001", {
    screen: "Chat",
    component: "MessageComposer",
    cause: err,
  });
}
```

Or, inside a component, tag every capture with the screen automatically:

```ts
import { useErrorManager } from "@/lib/errors";

function MessageComposer() {
  const { capture } = useErrorManager("Chat");
  // ...
  catch (err) { capture("DS-CHAT-001", { component: "MessageComposer", cause: err }); }
}
```

## Showing the card yourself (outside an ErrorBoundary)

```tsx
import { ErrorCard } from "@/components/errors/ErrorCard";

const payload = errorManager.capture("DS-STORAGE-003", { cause: err });
return <ErrorCard error={payload} onRetry={() => retryUpload()} developerMode={isDevMode} />;
```

## Adding a new error code

1. If it's a new module, add it to the `ErrorModule` union in `types.ts`.
2. Add an entry to `ERROR_REGISTRY` in `registry.ts` with title, message,
   recovery suggestion, `retryable`, and `recoveryAction`.
3. Call `errorManager.capture("DS-YOURMODULE-00N", {...})` at the failure site.

## Registering a real recovery handler

`recovery.ts` ships two built-ins (`retry-network`, `none`) plus what
`registerAppRecoveries.ts` wires (`refresh-session`, `retry-supabase`).
`resume-upload`, `reconnect-socket`, and `restore-previous-theme` are
intentionally left for the owning module to register, since they need
state the error system doesn't have (the in-flight upload handle, the
socket instance, the last-known-good theme):

```ts
// e.g. near the top of resumableUpload.ts
import { registerRecovery } from "@/lib/errors/recovery";
registerRecovery("resume-upload", async () => resumeLastUpload());
```

## Developer Mode

Stack traces and raw `details` are captured on every payload but only
rendered by `<ErrorCard developerMode={...} />` and shown in full by
`<ErrorLogPanel>` when that prop/panel is gated behind a Developer Mode
setting — plug in whatever boolean Settings already uses for that.

## Scope note

This pass ships the framework itself, wires the three highest-leverage
integration points (global crash capture, the render-error boundary, and
the edge-function client used by most Supabase calls), and gives one
worked recovery example (`refresh-session`). It does **not** touch each of
the ~380 files in the project individually — call sites in Chat, Calls,
Theme Studio, Icon Studio, etc. should adopt `errorManager.capture(...)`
incrementally as those modules are touched, using the DS-CHAT-*, DS-CALL-*,
DS-THEME-*, DS-ICON-* codes already defined in `registry.ts`.
