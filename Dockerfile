# Qwixx ScoreSheet: container image, e.g. for k3s as an alternative to Streamlit Community Cloud.
#
#   docker build -t qwixx-scoresheet .
#   docker run --rm -p 8501:8501 qwixx-scoresheet
#
# Multi-arch (amd64 + arm64; every dependency ships a prebuilt wheel, so no compilers are needed):
#   docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/qwixx-scoresheet:<tag> --push .
#
# Optional game saving: set SUPABASE_URL and SUPABASE_KEY at run time (in k3s, from a Secret).
# Never bake them into the image.
#
# Python 3.12+ is required by NumPy 2.5.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/home/app \
    STREAMLIT_SERVER_HEADLESS=true \
    STREAMLIT_SERVER_ADDRESS=0.0.0.0 \
    STREAMLIT_SERVER_PORT=8501 \
    STREAMLIT_BROWSER_GATHER_USAGE_STATS=false \
    STREAMLIT_CLIENT_TOOLBAR_MODE=viewer

# A numeric UID/GID, so Kubernetes can verify `runAsNonRoot: true` from the image alone.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/app --shell /usr/sbin/nologin app

WORKDIR /app

# Dependencies first so this layer is cached until requirements.txt changes.
COPY requirements.txt .
RUN pip install -r requirements.txt

# Application code only (tests, notebooks, docs and secrets are excluded by .dockerignore).
COPY *.py ./

USER 10001:10001
EXPOSE 8501

# Streamlit's own liveness endpoint. (Kubernetes ignores HEALTHCHECK; point its probes at the same path.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8501/_stcore/health', timeout=3).read() == b'ok' else 1)"]

CMD ["streamlit", "run", "qwixx.py"]
