# PRISM's private web-search backend: the official SearXNG image (pinned, never :latest) with PRISM's settings baked in.
# Runs on Railway (root directory deploy/searxng) and can be built locally with: docker build -t prism-searxng deploy/searxng
FROM searxng/searxng:2026.11.1-10db664f1
COPY settings.yml /etc/searxng/settings.yml
