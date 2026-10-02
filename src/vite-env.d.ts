/// <reference types="vite/client" />

declare module "@tanstack/react-start" {
  export const createMiddleware: (options: { type: string }) => {
    client: <T>(handler: (args: { next: (nextArgs?: { headers?: Record<string, string> }) => T | Promise<T> }) => T | Promise<T>) => unknown;
  };
}
