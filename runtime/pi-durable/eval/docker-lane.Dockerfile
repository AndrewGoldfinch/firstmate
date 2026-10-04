# Disposable-container restart lane image.
#
# `node:22` provides the runtime and its type stripping; `jq` is required because
# the outcome store validates every row with jq before it will read or append.
FROM node:22
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq \
 && rm -rf /var/lib/apt/lists/*
