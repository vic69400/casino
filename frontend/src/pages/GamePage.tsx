import { useEffect, useState } from 'react';
import {
  ApiError,
  cashOut,
  clearAuth,
  devLogin,
  getStoredAuth,
  playRound,
  startGame,
  type AuthUser,
} from '../api/client';

type GameStatus = 'idle' | 'active' | 'busted' | 'cashed_out';

interface RoundEntry {
  roundNumber: number;
  chosenSide: 'left' | 'right';
  safeSide: 'left' | 'right';
  survived: boolean;
}

export default function GamePage() {
  const [auth, setAuth] = useState<AuthUser | null>(() => getStoredAuth()?.user ?? null);
  const [usernameInput, setUsernameInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  const [betInput, setBetInput] = useState('100');
  const [status, setStatus] = useState<GameStatus>('idle');
  const [multiplier, setMultiplier] = useState(1);
  const [rounds, setRounds] = useState<RoundEntry[]>([]);
  const [lastOutcome, setLastOutcome] = useState<'survived' | 'busted' | null>(null);
  const [lastPayout, setLastPayout] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (lastOutcome === null) return;
    const timeout = setTimeout(() => setLastOutcome(null), 900);
    return () => clearTimeout(timeout);
  }, [lastOutcome, rounds.length]);

  async function handleLogin() {
    setAuthError(null);
    if (usernameInput.trim().length < 3) {
      setAuthError('Le pseudo doit contenir au moins 3 caractères');
      return;
    }
    try {
      const user = await devLogin(usernameInput.trim());
      setAuth(user);
    } catch (err) {
      setAuthError(err instanceof ApiError ? err.message : 'Connexion impossible');
    }
  }

  function handleLogout() {
    clearAuth();
    setAuth(null);
    setStatus('idle');
    setRounds([]);
    setMultiplier(1);
  }

  async function handleStart() {
    setError(null);
    const betAmount = Number(betInput);
    if (!Number.isInteger(betAmount) || betAmount <= 0) {
      setError('La mise doit être un entier positif');
      return;
    }
    setLoading(true);
    try {
      const result = await startGame(betAmount);
      setAuth((prev) => (prev ? { ...prev, balance: result.balance } : prev));
      setStatus('active');
      setMultiplier(result.cumulativeMultiplier);
      setRounds([]);
      setLastPayout(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de démarrer la partie');
    } finally {
      setLoading(false);
    }
  }

  async function handlePlay(direction: 'left' | 'right') {
    setError(null);
    setLoading(true);
    try {
      const result = await playRound(direction);
      setRounds((prev) => [
        ...prev,
        {
          roundNumber: result.roundNumber,
          chosenSide: result.chosenSide,
          safeSide: result.safeSide,
          survived: result.survived,
        },
      ]);
      setMultiplier(result.cumulativeMultiplier);
      setLastOutcome(result.survived ? 'survived' : 'busted');
      setStatus(result.status);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erreur lors du round');
    } finally {
      setLoading(false);
    }
  }

  async function handleCashOut() {
    setError(null);
    setLoading(true);
    try {
      const result = await cashOut();
      setAuth((prev) => (prev ? { ...prev, balance: result.balance } : prev));
      setLastPayout(result.payout);
      setStatus('cashed_out');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Impossible de cash-out');
    } finally {
      setLoading(false);
    }
  }

  if (!auth) {
    return (
      <div className="max-w-sm mx-auto mt-16 flex flex-col gap-4">
        <h1 className="text-2xl font-bold text-center">Bienvenue sur Split</h1>
        <p className="text-slate-400 text-sm text-center">
          Entrez un pseudo pour rejoindre la table (connexion de démo, sans mot de passe).
        </p>
        <input
          className="rounded-lg bg-slate-900 border border-slate-700 px-4 py-2 text-center"
          placeholder="Votre pseudo"
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
        />
        {authError && <p className="text-red-400 text-sm text-center">{authError}</p>}
        <button
          onClick={handleLogin}
          className="rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2 transition-colors"
        >
          Se connecter
        </button>
      </div>
    );
  }

  const betAmount = Number(betInput);
  const canStart = status !== 'active' && Number.isInteger(betAmount) && betAmount > 0 && betAmount <= auth.balance;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between rounded-xl bg-slate-900 border border-slate-800 px-4 py-3">
        <div>
          <p className="text-xs text-slate-400">Joueur</p>
          <p className="font-medium">{auth.username}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-400">Solde simulé</p>
          <p className="font-mono text-lg text-emerald-400">{auth.balance.toLocaleString('fr-FR')}</p>
        </div>
        <button onClick={handleLogout} className="text-xs text-slate-500 hover:text-slate-300 underline">
          déconnexion
        </button>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col gap-4">
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-xs text-slate-400">Mise</label>
            <input
              type="number"
              min={1}
              disabled={status === 'active'}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 disabled:opacity-50"
              value={betInput}
              onChange={(e) => setBetInput(e.target.value)}
            />
          </div>
          <button
            onClick={handleStart}
            disabled={!canStart || loading}
            className="rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:text-slate-400 text-slate-950 font-semibold px-5 py-2 transition-colors"
          >
            Démarrer la partie
          </button>
        </div>

        {status === 'active' && (
          <div className="flex flex-col gap-4 items-center py-4">
            <p className="text-sm text-slate-400">Multiplicateur cumulé</p>
            <p className="text-4xl font-mono font-bold text-emerald-400">{multiplier.toFixed(2)}x</p>

            <div className="grid grid-cols-2 gap-4 w-full max-w-sm mt-2">
              <button
                onClick={() => handlePlay('left')}
                disabled={loading}
                className="rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 py-6 text-lg font-semibold transition-colors disabled:opacity-50"
              >
                ⬅ GAUCHE
              </button>
              <button
                onClick={() => handlePlay('right')}
                disabled={loading}
                className="rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 py-6 text-lg font-semibold transition-colors disabled:opacity-50"
              >
                DROITE ➡
              </button>
            </div>

            <button
              onClick={handleCashOut}
              disabled={loading || rounds.length === 0}
              className="w-full max-w-sm rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-slate-700 disabled:text-slate-400 text-slate-950 font-semibold py-2 transition-colors"
            >
              Cash-out
            </button>
          </div>
        )}

        {status === 'busted' && (
          <div className="rounded-lg bg-red-950 border border-red-800 text-red-300 text-center py-3 font-medium">
            💥 Perdu — mauvais côté. Mise entièrement perdue.
          </div>
        )}

        {status === 'cashed_out' && lastPayout !== null && (
          <div className="rounded-lg bg-emerald-950 border border-emerald-800 text-emerald-300 text-center py-3 font-medium">
            ✅ Cash-out réussi : +{lastPayout.toLocaleString('fr-FR')}
          </div>
        )}

        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
      </div>

      {rounds.length > 0 && (
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
          <h2 className="text-sm font-semibold text-slate-400 mb-3">Historique de la partie en cours</h2>
          <ul className="flex flex-col gap-2">
            {[...rounds].reverse().map((round) => (
              <li
                key={round.roundNumber}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm border transition-colors ${
                  round.survived
                    ? 'bg-emerald-950/50 border-emerald-800'
                    : 'bg-red-950/50 border-red-800'
                } ${
                  lastOutcome && round.roundNumber === rounds[rounds.length - 1]?.roundNumber
                    ? 'animate-pulse'
                    : ''
                }`}
              >
                <span className="text-slate-400">Round #{round.roundNumber}</span>
                <span>
                  choix: <strong>{round.chosenSide === 'left' ? 'gauche' : 'droite'}</strong>
                </span>
                <span>
                  sûr: <strong>{round.safeSide === 'left' ? 'gauche' : 'droite'}</strong>
                </span>
                <span className={round.survived ? 'text-emerald-400' : 'text-red-400'}>
                  {round.survived ? 'survécu' : 'busted'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
