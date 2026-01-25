# Claude Sandbox (Docker harness)

This harness is a reusable isolated environment for testing Claude Code/plugins without polluting host config.

## Build

From repo root:

- `docker build -t claude-sandbox:base -f docker/sandbox/Dockerfile docker/sandbox`

## Run

- `docker run -it --rm -v "$(pwd)/workspace:/work" claude-sandbox:base`

## Notes

- This harness **does not bake credentials** into the image by default.
- If you need authenticated `claude` inside the container, prefer passing credentials at runtime (bind-mount a credentials file) rather than embedding them in the image.

