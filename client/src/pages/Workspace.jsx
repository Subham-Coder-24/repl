import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Editor from '@monaco-editor/react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { io } from 'socket.io-client';
import { ArrowLeft, ExternalLink, Loader2, Play, RefreshCw, Square, X } from 'lucide-react';
import { getToken, projectApi } from '../api.js';
import FileTree from '../components/FileTree.jsx';
import XTerm from '../components/XTerm.jsx';
import StackIcon from '../components/StackIcon.jsx';

const LANGUAGES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', html: 'html', css: 'css',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell', txt: 'plaintext',
};
const languageOf = (path) => LANGUAGES[path.split('.').pop().toLowerCase()] || 'plaintext';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const isUnder = (path, base) => path === base || path.startsWith(`${base}/`);

export default function Workspace() {
  const { id } = useParams();
  const fsApi = useMemo(() => projectApi(id), [id]);

  const [project, setProject] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewType, setPreviewType] = useState(null); // 'port' | 'static' | null
  const [runnable, setRunnable] = useState(true);
  const [tree, setTree] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [files, setFiles] = useState({}); // path -> { content, saved }
  const [previewKey, setPreviewKey] = useState(0);
  const [previewLive, setPreviewLive] = useState(false);
  const [termIsPty, setTermIsPty] = useState(true);
  const [socket, setSocket] = useState(null);
  const [notice, setNotice] = useState('');
  const [fatal, setFatal] = useState('');

  const filesRef = useRef(files);
  filesRef.current = files;
  const termRef = useRef(null);

  const flash = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const refreshTree = useCallback(
    () => fsApi.tree().then((d) => setTree(d.tree)).catch((e) => flash(e.message)),
    [fsApi, flash],
  );

  // ---------- Files & tabs ----------
  const openFile = useCallback(
    async (path) => {
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setActive(path);
      if (filesRef.current[path]) return;
      try {
        const { content } = await fsApi.read(path);
        setFiles((cur) => ({ ...cur, [path]: { content, saved: content } }));
      } catch (e) {
        flash(`Cannot open ${path}: ${e.message}`);
        setTabs((t) => t.filter((p) => p !== path));
      }
    },
    [fsApi, flash],
  );

  const saveFile = useCallback(
    async (path) => {
      const f = filesRef.current[path];
      if (!f || f.content === f.saved) return;
      const { content } = f;
      try {
        await fsApi.write(path, content);
        setFiles((cur) => (cur[path] ? { ...cur, [path]: { ...cur[path], saved: content } } : cur));
      } catch (e) {
        flash(`Save failed: ${e.message}`);
      }
    },
    [fsApi, flash],
  );

  const saveAll = useCallback(
    () => Promise.all(Object.keys(filesRef.current).map(saveFile)),
    [saveFile],
  );
  const saveAllRef = useRef(saveAll);
  saveAllRef.current = saveAll;

  // Pick up changes made outside the editor (terminal, npm, scripts) for unmodified open files
  const syncOpenFiles = useCallback(async () => {
    for (const [path, f] of Object.entries(filesRef.current)) {
      if (f.content !== f.saved) continue;
      try {
        const { content } = await fsApi.read(path);
        setFiles((cur) => {
          const c = cur[path];
          if (!c || c.content !== c.saved || c.saved === content) return cur;
          return { ...cur, [path]: { content, saved: content } };
        });
      } catch {
        /* file was removed — leave the tab as is */
      }
    }
  }, [fsApi]);

  const closeTab = async (path) => {
    await saveFile(path);
    setTabs((t) => {
      const next = t.filter((p) => p !== path);
      if (active === path) setActive(next[Math.max(0, t.indexOf(path) - 1)] ?? null);
      return next;
    });
    setFiles(({ [path]: _, ...rest }) => rest);
  };

  // Auto-save shortly after typing stops
  useEffect(() => {
    const dirty = Object.values(files).some((f) => f.content !== f.saved);
    if (!dirty) return;
    const timer = setTimeout(() => saveAllRef.current(), 800);
    return () => clearTimeout(timer);
  }, [files]);

  // Ctrl/Cmd+S anywhere in the workspace
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveAllRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- Initial load ----------
  useEffect(() => {
    fsApi
      .get()
      .then(({ project, previewUrl, previewType, runnable }) => {
        setPreviewType(previewType);
        setRunnable(runnable);
        setProject(project);
        setPreviewUrl(previewUrl);
        setPreviewLive(previewType === 'static'); // static sites are always viewable
        if (project.entry) openFile(project.entry);
      })
      .catch((e) => setFatal(e.message));
    refreshTree();
  }, [fsApi, openFile, refreshTree]);

  // ---------- Realtime connection ----------
  useEffect(() => {
    const s = io({ auth: { token: getToken(), projectId: id } });
    s.on('terminal:output', (text) => {
      if (/Local:\s+http/.test(stripAnsi(text))) {
        // Vite dev server printed its URL — show / refresh the preview
        setPreviewLive(true);
        setPreviewKey((k) => k + 1);
      }
    });
    s.on('terminal:mode', ({ pty }) => setTermIsPty(pty));
    s.on('connect_error', (e) => flash(`Connection: ${e.message}`));
    setSocket(s);
    return () => s.disconnect();
  }, [id, flash]);

  useEffect(() => {
    if (!socket) return;
    const onChange = () => {
      refreshTree();
      syncOpenFiles();
      if (previewType === 'static') setPreviewKey((k) => k + 1); // live-reload static sites
    };
    socket.on('fs:changed', onChange);
    return () => socket.off('fs:changed', onChange);
  }, [socket, previewType, refreshTree, syncOpenFiles]);

  // ---------- File tree actions ----------
  const handleCreate = async (path, type) => {
    try {
      await fsApi.create(path, type);
      await refreshTree();
      if (type === 'file') openFile(path);
    } catch (e) {
      flash(e.message);
    }
  };

  const handleRename = async (from, to) => {
    try {
      await saveAll();
      await fsApi.rename(from, to);
      const move = (p) => (isUnder(p, from) ? to + p.slice(from.length) : p);
      setTabs((t) => t.map(move));
      setActive((a) => (a ? move(a) : a));
      setFiles((cur) => Object.fromEntries(Object.entries(cur).map(([p, f]) => [move(p), f])));
      await refreshTree();
    } catch (e) {
      flash(e.message);
    }
  };

  const handleDelete = async (path) => {
    try {
      await fsApi.remove(path);
      setTabs((t) => {
        const next = t.filter((p) => !isUnder(p, path));
        setActive((a) => (a && isUnder(a, path) ? next[next.length - 1] ?? null : a));
        return next;
      });
      setFiles((cur) => Object.fromEntries(Object.entries(cur).filter(([p]) => !isUnder(p, path))));
      await refreshTree();
    } catch (e) {
      flash(e.message);
    }
  };

  // ---------- Run ----------
  // Run types the stack's command into the terminal (the server does the typing)
  const run = async () => {
    await saveAll();
    if (!runnable) {
      setPreviewKey((k) => k + 1); // nothing to start (e.g. static site): just reload the preview
      return;
    }
    socket.emit('run:start');
    termRef.current?.focus();
  };

  if (fatal) {
    return (
      <div className="center-screen">
        <div className="card">
          <p className="error">{fatal}</p>
          <Link to="/" className="btn ghost">Back to projects</Link>
        </div>
      </div>
    );
  }
  if (!project || !socket) return <div className="center-screen muted">Loading workspace…</div>;

  const activeFile = active ? files[active] : null;
  const dirtyCount = Object.values(files).filter((f) => f.content !== f.saved).length;

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="row gap">
          <Link to="/" className="icon-btn" title="Back to projects">
            <ArrowLeft size={18} />
          </Link>
          <StackIcon stack={project.stack} />
          <strong>{project.name}</strong>
          <span className="muted small">{dirtyCount ? 'Saving…' : 'All changes saved'}</span>
        </div>
        <div className="row gap">
          <button className="btn run" onClick={run}>
            <Play size={14} fill="currentColor" /> Run
          </button>
          {runnable && (
            <button className="btn danger" onClick={() => socket.emit('run:stop')} title="Send Ctrl+C to the terminal">
              <Square size={14} fill="currentColor" /> Stop
            </button>
          )}
        </div>
        <div className="row gap muted small">{project.stack}</div>
      </header>

      {notice && <div className="toast">{notice}</div>}

      <PanelGroup direction="horizontal" className="ws-panels" autoSaveId="ws-horizontal">
        {/* Left: files */}
        <Panel defaultSize={17} minSize={10}>
          <FileTree
            tree={tree}
            activePath={active}
            onOpen={openFile}
            onCreate={handleCreate}
            onRename={handleRename}
            onDelete={handleDelete}
            onRefresh={refreshTree}
          />
        </Panel>
        <PanelResizeHandle className="resize-handle" />

        {/* Middle: editor */}
        <Panel defaultSize={48} minSize={20}>
          <div className="editor-pane">
            <div className="tabs">
              {tabs.map((path) => {
                const f = files[path];
                const dirty = f && f.content !== f.saved;
                return (
                  <div
                    key={path}
                    className={`tab ${path === active ? 'active' : ''}`}
                    onClick={() => setActive(path)}
                    title={path}
                  >
                    <span>{path.split('/').pop()}</span>
                    <button
                      className="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(path);
                      }}
                    >
                      {dirty ? <span className="dot" /> : <X size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="editor-body">
              {activeFile ? (
                <Editor
                  path={active}
                  language={languageOf(active)}
                  value={activeFile.content}
                  theme="vs-dark"
                  onChange={(value) =>
                    setFiles((cur) =>
                      cur[active] ? { ...cur, [active]: { ...cur[active], content: value ?? '' } } : cur,
                    )
                  }
                  options={{
                    fontSize: 14,
                    minimap: { enabled: false },
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                  }}
                  loading={<Loader2 className="spin" />}
                />
              ) : (
                <div className="center-fill muted">
                  {active ? <Loader2 className="spin" /> : 'Select a file from the tree to start editing'}
                </div>
              )}
            </div>
          </div>
        </Panel>
        <PanelResizeHandle className="resize-handle" />

        {/* Right: preview (if the stack has one) + the single terminal */}
        <Panel defaultSize={35} minSize={15}>
          <PanelGroup
            key={previewUrl ? 'with-preview' : 'terminal-only'}
            direction="vertical"
            autoSaveId={previewUrl ? 'ws-vertical' : 'ws-vertical-terminal'}
          >
            {previewUrl && (
              <>
                <Panel id="preview" order={1} defaultSize={50} minSize={15}>
                  <div className="side-pane">
                    <div className="pane-header">
                      <span>Preview</span>
                      <div className="row">
                        <button className="icon-btn" title="Reload" onClick={() => setPreviewKey((k) => k + 1)}>
                          <RefreshCw size={14} />
                        </button>
                        <a className="icon-btn" href={previewUrl} target="_blank" rel="noreferrer" title="Open in new tab">
                          <ExternalLink size={14} />
                        </a>
                      </div>
                    </div>
                    <div className="pane-body">
                      {previewLive ? (
                        <iframe key={previewKey} className="preview" src={previewUrl} title="Preview" />
                      ) : (
                        <div className="center-fill muted">Press Run to start the app.</div>
                      )}
                    </div>
                  </div>
                </Panel>
                <PanelResizeHandle className="resize-handle horizontal" />
              </>
            )}
            <Panel id="terminal" order={2} defaultSize={50} minSize={10}>
              <div className="side-pane">
                <div className="pane-header">
                  <span>Terminal</span>
                </div>
                <div className="pane-body">
                  <XTerm
                    ref={termRef}
                    socket={socket}
                    outputEvent="terminal:output"
                    lineMode={!termIsPty}
                    send={(data) => socket.emit('terminal:input', data)}
                    onReady={(term) => socket.emit('terminal:start', { cols: term.cols, rows: term.rows })}
                    onResize={(cols, rows) => socket.emit('terminal:resize', { cols, rows })}
                  />
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}
