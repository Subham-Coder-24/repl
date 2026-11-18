// Starter files for every tech stack a user can pick, plus how to run each one.
import fs from 'node:fs';
import path from 'node:path';
import { PYTHON_CMD } from '../config.js';

const react = {
  id: 'react',
  label: 'React',
  description: 'React + Vite single-page app with hot reload',
  entry: 'src/App.jsx',
  files: {
    'package.json': JSON.stringify(
      {
        name: 'react-app',
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'vite build' },
        dependencies: { react: '^19.3.1', 'react-dom': '^19.3.1' },
        devDependencies: { vite: '^8.3.8', '@vitejs/plugin-react': '^6.3.0' },
      },
      null,
      2,
    ),
    'vite.config.js': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    'src/main.jsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    'src/App.jsx': `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main>
      <h1>Hello from React 👋</h1>
      <p>Edit <code>src/App.jsx</code> and save — the preview updates instantly.</p>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
    </main>
  );
}
`,
    'src/index.css': `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  display: grid;
  place-items: center;
  min-height: 100vh;
  background: #f5f7fb;
}
button {
  padding: 8px 16px;
  font-size: 1rem;
  border-radius: 6px;
  border: 1px solid #ccc;
  cursor: pointer;
}
`,
    '.gitignore': 'node_modules\ndist\n',
  },
};

const python = {
  id: 'python',
  label: 'Python',
  description: 'Python 3 script with interactive console input',
  entry: 'main.py',
  files: {
    'main.py': `def greet(name: str) -> str:
    return f"Hello, {name}! Welcome to your Python workspace."


if __name__ == "__main__":
    name = input("What's your name? ")
    print(greet(name))
`,
    'requirements.txt': '',
  },
};

const node = {
  id: 'node',
  label: 'Node.js',
  description: 'Plain Node.js script',
  entry: 'index.js',
  files: {
    'package.json': JSON.stringify(
      { name: 'node-app', version: '1.0.0', type: 'module', main: 'index.js' },
      null,
      2,
    ),
    'index.js': `const add = (a, b) => a + b;

console.log('Hello from Node.js', process.version);
console.log('2 + 3 =', add(2, 3));
`,
  },
};

const html = {
  id: 'html',
  label: 'HTML/CSS/JS',
  description: 'Static website with live preview',
  entry: 'index.html',
  files: {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Site</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <h1>Hello, web!</h1>
    <button id="btn">Click me</button>
    <script src="script.js"></script>
  </body>
</html>
`,
    'style.css': `body {
  font-family: system-ui, sans-serif;
  text-align: center;
  padding-top: 4rem;
}
`,
    'script.js': `document.getElementById('btn').addEventListener('click', () => {
  alert('It works!');
});
`,
  },
};

export const STACKS = { react, python, node, html };

export function listStacks() {
  return Object.values(STACKS).map(({ id, label, description }) => ({ id, label, description }));
}

export async function scaffoldProject(dir, stackId) {
  const stack = STACKS[stackId];
  if (!stack) throw new Error(`Unknown stack: ${stackId}`);
  for (const [rel, content] of Object.entries(stack.files)) {
    const target = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
  }
}

/**
 * What the "Run" button does for a project.
 * Returns { command } for a process to spawn, plus an optional previewUrl.
 * For static HTML no process is needed — the server serves the files directly.
 */
export function getRunConfig(project, dir) {
  switch (project.stack) {
    case 'python':
      return { command: `${PYTHON_CMD} -u main.py` };
    case 'node':
      return { command: 'node index.js' };
    case 'react': {
      const dev = `npm run dev -- --port ${project.port} --strictPort --host 127.0.0.1`;
      // Always install first: it is fast when up to date and repairs a half-finished install
      // (e.g. one interrupted by Ctrl+C). ';' (not '&&') so it also works in Windows PowerShell 5.1.
      return {
        command: `npm install; ${dev}`,
        previewUrl: `http://127.0.0.1:${project.port}/`,
      };
    }
    case 'html':
      return { command: null, previewUrl: `/preview/${project.id}/index.html` };
    default:
      return { command: null };
  }
}
