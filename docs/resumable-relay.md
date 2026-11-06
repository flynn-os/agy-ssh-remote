# Resumable stream relay

Status: prototype. It is on by default for `StreamAgentStateUpdates`. Set `AG_SSH_RELAY=0` to turn it off.

## Problem

The Mac proxy (`127.0.0.1:58282`, `src/ssh-remote.mjs`) used to forward each server-streaming RPC as one HTTP/2 stream. That stream went over the `ssh -L` tunnel to the remote `language_server`. When the tunnel died, `resetUpstreamH2()` killed every one of those streams.

Here is what the Antigravity UI does when a conversation stream ends. This is `consumeAgentStateStream` in the web bundle:

1. It catches the error and waits 1 s.
2. It resets the conversation state to empty (`z = qf(conversationId)`).
3. It opens `StreamAgentStateUpdates` again with a new `subscriberId`.
4. The LS answers the new subscription with the full trajectory snapshot as the first frame.

Numbers measured on a dev box over the `tunnel` route (Mac → jump host → reverse tunnel, RTT about 350–400 ms):

| | before | with relay |
|---|---|---|
| A medium conversation's snapshot frame | 485 KB, 0.8–2.7 s | not re-sent |
| Cost of a resume after an ssh SIGKILL | full snapshot per open conversation, and UI state reset | about 400 ms after the tunnel is back, 0 bytes re-sent |

The prior session's keepalive and hysteresis work made drops rarer. This change makes a drop cheap.

## Design

The relay follows the Codex exec-server recovery model:

| Codex (`codex-rs/exec-server`) | Here |
|---|---|
| The session registry keeps a detached session for `RECOVERY_RETENTION` | The remote bridge keeps a detached relay stream, and its LS subscription, for 180 s |
| Events carry a seq, and a bounded buffer holds recent ones | Each Connect envelope gets a seq. The buffer is capped at 16 MiB per stream |
| The client recovers with `after_seq` and the server replays the tail | The Mac attaches with `afterSeq` and gets the missed frames, then the live tail |
| The client's recovery window is shorter than the server's retention | Mac window 150 s < remote retention 180 s |
| `thread/resume` with a cursor | Same idea. The cursor is the relay seq, and the UI never sees it |

```
 Antigravity UI ──HTTP/2──▶ Mac proxy :58282 ──────────────────────────────────────────┐
   (one stream, never        │ StreamAgentStateUpdates and target=remote                 │
    broken by a tunnel drop) ▼                                                           │
                       ResumableRelayStream (src/relay-client.mjs)                       │
                         lastSeq, backoff, stall detection, dedupe                       │
                             │ POST /relay/stream {id, afterSeq, path, headers, body}    │
                             ▼                                                           │
                  ssh -L 58284 (tunnel: may die, hang, switch route)                     │
                             │                                                           │
                             ▼                                                           │
        remote bridge-daemon :58284 (remote/remote-ctl.py, detached, start_new_session)  │
          RelayStream: holds the LS subscription, seq-numbered replay buffer             │
                             │ HTTP/1.1 Connect streaming (plain-HTTP LS port 58283)     │
                             ▼                                                           │
                    remote language_server  ◀───── all other RPCs over H2 :58282 ────────┘
```

### Where the relay lives

The relay lives in the existing bridge daemon, not in a new process, because that daemon already:

- runs detached and survives disconnects;
- is forwarded over the same ssh connection (port 58284);
- is version-gated by `BRIDGE_DAEMON_VERSION`.

The relay uses only the Python stdlib. Python has no HTTP/2 client in the stdlib, but the LS's plain-HTTP port speaks the Connect protocol over HTTP/1.1 with chunked responses. Connect server-streaming works over HTTP/1.1. The UI uses the Connect transport with JSON (`application/connect+json`), so each envelope is self-delimiting and the relay never decodes messages.

### Wire protocol (bridge → Mac)

`POST /relay/stream` with JSON `{id, afterSeq, path, headers, bodyB64}`. The call does open-or-resume and is idempotent:

