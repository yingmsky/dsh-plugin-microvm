# dsh-plugin-microvm

Disposable microVM sandboxes for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents.

The plugin gives a DSH agent seven tools that run commands, edit files and **fork** in Firecracker-class microVMs through any **E2B-compatible API**: E2B cloud, self-hosted E2B, or [AgentENV](https://github.com/kvcache-ai/AgentENV). Use it when the agent should try untrusted code, install packages, or explore several fixes in parallel without touching your machine.

```text
you> clone the repo, install deps, then try 3 different fixes for the failing test in parallel

agent  microvm_create        → sb_a1 (template base)
agent  microvm_exec   sb_a1  git clone … && pip install -e .        [exit 0]
agent  microvm_fork   sb_a1  count=3 → sb_b1 sb_b2 sb_b3            (memory + disk cloned)
agent  microvm_exec   sb_b1  apply fix A && pytest -x               [exit 1]
agent  microvm_exec   sb_b2  apply fix B && pytest -x               [exit 0]  ✓
…
```

No runtime dependencies, plain ESM: it installs straight from GitHub without a build step or `allowBuilds` permission.

## Install

```sh
dsh plugin --profile web add github:yingmsky/dsh-plugin-microvm
export E2B_API_KEY=e2b_...        # or set apiKey in config
dsh web
```

Pin a commit for anything you rely on: `github:yingmsky/dsh-plugin-microvm#<sha>`.

## Tools

| Tool | What it does |
|---|---|
| `microvm_create` | Start a sandbox from a template; returns `sandboxId` |
| `microvm_exec` | Run `bash -l -c <command>` and wait: exit code, stdout, stderr (head + tail kept when long), timeout kills the process |
| `microvm_read_file` | Read a text file (capped) |
| `microvm_write_file` | Write a text file, creating parent dirs |
| `microvm_fork` | Clone a running sandbox, memory and disk, into N copies |
| `microvm_destroy` | Kill a sandbox now |
| `microvm_list` | Live sandboxes in this session, with labels and fork lineage |

Every tool returns a typed canonical value (DSH `output.schema`), so in PTC mode `await tools.microvm_exec({...})` gives you `{ exitCode, stdout, stderr, timedOut, … }` directly. `microvm_exec` renders as a terminal card.

## Configure

Defaults work for E2B cloud. Override in your profile's `cordis.patch.yml`; a patch replaces the row's whole `config`, so restate every key you set:

```yaml
- id: microvm
  config:
    template: base
    sandboxTimeoutSec: 600
    maxSandboxesPerAgent: 4
```

### AgentENV (self-hosted)

```yaml
- id: microvm
  config:
    apiKey: unused                     # AgentENV has no auth yet; keep it on localhost
    apiUrl: http://127.0.0.1:8000
    envdUrl: http://127.0.0.1:8000     # adjust to how your AgentENV deployment exposes envd
    template: <your template>
```

`autoPause` is always sent explicitly (default `false`). AgentENV defaults it to `true`, unlike E2B, so without this an idle sandbox is paused rather than killed at its TTL and lingers.

| Key | Default | Notes |
|---|---|---|
| `apiKey` | `$E2B_API_KEY` | Sent as `X-API-Key` |
| `apiUrl` | `$E2B_API_URL` or `https://api.<domain>` | Control plane |
| `domain` | `e2b.app` (`$E2B_DOMAIN`) | Used when the API response names no domain |
| `envdUrl` | `https://{port}-{sandboxId}.{domain}` | envd base URL template |
| `envdPort` | `49983` | |
| `user` | `user` | Sandbox user for commands and files; empty = envd default |
| `template` | `base` | Default template for `microvm_create` |
| `sandboxTimeoutSec` | `600` | Idle TTL, refreshed on every use |
| `autoPause` | `false` | Pause instead of kill at TTL |
| `allowInternetAccess` | `true` | |
| `execTimeoutMs` / `maxExecTimeoutMs` | `120000` / `600000` | Per-command timeout and the cap the model may request |
| `maxOutputBytes` | `32768` | Per stream, head + tail |
| `maxReadBytes` | `262144` | |
| `maxSandboxesPerAgent` | `4` | Counts forks |
| `maxForkCount` | `8` | Per `microvm_fork` call (max 16) |
| `enableFork` | `true` | Hide `microvm_fork` for backends without it |
| `keepOnDispose` | `false` | Leave sandboxes running when the plugin unloads |
| `requestTimeoutMs` | `60000` | Control-plane and file calls |

## Lifecycle and safety

- **Scoped ids.** The model can only address sandboxes this plugin instance created. Any other id on the same account is rejected, even if the model guesses it.
- **No leaks.** Each sandbox has a server-side TTL refreshed on use. A sandbox is destroyed when the agent that created it is disposed (`agent/disposed`) and when the plugin unloads or hot-reloads.
- **Bounded.** Per-agent sandbox cap, fork cap, per-command timeout with a hard ceiling, output and read caps.
- **No orphan processes.** A command that times out or is cancelled is sent `SIGKILL` over envd, not just disconnected.
- **Tools, not confinement.** This adds sandbox *tools*. It doesn't move DSH's built-in `bash` / file tools into the VM, so use DSH's permission presets if the agent shouldn't also run things locally.

## How it works

Two planes, both spoken directly with `fetch` (no SDK):

- **Control plane:** `POST /v2/sandboxes`, `POST /sandboxes/{id}/fork`, `POST /sandboxes/{id}/timeout`, `DELETE /sandboxes/{id}`.
- **envd** (the in-VM agent): `process.Process/Start` as a Connect server stream (`application/connect+json`, 5-byte envelopes; base64 stdout/stderr frames; proto3 JSON omits `exitCode` when it's 0), `process.Process/SendSignal` for kills, and `GET`/`POST /files` for file I/O.

Wire details follow the E2B JS SDK and `spec/envd/*.proto` in [e2b-dev/E2B](https://github.com/e2b-dev/E2B).

## Development

```sh
npm test                                   # 21 tests against a mock E2B server whose envd really runs bash
dsh plugin --profile dev add "$PWD"         # link the checkout into a profile
node test/e2e/run.mjs dev                   # boot real DSH, drive every tool through its pipeline
```

CI runs the unit tests on Node 22 and 24, then boots a real `@deepseek-ai/dsh` with the plugin installed. A probe plugin there calls the tools through `ctx.tools.execute`, so DSH's own argument validation, output-schema validation and rendering are exercised.

## Status

v0.1, against DSH `0.2.x` (developer preview, which warns of breaking changes). Verified against the mock E2B server and the real DSH tool pipeline. Not yet run against live E2B or AgentENV: reports welcome. The envd routing of self-hosted AgentENV in particular may need a different `envdUrl`.

## License

MIT
