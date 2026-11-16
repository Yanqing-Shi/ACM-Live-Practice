# The sandbox

How submitted code is run, and what still has to be proven on a real host.

## Design

Each compile step and each run step is executed by [nsjail](https://github.com/google/nsjail) (tag 3.6), started by the server:

| Protection | How |
| --- | --- |
| No host files | The jail root is an empty tmpfs. Only `/usr` and a few `/etc` entries are mounted read-only, plus the run's own `ws/` (workspace) and `build/` (compiled output) directories. `/app` and the rooms data are never mounted. |
| No server secrets | The environment is cleared; only `PATH`, `HOME`, `TMPDIR`, `LANG` are set. |
| No network | New, empty network namespace; loopback stays down. |
| Time | Wall-clock timer in the server, plus `RLIMIT_CPU` and nsjail's own time limit as backstops. |
| Memory, processes | cgroup v2 `memory.max`, `memory.swap.max=0`, `pids.max` per step. |
| Output | The server stops the step when a stream exceeds the cap. |
| Disk | Run directories live on a tmpfs, so writes are charged to the memory limit; `RLIMIT_FSIZE` caps single files. |
| Kernel surface | Seccomp policy (`backend/sandbox/seccomp.kafel`) denies namespace creation, mounting, tracing, BPF, io_uring, and similar. |
| Tampering | While compiling, the workspace is read-only and `build/` is writable; while running it is the other way round. The program cannot modify its own binary, and binaries are never copied back to the room. |
| Copy-back | Files a run wrote are read back by the server outside the jail. Symlinks are never followed, and count, size, depth and encoding are capped (`scanWorkspace` in `backend/src/workspace.ts`). |

Verdicts (`time_limit`, `memory_limit`, `output_limit`, `runtime_error`) are derived from counters of a per-step cgroup the server creates itself, because nsjail removes its own cgroup on exit and does not report why a process died.

The server process runs as the unprivileged `node` user. The container entrypoint (`backend/sandbox/entrypoint.sh`) runs as root only to delegate a cgroup subtree to that user, then drops all privileges.

Code lives in `backend/src/sandbox/`: `executor.ts` (interface), `directExecutor.ts` (no isolation, for development), `nsjailExecutor.ts`, `languages.ts`, `limits.ts`, `runQueue.ts`.

## What is and is not verified

Verified by unit tests: argument construction, verdict classification, cgroup stat parsing, limit parsing, the run queue, copy-back rules, and the runner's behaviour for each verdict (with a fake executor).

Verified against nsjail's source: every command-line flag and configuration field used exists in nsjail 3.6.

**Not verified: anything that needs nsjail actually running.** In particular:

1. nsjail 3.6 builds in the Dockerfile's build stage.
2. The unprivileged server can start nsjail after the entrypoint's cgroup delegation. If not, the fallback is to run the server as root inside the container (weaker, but the jail is the same).
3. The per-step parent cgroup still reports `memory.events`, `memory.peak` and `cpu.stat` after nsjail removes its child cgroup. If not, verdicts degrade to "runtime error", and `isolate` (which writes verdicts to a meta file) is the alternative.
4. `g++`, CPython and the JVM run under the seccomp policy and the mount list, and the JVM fits in 64 processes.
5. The Kafel policy file parses.

## Checklist for a new host

```sh
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec app \
  node --test dist/sandbox/sandbox.integration.test.js
```

The suite runs real hostile programs and must pass completely:

| Program | Expected |
| --- | --- |
| Normal C++, Python, Java | Runs; CPU time and memory are reported |
| Fork bomb | Time limit; another room's run still completes; no cgroup left behind |
| Allocate 1 GB | Memory limit |
| Endless output | Output limit, cut at 64 KiB |
| Busy loop; `sleep(100)` | Time limit |
| Connect to 1.1.1.1 | Fails |
| Read rooms data, server code, `/etc/shadow`, `/proc/1/environ` | Not found; environment shows only the jail's variables |
| Symlink to rooms data left in the workspace | Not copied back |
| Write a 2 GB file | Stops near 16 MiB; not copied back |
| Overwrite `/build/program` or `/usr/bin` | Refused |
| `unshare(CLONE_NEWUSER)` | Refused; `NoNewPrivs: 1`, `Seccomp: 2`, no capabilities |
| `#include "/dev/zero"` | Compile error |
| 200 KB of input the program never reads | Normal result |

If a test fails, the log nsjail wrote for that step is included in the run's error output (`[Run system error]`).

## Residual risk

The jail shares the host kernel. A kernel vulnerability reachable through the allowed system calls could escape it, and the privileged container offers no second barrier. Time-limit verdicts on shared CPUs are approximate, not contest-grade.
