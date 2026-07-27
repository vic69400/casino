import { useState } from 'react';
import { ApiError, verifySession, type VerifySessionResponse } from '../api/client';

export default function VerifyPage() {
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState<VerifySessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVerify() {
    setError(null);
    setResult(null);
    if (!sessionId.trim()) {
      setError('Entrez un identifiant de session');
      return;
    }
    setLoading(true);
    try {
      const data = await verifySession(sessionId.trim());
      setResult(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Vérification impossible');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Vérifier l'équité</h1>
        <p className="text-slate-400 text-sm mt-1">
          Chaque round de Split est déterminé par un HMAC-SHA256 calculé à partir d'un serverSeed secret,
          d'un clientSeed et d'un numéro de round. Une fois la session terminée (rotation des seeds), le
          serverSeed est révélé et n'importe qui peut recalculer chaque round pour confirmer qu'il n'a pas
          été manipulé.
        </p>
      </div>

      <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col gap-3">
        <label className="text-xs text-slate-400">Identifiant de session (sessionId)</label>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 font-mono text-sm"
            placeholder="ex: 3f29b1a2-..."
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleVerify()}
          />
          <button
            onClick={handleVerify}
            disabled={loading}
            className="rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 text-slate-950 font-semibold px-4 py-2 transition-colors"
          >
            Vérifier
          </button>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>

      {result && (
        <div className="rounded-xl bg-slate-900 border border-slate-800 p-4 flex flex-col gap-4">
          <div
            className={`rounded-lg px-4 py-3 text-center font-semibold ${
              result.allRoundsValid
                ? 'bg-emerald-950 border border-emerald-800 text-emerald-300'
                : 'bg-red-950 border border-red-800 text-red-300'
            }`}
          >
            {result.allRoundsValid ? '✅ Tous les rounds sont valides' : '❌ Incohérence détectée'}
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <Field label="Server Seed (révélé)" value={result.serverSeed} mono />
            <Field label="Server Seed Hash" value={result.serverSeedHash} mono />
            <Field label="Client Seed" value={result.clientSeed} mono />
            <Field label="Nonce" value={String(result.nonce)} />
          </dl>

          <div>
            <h2 className="text-sm font-semibold text-slate-400 mb-2">Rounds ({result.rounds.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b border-slate-800">
                    <th className="py-1 pr-3">#</th>
                    <th className="py-1 pr-3">Choix</th>
                    <th className="py-1 pr-3">Sûr</th>
                    <th className="py-1 pr-3">Résultat</th>
                    <th className="py-1 pr-3">HMAC</th>
                    <th className="py-1">Valide</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rounds.map((round) => (
                    <tr key={round.roundNumber} className="border-b border-slate-900">
                      <td className="py-1 pr-3">{round.roundNumber}</td>
                      <td className="py-1 pr-3">{round.chosenSide}</td>
                      <td className="py-1 pr-3">{round.safeSide}</td>
                      <td className={`py-1 pr-3 ${round.survived ? 'text-emerald-400' : 'text-red-400'}`}>
                        {round.survived ? 'survécu' : 'busted'}
                      </td>
                      <td className="py-1 pr-3 font-mono text-xs text-slate-500 truncate max-w-[10rem]">
                        {round.hmac}
                      </td>
                      <td className="py-1">{round.valid ? '✅' : '❌'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-950 border border-slate-800 px-3 py-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
