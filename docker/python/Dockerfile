# Runtime for Python projects.
FROM python:3.13-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash git ca-certificates curl procps less nano \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --no-create-home --shell /bin/bash dev

# Root filesystem is read-only at runtime, so `pip install` goes to a per-project folder
# inside the workspace and survives container restarts.
ENV HOME=/home/dev \
    PYTHONUNBUFFERED=1 \
    PIP_USER=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUSERBASE=/workspace/.pythonlibs \
    PATH=/workspace/.pythonlibs/bin:$PATH

WORKDIR /workspace
USER 1000:1000

CMD ["tail", "-f", "/dev/null"]
