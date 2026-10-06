import Link from 'next/link';
import { CreateOrJoin } from '@/components/CreateOrJoin';

export default function HomePage() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen max-w-md flex-col">
      <header className="px-3 pt-8 text-center">
        <h1 className="text-2xl font-bold text-qx-text">Qwixx Score Sheet</h1>
        <p className="mt-1 text-sm text-qx-muted">A multiplayer score sheet for the dice game Qwixx.</p>
      </header>

      <CreateOrJoin />

      <nav className="mt-auto flex justify-center gap-6 px-3 py-6 text-sm font-medium text-qx-text">
        <Link href="/rules" className="underline">
          Rules
        </Link>
        <Link href="/history" className="underline">
          History
        </Link>
        <Link href="/profile" className="underline">
          Profile
        </Link>
      </nav>
    </main>
  );
}
