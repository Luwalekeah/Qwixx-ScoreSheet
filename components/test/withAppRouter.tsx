// Test-only helper. Next.js's App Router hooks (useRouter, usePathname, ...) throw
// "invariant expected app router to be mounted" outside of a real Next.js render
// tree. There is no officially published test utility for this pre-App-Router-testing
// support, so this wraps a component under test in the same internal context Next.js
// itself provides at runtime, with a router double that records calls instead of
// navigating. Used only by *.test.tsx files rendering client components that call
// useRouter() (currently CreateOrJoin).
import type { ReactNode } from 'react';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';

export function createMockRouter(overrides: Partial<AppRouterInstance> = {}): AppRouterInstance {
  return {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: async () => {},
    ...overrides,
  };
}

export function withAppRouter(children: ReactNode, router: AppRouterInstance = createMockRouter()) {
  return <AppRouterContext.Provider value={router}>{children}</AppRouterContext.Provider>;
}
