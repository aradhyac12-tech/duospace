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

interface Props {
  children: ReactNode;
  /** Human-readable context label for telemetry (e.g. "Chat", "Calls") */
  context?: string;
  /** Custom fallback UI; receives `reset` callback */
  fallback?: (reset: () => void) => ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const context = this.props.context ?? "unknown";
    logError(`ErrorBoundary[${context}]`, "Unhandled render error", { error, componentStack: info.componentStack });
  }

  reset = (): void => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(this.reset);
    }

    // Default fallback UI — minimal and action-oriented
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
          className="h-9 px-5 rounded-full bg-foreground text-background text-xs font-medium"
        >
          Try again
        </button>
      </div>
    );
  }
}
