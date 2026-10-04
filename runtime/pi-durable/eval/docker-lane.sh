#!/usr/bin/env bash
#
# Disposable-container restart lane: F11 (service crash with a valid generation)
# and F17 (host reboot -> store reopen + authority reconciliation).
#
# The failure boundary is owned here, outside the container. This script starts
# a container that prepares one settled operation, kills it with SIGKILL, then
# starts a second container on the same home to prove the store reopens and the
# recorded authority reconciles instead of resetting.
#
# `--pid=host` is required: the runtime ownership lock records a pid and treats
# a live pid as a live owner, and pids are namespace-relative. Sharing the host
# pid namespace is what makes the recorded owner genuinely dead after the kill.
#
# Usage: eval/docker-lane.sh [output.json]
# Exit status is 0 when both cases pass or when the lane is honestly not-covered
# (no Docker daemon or image), and 1 when a case fails.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$RUNTIME_DIR/../.." && pwd)"
OUT="${1:-}"
IMAGE="${FM_DOCKER_LANE_IMAGE:-fm-pi-durable-lane:local}"
ENTRY="eval/docker-lane-container.ts"
OUTCOME_SCRIPT="/repo/bin/fm-branch-outcome.sh"
READY_TIMEOUT_SECONDS="${FM_DOCKER_LANE_TIMEOUT:-120}"

workdir="$(mktemp -d)"
home="$workdir/home"
mkdir -p "$home"
name="fm-pi-durable-lane-$$"
killed=false
serve_state=""
verify_result=""
covered=true
reason=""

