export default function OfflinePage() {
  return (
    <main id="main" tabIndex={-1} className="flex min-h-screen flex-col items-center justify-center gap-2 px-3 text-center">
      <h1 className="text-xl font-bold text-qx-text">You are offline</h1>
      <p className="text-sm text-qx-muted">
        This page needs a network connection the first time you open it. A game already in progress keeps
        working and saves your taps until you reconnect.
      </p>
    </main>
  );
}