- **The stream `id` exists:** the call attaches, and any older writer for that stream is preempted.
- **It does not exist and `afterSeq == 0`:** the call creates the stream and opens the LS subscription.
- **It does not exist and `afterSeq > 0`:** the call returns `404 unknown-stream`.

The Mac generates the id, so a lost response never creates a second LS subscription.

The response is a sequence of records until the connection closes. Each record is `u8 type | u64 seq | u32 len | payload`:

| type | seq | payload |
|---|---|---|
| 1 META | 0 | `{streamId, status, headers, oldestSeq, lastSeq, resumed}`, the upstream response head |
| 2 FRAME | 1, 2, … | one raw Connect envelope, including its 5-byte header (end-stream envelope too) |
| 3 END | last | `{reason}`: `upstream-end`, `upstream-error`, `closed`, or `gap` (afterSeq was evicted) |
| 4 BEAT | lastSeq | heartbeat every 5 s while idle |

Other endpoints:

- `POST /relay/close?id=` releases the stream right away. The Mac calls it when the browser cancels or after END.
- `GET /relay/stats` returns debug and test info.
- `/status` now reports `relay: 1`. The Mac only relays when the bridge advertises it.

### Remote side (`RelayStream` in `remote/remote-ctl.py`)

- **Pump thread.** It reads envelopes from the LS response, appends `(seq, bytes)`, and evicts the oldest entries above the byte cap while always keeping the newest. It stops at an end-stream envelope. If the upstream errors, it appends a synthesized Connect `unavailable` end-stream envelope, so the UI re-subscribes, for example to a restarted LS.
- **Writer.** One writer runs per attach, in a handler thread. It sends META, replays frames with `seq > afterSeq`, then follows live frames, sending heartbeats while idle. Each attach bumps `attach_gen`, so the previous writer exits on its next wakeup. This makes a new attach safe while the old socket is still half-alive.
- **Janitor.** It reaps a stream after it has been detached for `RELAY_RETENTION_S`, then closes the LS subscription. At most 64 streams are kept; past that, the longest-detached stream is evicted first.

### Mac side (`ResumableRelayStream` in `src/relay-client.mjs`)

- **Headers.** The browser response head is written once, from the first META. After that the browser only ever sees envelope bytes.
- **Ordering.** Frames with `seq <= lastSeq` are dropped as duplicates; this happens during overlapping attaches. A frame with `seq > lastSeq + 1` is a gap, and the client gives up.
- **Reconnect.** When the connection ends or errors, the client retries with exponential backoff and jitter: 250 ms, doubling, capped at 5 s. While the tunnel is down (`sshState.status !== 'connected'`), it does not dial at all. It retries immediately when `ensureRemoteTunnel` reports connected again (`notifyRelayReconnected`).
- **Stall: make-before-break at the stream level.** A stall is no bytes for 20 s; heartbeats arrive every 5 s. This catches a hung ssh whose socket never closes. The client starts a parallel attach and keeps the stalled one until the new attach delivers META, then drops the old one. The bridge has already preempted the old writer by then.
- **Giving up.** The client gives up when it cannot resume within 150 s, gets `404`, or gets a `gap`. It then writes a Connect end-stream error `{"error":{"code":"unavailable"}}` and ends the browser stream. The UI then does exactly what it did before: it resets and re-subscribes. So the worst case equals today's behavior, and frames are never silently skipped.
- **Browser close.** `cancel()` drops the Mac side and calls `/relay/close`.

### Tunnel-level make-before-break (not done yet)

`ensureRemoteTunnel` still kills the old ssh before spawning the new one, because both use the fixed local ports 58283, 58284 and 58285. With the relay, that gap now costs only latency, not stream state: the client re-dials on the new tunnel and resumes.

Proposed next step:

1. Spawn the new ssh on an alternate local port set.
2. Verify `/ping` on it.
3. Swap the `sshState.local*Port` values. This is safe because `getBridge()` reads the port on every attempt.
4. Kill the old ssh.

Relay streams then migrate on their next attach, and route switches (`tunnel` → `direct`) have zero downtime. Unary RPCs and the H2 session also benefit.

## Parameters