cleanup() {
  docker kill "$name" >/dev/null 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

emit_not_covered() {
  local why="$1"
  node -e '
    const [reason, image, dockerVersion] = process.argv.slice(1);
    process.stdout.write(`${JSON.stringify({
      status: "not-covered",
      reason,
      image,
      dockerServer: dockerVersion || null,
      commands: [],
    }, null, 2)}\n`);
  ' "$why" "$IMAGE" "${docker_server:-}"
}

if ! command -v docker >/dev/null 2>&1; then
  emit_not_covered "no docker client is installed in this environment"
  exit 0
fi
docker_server="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
if [ -z "$docker_server" ]; then
  emit_not_covered "the docker daemon is not reachable"
  exit 0
fi
build_command=""
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  build_cmd=(docker build -t "$IMAGE" -f "$SCRIPT_DIR/docker-lane.Dockerfile" "$SCRIPT_DIR")
  build_command="${build_cmd[*]}"
  if ! timeout 900 "${build_cmd[@]}" >/dev/null 2>&1; then
    emit_not_covered "the container image $IMAGE could not be built"
    exit 0
  fi
fi

run_args=(
  --rm
  --pid=host
  --user "$(id -u):$(id -g)"
  -e FM_HOME=/home
  -v "$REPO_DIR:/repo:ro"
  -v "$home:/home"
  -w "/repo/runtime/pi-durable"
)

serve_cmd=(docker run -d --name "$name" "${run_args[@]}" "$IMAGE" node "$ENTRY" serve /home "$OUTCOME_SCRIPT")
verify_cmd=(docker run "${run_args[@]}" "$IMAGE" node "$ENTRY" verify /home "$OUTCOME_SCRIPT")

serve_id="$("${serve_cmd[@]}" 2>&1)" || {
  emit_not_covered "the container could not start: ${serve_id}"
  exit 0
}

deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  logs="$(docker logs "$name" 2>&1 || true)"
  serve_state="$(printf '%s\n' "$logs" | sed -n 's/^SERVE_STATE //p' | tail -1)"
  if [ -n "$serve_state" ] && printf '%s\n' "$logs" | grep -q '^SERVE_READY$'; then
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
    break
  fi
  sleep 1
done

if [ -z "$serve_state" ]; then
  node -e '
    const [image, dockerVersion, logs, serveCommand] = process.argv.slice(1);
    process.stdout.write(`${JSON.stringify({
      status: "fail",
      reason: "the prepare container never reported its state",
      image,
      dockerServer: dockerVersion,
      logs: logs.slice(-2000),
      commands: [serveCommand],
    }, null, 2)}\n`);
  ' "$IMAGE" "$docker_server" "$(docker logs "$name" 2>&1 | tail -20)" "${serve_cmd[*]}"
  exit 1
fi

# The failure boundary: SIGKILL the container that holds a valid generation.
if docker kill "$name" >/dev/null 2>&1; then
  killed=true
fi
docker wait "$name" >/dev/null 2>&1 || true

verify_output="$("${verify_cmd[@]}" 2>&1)"
verify_result="$(printf '%s\n' "$verify_output" | sed -n 's/^VERIFY_RESULT //p' | tail -1)"

if [ -z "$verify_result" ]; then
  node -e '
    const [image, dockerVersion, output, serveCommand, verifyCommand] = process.argv.slice(1);
    process.stdout.write(`${JSON.stringify({
      status: "fail",
      reason: "the reopen container never reported its verdict",
      image,
      dockerServer: dockerVersion,
      output: output.slice(-2000),
      commands: [serveCommand, verifyCommand],
    }, null, 2)}\n`);
  ' "$IMAGE" "$docker_server" "$verify_output" "${serve_cmd[*]}" "${verify_cmd[*]}"
  exit 1
fi

SERVE_STATE="$serve_state" \
VERIFY_RESULT="$verify_result" \
DOCKER_SERVER="$docker_server" \
IMAGE="$IMAGE" \
KILLED="$killed" \
BUILD_COMMAND="$build_command" \
SERVE_COMMAND="${serve_cmd[*]}" \
VERIFY_COMMAND="${verify_cmd[*]}" \
WORKDIR="$workdir" \
CONTAINER_NAME="$name" \
OUT="$OUT" \
node -e '
  const serve = JSON.parse(process.env.SERVE_STATE);
  const verify = JSON.parse(process.env.VERIFY_RESULT);
  // Keep the recorded commands reproducible: the per-run temp home and
  // container name are placeholders, not evidence.
  const sanitize = (command) =>
    command
      .split(process.env.WORKDIR)
      .join("<workdir>")
      .split(process.env.CONTAINER_NAME)
      .join("<lane>");
  const f11 = serve.generation === 1 && typeof serve.seq === "number" && process.env.KILLED === "true";
  const f17 =
    verify.storePath !== null &&
    verify.created === false &&
    verify.conversationId === serve.conversationId &&
    verify.generation === serve.generation &&
    verify.staleCode === "AUTHORITY_STALE" &&
    verify.operationState === "settled" &&
    verify.receiptSeq === serve.seq &&
    verify.outcomeRows === 1;
  const document = {
    status: f11 && f17 ? "pass" : "fail",
    image: process.env.IMAGE,
    dockerServer: process.env.DOCKER_SERVER,
    commands: [
      process.env.BUILD_COMMAND,
      process.env.SERVE_COMMAND,
      process.env.VERIFY_COMMAND,
    ]
      .filter(Boolean)
      .map(sanitize),
    f11: {
      status: f11 ? "pass" : "fail",
      case: "service crash with a valid generation",
      evidence: {
        generation: serve.generation,
        killed: process.env.KILLED === "true",
        nodeInContainer: serve.node,
        pid: serve.pid,
      },
    },
    f17: {
      status: f17 ? "pass" : "fail",
      case: "host reboot -> store reopen + authority reconciliation",
      evidence: {
        storeReopened: verify.storePath !== null,
        authorityReconciled: verify.created === false,
        sameConversation: verify.conversationId === serve.conversationId,
        sameGeneration: verify.generation === serve.generation,
        staleGeneration: verify.staleCode,
        operationState: verify.operationState,
        receiptSeq: verify.receiptSeq,
        expectedReceiptSeq: serve.seq,
        outcomeRows: verify.outcomeRows,
        nodeInContainer: verify.node,
      },
    },
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (process.env.OUT) require("node:fs").writeFileSync(process.env.OUT, text);
  process.stdout.write(text);
  process.exitCode = document.status === "pass" ? 0 : 1;
'
