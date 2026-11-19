# Runtime for Node.js, React/Vite, Next.js and static-site projects.
# Built once, shared by every project; each project gets its own container from this image.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git ca-certificates curl procps less nano \
 && rm -rf /var/lib/apt/lists/*

# The container runs as UID 1000 (the base image's `node` user) with a read-only root filesystem.
# HOME and /tmp are tmpfs mounts added at `docker create` time; project files live in /workspace.
ENV HOME=/home/dev \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NEXT_TELEMETRY_DISABLED=1 \
    CHOKIDAR_USEPOLLING=true \
    WATCHPACK_POLLING=true

WORKDIR /workspace
USER 1000:1000

# Keep the container alive; the terminal attaches with `docker exec`.
CMD ["tail", "-f", "/dev/null"]
