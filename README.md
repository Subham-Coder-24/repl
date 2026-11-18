# CodeSpace — a Replit-style online IDE

Log in, pick a tech stack (React, Python, Node.js, HTML/CSS/JS) and get a workspace with:

| Left | Middle | Right |
| --- | --- | --- |
| File tree (create / rename / delete files & folders) | Monaco code editor with tabs, auto-save, Ctrl+S | **Output / Preview** (Run button, program stdin, live preview) + **Terminal** (real shell in the project folder) |

## Run it

```bash
npm run install:all   # installs root, server and client deps
npm run dev           # API on :4000, UI on http://localhost:5173
```

## Where projects live

Each project is a real folder on the server:

```
server/workspaces/<userId>/<projectId>/
```

Change the location with the `WORKSPACES_DIR` env var. Users and project metadata are stored in `server/data/db.json`.

## Architecture

```
client/  React + Vite
  pages/AuthPage       login / sign up
  pages/Dashboard      project list + "new project" stack picker
  pages/Workspace      resizable 3-pane IDE
  components/FileTree, XTerm (xterm.js over socket.io)

server/  Node + Express + socket.io
  routes/auth.js       register / login / me (bcrypt + JWT)
  routes/projects.js   project CRUD + file APIs (tree, read, write, create, rename, delete)
  services/templates.js  starter files + run command per stack
  services/runner.js   Run/Stop process management (kills the whole process tree)
  sockets.js           terminal (node-pty), run output/stdin, file-change events
```

## Starter templates (separate git repo)

The default files for each stack live in a separate repo,
[template-repl](https://github.com/Subham-Coder-24/template-repl) (`react/`, `python/`, `node/`, `html/` and a
`templates.json` manifest). The server clones it into `server/data/template-cache` and, every time a user creates
a project, pulls the latest commit and copies that stack's folder into the new workspace. If git is unreachable it
uses the last cached copy.

To add a stack, add a folder and an entry in `templates.json` in that repo and push. No code change is needed here.
See that repo's README for the manifest fields.

**Run** types the stack's `run` command into the terminal and **Stop** sends Ctrl+C. Preview is shown for stacks
with a `preview` setting (`port` = dev server iframe, `static` = files served by the API).

## Env vars (server)

| Var | Default |
| --- | --- |
| `PORT` | `4000` |
| `JWT_SECRET` | `dev-secret-change-me` — **change in production** |
| `WORKSPACES_DIR` | `server/workspaces` |
| `CLIENT_ORIGIN` | `http://localhost:5173` |
| `PYTHON_CMD` | `python` (Windows) / `python3` |
| `PREVIEW_PORT_START` | `5300` |
| `TEMPLATE_REPO_URL` | `https://github.com/Subham-Coder-24/template-repl.git` (a local path also works) |
| `TEMPLATE_REPO_BRANCH` | `main` |

## Before exposing this beyond your own machine

User code and the terminal run **directly on the host** with the server's permissions. That's fine for local
development, but for a multi-user deployment run each workspace in an isolated container (Docker / Firecracker),
with CPU/memory limits and no access to other users' folders.
