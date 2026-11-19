# CodeSpace — a Replit-style online IDE

Log in, pick a tech stack (React, Next.js, Python, Node.js, HTML/CSS/JS) and get a workspace with:

| Left | Middle | Right |
| --- | --- | --- |
| File tree (create / rename / delete files & folders) | Monaco code editor with tabs, auto-save, Ctrl+S | **Preview** (for web stacks) + **Terminal** — a shell inside the project's own Docker container. **Run** types the stack's command into it, **Stop** sends Ctrl+C |

## Requirements

- Node.js 20+
- Git
- **Docker.** Every project runs in its own container. On Windows, install Docker Engine inside WSL2 (the server calls it
  as `wsl.exe --exec docker`); on Linux/macOS plain `docker` is used. Your user must be able to run `docker` without sudo.

## Run it

```bash
npm run install:all   # installs root, server and client deps
npm run dev           # API on :4000, UI on http://localhost:5173
```

On first start the server builds two runtime images (`codespace/node`, `codespace/python`) from [docker/](docker/). That
takes a few minutes once; the log shows `[docker] built …`.

## How a project is created and run

```
User creates a project
  → server clones/pulls template-repl and copies the stack's folder into  workspaces/<userId>/<projectUuid>/
  → server creates a dedicated container  codespace-<projectUuid>  from the stack's runtime image
      and bind-mounts ONLY that folder at /workspace
  → project record stores { container id, status, image, workspace path, createdAt, lastActivityAt }
User opens the workspace
  → terminal = `docker exec -it codespace-<projectUuid> bash` (sh if there is no bash)
  → Run types the stack's command into that terminal; npm / pip / node / python all execute in the container
```

Nothing a user writes is executed on the host: there is no host shell any more. The server only runs `git` (templates)
and `docker` (always with an argv array, never through a shell). If creating the container fails, the project folder and
record are rolled back and the user gets a clear error.

### Container restrictions

| | |
| --- | --- |
| User | non-root `1000:1000` |
| Privileges | `--cap-drop ALL`, `no-new-privileges`, not privileged, no Docker socket |
| Filesystem | read-only root; writable `/workspace` (the project), `/tmp` and `$HOME` (tmpfs, 512 MB) |
| Mounts | only this project's folder — no host root, no other projects |
| Limits | 1 GB RAM (no swap), 1 CPU, 512 processes, 10 MB x 2 log files |
| Network | shared bridge `codespace-projects` with **inter-container traffic disabled**; outbound internet works (npm/pip). Only the project's own preview port is published, on `127.0.0.1` |
| Commands | `POST /api/projects/:id/exec` runs under `timeout` inside the container (default 30 s, max 300 s) |
| Lifecycle | stopped 15 s after the last workspace tab closes (`CONTAINER_STOP_GRACE_SECONDS`); a 30 min idle sweep is the backstop. Reopening starts it again, files intact |

Tune with env vars below. Python packages install to `/workspace/.pythonlibs` so they survive restarts.

### Lifecycle API (owner only)

| | |
| --- | --- |
| `GET  /api/projects/:id/container` | status (`running`, `exited`, `missing`, …) |
| `POST /api/projects/:id/container/start` · `stop` · `restart` | lifecycle |
| `POST /api/projects/:id/exec` `{ command, timeoutSec }` | `{ exitCode, stdout, stderr, timedOut, truncated }` |
| `DELETE /api/projects/:id` | removes the container, then the folder, then the record |

Recovery: a crashed, stopped or deleted container is recreated/restarted transparently on the next terminal or exec call
(files are on the host, so nothing is lost). At startup the server compares its records with Docker and removes
orphaned `codespace-*` containers whose project no longer exists.

## Where things live

```
server/workspaces/<userId>/<projectUuid>/   project files (bind-mounted into the container)
server/data/db.json                         users, projects, container mapping
server/data/template-cache/                 clone of template-repl
docker/node, docker/python                  runtime Dockerfiles
```

## Architecture

```
client/  React + Vite
  pages/AuthPage       login / sign up
  pages/Dashboard      project list + "new project" stack picker
  pages/Workspace      resizable 3-pane IDE
  components/FileTree, XTerm (xterm.js over socket.io)

server/  Node + Express + socket.io
  routes/auth.js         register / login / me (bcrypt + JWT)
  routes/projects.js     project CRUD, file APIs, container lifecycle + exec APIs
  services/templates.js  template repo sync, stack manifest, run command per stack
  services/docker.js     Docker CLI wrapper (argv only) + Windows/WSL path translation
  services/containers.js per-project containers: create/start/stop/restart/remove, exec, reconcile, idle reaper
  services/workspace.js  path-safe file access (refuses symlinks that leave the workspace)
  sockets.js             terminal (node-pty → docker exec), Run/Stop, file-change events
```

## Starter templates (separate git repo)

The default files for each stack live in [template-repl](https://github.com/Subham-Coder-24/template-repl) (a folder per
stack plus a `templates.json` manifest). The server clones it into `server/data/template-cache` and, every time a user
creates a project, pulls the latest commit and copies that stack's folder into the new workspace. If git is unreachable
it uses the last cached copy.

To add a stack, add a folder and a `templates.json` entry (with `"runtime": "node"` or `"python"`) and push. Dev servers
must listen on `0.0.0.0` (not `127.0.0.1`) so the published port is reachable. See that repo's README for the fields.

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
| `DOCKER_CMD` | `wsl.exe --exec docker` on Windows, `docker` elsewhere |
| `CONTAINER_MEMORY` / `CONTAINER_CPUS` / `CONTAINER_PIDS` | `1g` / `1` / `512` |
| `CONTAINER_UID` | `1000` (must match the user in the Dockerfiles) |
| `CONTAINER_IDLE_MINUTES` | `30` |
| `EXEC_TIMEOUT_SECONDS` | `30` |
| `DOCKER_NETWORK` / `IMAGE_PREFIX` | `codespace-projects` / `codespace` |

## Known limits / before a public deployment

- Containers share the host kernel. For hostile multi-tenant use add gVisor or Kata (`--runtime=runsc`) and, if you need
  to block access to the host or cloud metadata from containers, add egress firewall rules — the bridge allows all
  outbound traffic.
- On Windows the workspace is on an NTFS drive mounted into WSL (`/mnt/c`), so `npm install` is slower and file events
  do not cross the boundary; the images enable polling for hot reload. Pointing `WORKSPACES_DIR` at a WSL path
  (`\\wsl.localhost\<distro>\…`) is faster. On a Linux server none of this applies.
- Users, projects and sessions are in a JSON file and the preview URL for static sites is unlisted rather than
  authenticated. Use a real database and add auth there before going public.
