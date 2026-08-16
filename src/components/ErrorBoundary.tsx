/**
 * ErrorBoundary — catches unhandled React render errors.
 *
 * FIX AUDIT #2: Silent errors in React trees previously caused white screens
 * with no feedback. This boundary catches render-phase exceptions, logs them
 * via telemetry, and shows a recovery UI.
 *
 * Usage:
 *   <ErrorBoundary context="Chat">
 *     <Chat />
 *   </ErrorBoundary>
 */

import { Component, type ReactNode, type ErrorInfo } from "react";
import { logError } from "@/lib/telemetry";
import { errorManager } from "@/lib/errors/errorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";
import { ErrorCard } from "@/components/errors/ErrorCard";

interface Props {
  children: ReactNode;
  /** Human-readable context label for telemetry (e.g. "Chat", "Calls") */
  context?: string;
  /** Custom fallback UI; receives `reset` callback */
  fallback?: (reset: () => void) => ReactNode;
  /** DS error code to raise for renders errors caught in this boundary. Defaults to DS-UNKNOWN-001. */
  errorCode?: string;
  /** Whether to show stack traces / raw details in the default card. Gate this on a Developer Mode setting. */
  developerMode?: boolean;
}

interface State {
  hasError: boolean;
  errorMessage: string;
  dsError: DuoSpaceErrorPayload | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "", dsError: null };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const context = this.props.context ?? "unknown";
    // Preserve the existing telemetry call verbatim — nothing that already
    // depends on this event shape (recentEvents, backend sink) regresses.
    logError(`ErrorBoundary[${context}]`, "Unhandled render error", { error, componentStack: info.componentStack });

    // Also raise it through the DuoSpace Error System so it shows up in the
    // dev log panel / stats and (for the default fallback) renders as a
    // proper ErrorCard instead of a bare message.
    const dsError = errorManager.capture(this.props.errorCode ?? "DS-UNKNOWN-001", {
      screen: context,
      component: "ErrorBoundary",
      cause: error,
      details: { componentStack: info.componentStack },
    });
    this.setState({ dsError });
  }

  reset = (): void => {
    this.setState({ hasError: false, errorMessage: "", dsError: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(this.reset);
    }

    if (this.state.dsError) {
      return (
        <div className="flex items-center justify-center min-h-[200px] px-6 py-10">
          <ErrorCard error={this.state.dsError} onRetry={this.reset} developerMode={this.props.developerMode} />
        </div>
      );
    }

    // Fallback for the rare frame where getDerivedStateFromError has fired
    // but componentDidCatch (and therefore the DS error) hasn't yet.
    return (
      <div className="flex flex-col items-center justify-center min-h-[200px] px-6 py-10 gap-4">
        <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
          <span className="text-xl">⚠️</span>
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-foreground">Something went wrong</p>
          {this.state.errorMessage && (
            <p className="text-xs text-muted-foreground max-w-[260px] break-words">
              {this.state.errorMessage}
            </p>
          )}
        </div>
        <button
          onClick={this.reset}
          className="h-9 px-5 rounded-full bg-primary text-primary-foreground text-xs font-medium"
        >
          Try again
        </button>
      </div>
    );
  }
}
