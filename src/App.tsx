import { Outlet, Link } from 'react-router-dom';

export function App() {
  return (
    <div className="min-h-dvh flex flex-col">
      <header className="px-4 sm:px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-baseline gap-3">
          <Link
            to="/"
            className="font-display text-2xl sm:text-3xl font-black tracking-tight text-ink-800"
          >
            Logos
          </Link>
          <span className="text-[11px] sm:text-xs text-ink-400 italic">
            Every question fresh. Every answer teaches.
          </span>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="px-4 sm:px-6 py-6">
        <div className="mx-auto max-w-5xl text-[11px] text-ink-400 tracking-wide">
          Sola scriptura · grounded in the 66-book Protestant canon · open source
        </div>
      </footer>
    </div>
  );
}
