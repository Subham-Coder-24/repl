import { useState } from 'react';
import { Code2 } from 'lucide-react';
import { useAuth } from '../auth.jsx';

export default function AuthPage() {
  const { authenticate } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await authenticate(mode, username.trim(), password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const isLogin = mode === 'login';

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <Code2 size={28} /> CodeSpace
        </div>
        <h2>{isLogin ? 'Welcome back' : 'Create your account'}</h2>

        <label>
          Username
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          {!isLogin && (
            <span className="small">3-50 characters, no spaces. Letters, numbers, . _ - @ allowed.</span>
          )}
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
            required
          />
          {!isLogin && <span className="small">At least 6 characters.</span>}
        </label>

        {error && <div className="error">{error}</div>}

        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : isLogin ? 'Log in' : 'Sign up'}
        </button>

        <p className="muted small">
          {isLogin ? "Don't have an account? " : 'Already have an account? '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(isLogin ? 'register' : 'login');
              setError('');
            }}
          >
            {isLogin ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </form>
    </div>
  );
}
