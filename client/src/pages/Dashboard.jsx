import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Code2, LogOut, Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import StackIcon from '../components/StackIcon.jsx';

const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export default function Dashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [stacks, setStacks] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [stack, setStack] = useState('react');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/projects').then((d) => setProjects(d.projects)).catch((e) => setError(e.message));
    api('/projects/stacks').then((d) => setStacks(d.stacks));
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { project } = await api('/projects', { method: 'POST', body: { name, stack } });
      navigate(`/workspace/${project.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const remove = async (project) => {
    if (!confirm(`Delete "${project.name}" and all its files?`)) return;
    await api(`/projects/${project.id}`, { method: 'DELETE' });
    setProjects((list) => list.filter((p) => p.id !== project.id));
  };

  return (
    <div className="dashboard">
      <header className="topbar">
        <div className="brand">
          <Code2 size={22} /> CodeSpace
        </div>
        <div className="row gap">
          <span className="muted">@{user.username}</span>
          <button className="btn ghost" onClick={logout}>
            <LogOut size={16} /> Log out
          </button>
        </div>
      </header>

      <main className="dashboard-body">
        <div className="row space-between">
          <h1>Your projects</h1>
          <button className="btn primary" onClick={() => setShowNew(true)}>
            <Plus size={16} /> New project
          </button>
        </div>

        {error && !showNew && <div className="error">{error}</div>}

        {projects.length === 0 ? (
          <div className="empty card">
            <p>No projects yet. Create one to get a workspace with an editor, terminal and preview.</p>
            <button className="btn primary" onClick={() => setShowNew(true)}>
              <Plus size={16} /> Create your first project
            </button>
          </div>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div
                key={p.id}
                className="card project-card"
                onClick={() => navigate(`/workspace/${p.id}`)}
              >
                <div className="row gap">
                  <StackIcon stack={p.stack} size={22} />
                  <strong className="ellipsis">{p.name}</strong>
                </div>
                <div className="row space-between muted small">
                  <span>Edited {timeAgo(p.updatedAt)}</span>
                  <button
                    className="icon-btn danger"
                    title="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(p);
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {showNew && (
        <div className="modal-backdrop" onClick={() => !busy && setShowNew(false)}>
          <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <h2>Create a project</h2>
            <label>
              Project name
              <input
                autoFocus
                value={name}
                maxLength={50}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-awesome-app"
                required
              />
            </label>

            <div className="label">Tech stack</div>
            <div className="stack-grid">
              {stacks.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`stack-option ${stack === s.id ? 'selected' : ''}`}
                  onClick={() => setStack(s.id)}
                >
                  <StackIcon stack={s.id} size={26} />
                  <strong>{s.label}</strong>
                  <span className="muted small">{s.description}</span>
                </button>
              ))}
            </div>

            {error && <div className="error">{error}</div>}

            <div className="row gap end">
              <button type="button" className="btn ghost" onClick={() => setShowNew(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create workspace'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
