import { useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';

const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (parent, name) => (parent ? `${parent}/${name}` : name);

function InlineInput({ initial = '', depth, icon, onSubmit, onCancel }) {
  const done = useRef(false);
  const finish = (value) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    name && name !== initial ? onSubmit(name) : onCancel();
  };
  return (
    <div className="tree-row editing" style={{ paddingLeft: 8 + depth * 14 }}>
      {icon}
      <input
        autoFocus
        defaultValue={initial}
        onFocus={(e) => {
          const dot = initial.lastIndexOf('.');
          e.target.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(e.currentTarget.value);
          if (e.key === 'Escape') {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  );
}

export default function FileTree({ tree, activePath, onOpen, onCreate, onRename, onDelete, onRefresh }) {
  const [expanded, setExpanded] = useState(() => new Set(['src']));
  const [selectedFolder, setSelectedFolder] = useState('');
  const [editing, setEditing] = useState(null); // {kind:'create', parent, type} | {kind:'rename', path}

  const expand = (path) => setExpanded((s) => new Set(s).add(path));
  const toggle = (path) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const startCreate = (type, parent = selectedFolder) => {
    if (parent) expand(parent);
    setEditing({ kind: 'create', parent, type });
  };

  const renderCreateRow = (parent, depth) =>
    editing?.kind === 'create' && editing.parent === parent ? (
      <InlineInput
        depth={depth}
        icon={editing.type === 'folder' ? <Folder size={15} /> : <File size={15} />}
        onCancel={() => setEditing(null)}
        onSubmit={async (name) => {
          setEditing(null);
          const path = join(parent, name);
          await onCreate(path, editing.type);
          if (editing.type === 'folder') expand(path);
        }}
      />
    ) : null;

  const renderNodes = (nodes, depth, parent) => (
    <>
      {renderCreateRow(parent, depth)}
      {nodes.map((node) => {
        const isFolder = node.type === 'folder';
        const isOpen = expanded.has(node.path);

        if (editing?.kind === 'rename' && editing.path === node.path) {
          return (
            <InlineInput
              key={node.path}
              initial={node.name}
              depth={depth}
              icon={isFolder ? <Folder size={15} /> : <File size={15} />}
              onCancel={() => setEditing(null)}
              onSubmit={(name) => {
                setEditing(null);
                onRename(node.path, join(parentOf(node.path), name));
              }}
            />
          );
        }

        return (
          <div key={node.path}>
            <div
              className={`tree-row ${activePath === node.path ? 'active' : ''} ${
                isFolder && selectedFolder === node.path ? 'selected' : ''
              }`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                if (isFolder) {
                  toggle(node.path);
                  setSelectedFolder(node.path);
                } else {
                  setSelectedFolder(parentOf(node.path));
                  onOpen(node.path);
                }
              }}
            >
              {isFolder ? (
                <>
                  {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
                </>
              ) : (
                <>
                  <span style={{ width: 14 }} />
                  <File size={15} />
                </>
              )}
              <span className="ellipsis grow">{node.name}</span>
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                {isFolder && (
                  <>
                    <button title="New file" onClick={() => startCreate('file', node.path)}>
                      <FilePlus size={13} />
                    </button>
                    <button title="New folder" onClick={() => startCreate('folder', node.path)}>
                      <FolderPlus size={13} />
                    </button>
                  </>
                )}
                <button title="Rename" onClick={() => setEditing({ kind: 'rename', path: node.path })}>
                  <Pencil size={13} />
                </button>
                <button
                  title="Delete"
                  onClick={() => confirm(`Delete ${node.path}?`) && onDelete(node.path, node.type)}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            {isFolder && isOpen && renderNodes(node.children, depth + 1, node.path)}
          </div>
        );
      })}
    </>
  );

  return (
    <div className="file-tree">
      <div className="pane-header">
        <span>Files</span>
        <span className="row">
          <button className="icon-btn" title="New file" onClick={() => startCreate('file')}>
            <FilePlus size={15} />
          </button>
          <button className="icon-btn" title="New folder" onClick={() => startCreate('folder')}>
            <FolderPlus size={15} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={onRefresh}>
            <RefreshCw size={14} />
          </button>
        </span>
      </div>
      <div className="tree-body" onClick={(e) => e.target === e.currentTarget && setSelectedFolder('')}>
        {renderNodes(tree, 0, '')}
      </div>
    </div>
  );
}