| Where | Knob | Default |
|---|---|---|
| remote env | `AG_RELAY_RETENTION_S` | 180 |
| remote env | `AG_RELAY_MAX_BUFFER_BYTES` | 16 MiB per stream |
| remote env | `AG_RELAY_MAX_STREAMS` | 64 |
| remote env | `AG_RELAY_HEARTBEAT_S` | 5 |
| Mac env | `AG_SSH_RELAY` | on (`0` = off; streams go over H2 as before) |
| Mac env | `AG_SSH_RELAY_METHODS` | `StreamAgentStateUpdates` (comma-separated) |
| `RELAY_DEFAULTS` | recovery window, stall, attach timeout (then parallel attach, max 2), backoff | 150 s, 20 s, 30 s, 250 ms → 5 s |

The buffer is larger than Codex's 1 MiB because the first frame is the full snapshot, which can be several MB. A cut during that first frame must be replayable.

## Scope and what is next

- **Covered now:** `StreamAgentStateUpdates` (cascade / trajectory updates) for remote conversations.
- **Plain pass-through streams.** Other streams that the proxy passes through unchanged can be added with `AG_SSH_RELAY_METHODS` once checked. Candidates are `StreamTerminalOutput` and `WatchDirectory`.
- **`JetboxSubscribeToSummaries` and `ProjectUpdatesStream`** are synthesized and federated on the Mac, merging local and remote. Their remote half (`attachSummaryStreamTarget`, `ensureProjectUpstreamStream`) should move onto a `ResumableRelayStream` whose sink feeds the existing merge code instead of a browser response.
- **Limits:**
  - A bridge restart, for example on a version bump, loses relay state. Clients get `404` and fall back.
  - LS memory per stream is bounded only by the buffer cap.
  - The relay adds one HTTP/1.1 hop on the remote host's loopback.

## Testing

**Offline protocol test.** This needs no remote host and takes about 30 s:

```
node scripts/relay-chaos-test.mjs
```

It wires together a fake LS, the real `remote-ctl.py` relay, a TCP chaos proxy and the real Mac client. Scenarios:

| Scenario | What it checks |
|---|---|
| `drops` | Drops mid-snapshot and mid-stream, plus a refused-connection outage. Expects every update exactly once, in order, with one LS subscription. |
| `freeze` | A hung link; the stall path and parallel attach. |
| `longOutage` | 8 s down while frames keep coming; replay. |
| `gap` | A buffer overflow. Expects a clean `unavailable`, with no skipped frames. |
| `bridgeRestart` | `404`, then a clean `unavailable`. |
| `cancel` | The LS subscription is released. |

**Live ssh kill test.** This uses the real LS over a real route, and leaves the running setup untouched. It starts its own relay-only bridge on remote port 58294 and its own `ssh -L`:

```
node scripts/relay-ssh-kill-test.mjs [--host <ssh-alias>] [--cascade <id>] [--kills 2] [--down 8]
```

It SIGKILLs the ssh forward mid-stream, brings it back, and checks three things:

- every kill was resumed with `after_seq`;
- no second snapshot-sized frame arrived;
- the stream is still open with a single LS subscription.

Start a task in that conversation first to watch live frames get replayed across the outage (`remote_last > after_seq` in the log).

**In the real UI, after `./install.sh`:**

1. Open a remote conversation and start a longer task.
2. Kill the main tunnel mid-task:
   ```
   pkill -f 'ssh .*-L 127.0.0.1:58285'
   ```
3. Watch the relay log:
   ```
   tail -f ~/.antigravity-patch/logs/patch.log | grep relay
   ```
   Expected: `link lost at seq=N`, then the health poll reconnects (`SSH tunnel up via …`), then `resumed after_seq=N remote_last=M`.
4. The UI must keep streaming steps without the conversation blanking or reloading.
5. Live view:
   ```
   curl -sk https://127.0.0.1:58282/__ag/relay-stats
   ```
   It shows each relayed stream's `lastSeq`, `resumes` and `attaches`.
6. Compare with `AG_SSH_RELAY=0` in the LaunchAgent environment. With that set, the same kill resets and reloads the conversation.
