import { HashRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import GamePage from './pages/GamePage';
import VerifyPage from './pages/VerifyPage';

export default function App() {
  return (
    <HashRouter>
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-10">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
            <Link to="/" className="text-lg font-bold tracking-tight text-emerald-400">
              Split
            </Link>
            <nav className="flex gap-4 text-sm">
              <NavLink
                to="/"
                className={({ isActive }) =>
                  isActive ? 'text-emerald-400 font-medium' : 'text-slate-400 hover:text-slate-200'
                }
                end
              >
                Jouer
              </NavLink>
              <NavLink
                to="/verify"
                className={({ isActive }) =>
                  isActive ? 'text-emerald-400 font-medium' : 'text-slate-400 hover:text-slate-200'
                }
              >
                Vérifier l'équité
              </NavLink>
            </nav>
          </div>
        </header>

        <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-6">
          <Routes>
            <Route path="/" element={<GamePage />} />
            <Route path="/verify" element={<VerifyPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
