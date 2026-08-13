'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';
import { Sidebar } from './Sidebar';

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/chat': 'Chat',
  '/documents': 'Knowledge Base',
  '/models': 'Models',
  '/playground': 'Playground',
  '/analytics': 'Analytics',
  '/settings': 'Settings',
  '/login': 'Sign in',
  '/register': 'Sign up',
};

const AUTH_PAGES = ['/login', '/register'];

/** Pages that render their own chrome (sidebar + header) and skip the shell's. */
const SELF_LAYOUT_PAGES = ['/chat'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const title = TITLES[pathname] ?? 'Smoke Monkey';
  const isAuthPage = AUTH_PAGES.includes(pathname);
  const isSelfLayout = SELF_LAYOUT_PAGES.includes(pathname);

  // Route guard: signed-out users are sent to /login, signed-in users away
  // from the auth pages.
  useEffect(() => {
    if (loading) return;
    if (!user && !isAuthPage) {
      router.replace('/login');
    } else if (user && isAuthPage) {
      router.replace('/');
    }
  }, [loading, user, isAuthPage, router]);

  // Auth pages get a clean, centered layout — no app chrome.
  if (isAuthPage) {
    return (
      <div className="flex min-h-screen items-start justify-center bg-bg text-ink-primary">
        <main className="min-h-0 w-full flex-1">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-ink-primary">
      {!isSelfLayout && <Sidebar />}
      <div className="flex min-w-0 flex-1 flex-col">
        {!isSelfLayout && (
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-surface-700 bg-surface-900/60 px-4">
            <div className="flex items-center gap-3">
              <h1 className="text-sm font-semibold text-white">{title}</h1>
            </div>
            <div className="flex items-center gap-3">
              {user ? (
                <>
                  <span className="text-sm text-ink-secondary">{user.email}</span>
                  <button
                    className="btn-ghost px-3 py-1.5"
                    onClick={() => {
                      logout();
                      router.push('/login');
                    }}
                  >
                    Sign out
                  </button>
                </>
              ) : (
                !loading && (
                  <a href="/login" className="btn-primary px-3 py-1.5">
                    Sign in
                  </a>
                )
              )}
            </div>
          </header>
        )}
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
