#!/bin/sh
# Container entrypoint. Runs as root only long enough to hand the server's
# unprivileged user a cgroup subtree and its writable directories, then drops
# every privilege and starts the server.
#
# NOT YET VERIFIED in a real container: see docs/sandbox.md.
set -eu

APP_USER="${APP_USER:-node}"
CGROUP_ROOT=/sys/fs/cgroup
RUNNER_WORK_DIR="${RUNNER_WORK_DIR:-/run/icpc}"
DATA_DIR="${ICPC_DATA_DIR:-/app/backend/data}"

if [ "${RUNNER_MODE:-nsjail}" = "nsjail" ]; then
	if [ ! -f "$CGROUP_ROOT/cgroup.controllers" ]; then
		echo "entrypoint: cgroup v2 is required for the sandbox but $CGROUP_ROOT is not cgroup v2." >&2
		echo "entrypoint: run the container with 'privileged: true' and 'cgroup: private' on a cgroup v2 host." >&2
		exit 1
	fi

	# cgroup v2 only lets a cgroup hand controllers to its children when it has
	# no processes of its own, so everything moves into a leaf first:
	#   svc/app   the server itself
	#   svc/runs  one child per sandboxed step, created by the server
	mkdir -p "$CGROUP_ROOT/svc/app" "$CGROUP_ROOT/svc/runs"

	while read -r pid; do
		echo "$pid" > "$CGROUP_ROOT/svc/app/cgroup.procs" 2>/dev/null || true
	done < "$CGROUP_ROOT/cgroup.procs"

	for dir in "$CGROUP_ROOT" "$CGROUP_ROOT/svc" "$CGROUP_ROOT/svc/runs"; do
		if ! echo "+cpu +memory +pids" > "$dir/cgroup.subtree_control"; then
			echo "entrypoint: could not enable cpu/memory/pids controllers in $dir." >&2
			exit 1
		fi
	done

	# Moving a process between svc/app and svc/runs/* needs write access to
	# cgroup.procs of their common ancestor (svc) and of both ends.
	chown "$APP_USER" \
		"$CGROUP_ROOT/svc/cgroup.procs" \
		"$CGROUP_ROOT/svc/app/cgroup.procs" \
		"$CGROUP_ROOT/svc/runs" \
		"$CGROUP_ROOT/svc/runs/cgroup.procs" \
		"$CGROUP_ROOT/svc/runs/cgroup.subtree_control"
fi

mkdir -p "$RUNNER_WORK_DIR" "$DATA_DIR/rooms"
chown "$APP_USER" "$RUNNER_WORK_DIR"
chown -R "$APP_USER" "$DATA_DIR"

exec setpriv \
	--reuid "$APP_USER" --regid "$APP_USER" --init-groups \
	--bounding-set=-all --inh-caps=-all \
	-- "$@"
