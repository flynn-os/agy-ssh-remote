#!/usr/bin/env python3
"""
Remote Antigravity Language Server & Bridge Manager (runs on the remote Linux dev machine).
Manages:
  1. Official Linux language_server binary provisioning (~/.antigravity-server/bin/<version>/language_server)
  2. Embedded web bundle extraction & compatibility patching (web_bundle_patched.zip)
     - Hides window.dialog on remote windows -> enables built-in Interactive Remote Folder Picker (yJc)
     - Hooks window.wsl -> window.__agWsl
     - Hooks window.extensions -> window.__agExtensions (Sidecar dynamic port forwarding)
     - Sets window.process.platform = "linux" and window.languageServer overrides
  3. OAuth token sync (~/.gemini/jetski-standalone-oauth-token)
  4. Persistent daemon lifecycle (~/.antigravity-server/run/server.json) shared across the direct and tunnel routes
  5. Lightweight loopback bridge HTTP server (127.0.0.1:58284) forwarded over the same SSH tunnel for
     zero-overhead status checks, real-time tunnel RTT measurement, OAuth URL polling, and SQLite telemetry.
  6. Resumable stream relay (/relay/*): holds LS server-streaming subscriptions on this host with a
     seq-numbered replay buffer so the Mac can resume them after a tunnel drop (docs/resumable-relay.md).
"""

import base64
import http.server
import io
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

WEB_BUNDLE_PATCH_VERSION = "20261106-ssh-v11"
BRIDGE_DAEMON_VERSION = "20261107-ssh-v14"
DEFAULT_HTTPS_PORT = 58282
DEFAULT_HTTP_PORT = 58283
DEFAULT_BRIDGE_PORT = 58284


def _child_env():
    """Environment for long-lived children (bridge, LS) without the one-shot auth payload."""
    env = dict(os.environ)
    env.pop("AG_AUTH_PAYLOAD_B64", None)
    return env


def load_user_env():
    home = os.path.expanduser("~")
    env = _child_env()
    env["HOME"] = home

    for rc in [".profile", ".bashrc"]:
        rc_path = os.path.join(home, rc)
        if os.path.isfile(rc_path):
            try:
                with open(rc_path, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                m_v2 = re.search(r'V2RAY_PROXY=["\']?([^"\'\s]+)["\']?', content)
                v2_proxy = m_v2.group(1) if m_v2 else None
                if v2_proxy:
                    for k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
                        env.setdefault(k, v2_proxy)
                m_no = re.search(r'export\s+NO_PROXY=["\']?([^"\'\n]+)["\']?', content)
                if m_no:
                    env.setdefault("NO_PROXY", m_no.group(1))
                    env.setdefault("no_proxy", m_no.group(1))
            except Exception:
                pass

    if env.get("HTTP_PROXY") or env.get("http_proxy"):
        env.pop("ALL_PROXY", None)
        env.pop("all_proxy", None)

    extra_paths = [
        os.path.join(home, ".local/bin"),
        os.path.join(home, ".local/share/uv/venv/bin"),
        os.path.join(home, ".cargo/bin"),
        os.path.join(home, "go/bin"),
        "/usr/local/go/bin",
        "/usr/local/bin",
    ]
    node_base = os.path.join(home, ".local/share/nodejs")
    if os.path.isdir(node_base):
        try:
            for d in sorted(os.listdir(node_base), reverse=True):
                nb = os.path.join(node_base, d, "bin")
                if os.path.isdir(nb):
                    extra_paths.insert(1, nb)
        except Exception:
            pass

    current_path = env.get("PATH", "/usr/bin:/bin")
    path_parts = current_path.split(":")
    for p in reversed(extra_paths):
        if os.path.isdir(p) and p not in path_parts:
            path_parts.insert(0, p)
    env["PATH"] = ":".join(path_parts)
    env["ANTIGRAVITY_VSCODE_HOST"] = "1"
    return env


def decode_auth_payload(raw_b64=None):
    if raw_b64 is None:
        raw_b64 = os.environ.get("AG_AUTH_PAYLOAD_B64", "")
    if isinstance(raw_b64, dict):
        return raw_b64
    if not raw_b64 or not isinstance(raw_b64, str):
        return {}
    try:
        padded = raw_b64.strip()
        missing_padding = len(padded) % 4
        if missing_padding:
            padded += "=" * (4 - missing_padding)
        decoded = base64.b64decode(padded, validate=False).decode("utf-8", errors="ignore")
        obj = json.loads(decoded)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def ensure_auth_token():
    home = os.path.expanduser("~")
    gemini_dir = os.path.join(home, ".gemini")
    os.makedirs(gemini_dir, exist_ok=True)
    standalone_token = os.path.join(gemini_dir, "jetski-standalone-oauth-token")
    cli_token = os.path.join(gemini_dir, "antigravity-cli", "antigravity-oauth-token")
    app_token = os.path.join(gemini_dir, "antigravity", "antigravity-oauth-token")

    if not os.path.isfile(standalone_token) or os.path.getsize(standalone_token) == 0:
        for candidate in [cli_token, app_token]:
            if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                shutil.copy2(candidate, standalone_token)
                os.chmod(standalone_token, 0o600)
                break

    if not os.path.isfile(standalone_token) or os.path.getsize(standalone_token) == 0:
        payload = decode_auth_payload()
        tok_b64 = payload.get("standaloneTokenB64") or payload.get("oauthTokenB64") or ""
        if isinstance(tok_b64, str) and tok_b64.strip():
            try:
                raw_bytes = base64.b64decode(tok_b64.strip(), validate=False)
                if raw_bytes:
                    tmp_tok = standalone_token + f".tmp.{os.getpid()}"
                    with open(tmp_tok, "wb") as f:
                        f.write(raw_bytes)
                    os.chmod(tmp_tok, 0o600)
                    os.replace(tmp_tok, standalone_token)
            except Exception:
                pass

    return os.path.isfile(standalone_token) and os.path.getsize(standalone_token) > 0


def resolve_execution_id_for_version(version, env):
    rel_url = "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/releases"
    try:
        proc = subprocess.run(
            ["curl", "-fsSL", "--connect-timeout", "8", "--max-time", "15", rel_url],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        releases = json.loads(proc.stdout)
        found = next((r for r in releases if r.get("version") == version), None)
        if found and found.get("execution_id"):
            return str(found["execution_id"])
    except Exception:
        pass
    req = urllib.request.Request(rel_url, headers={"User-Agent": f"Antigravity/{version}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        releases = json.loads(resp.read().decode("utf-8"))
    found = next((r for r in releases if r.get("version") == version), None)
    if not found or not found.get("execution_id"):
        raise RuntimeError(f"Release {version} not found in manifest")
    return str(found["execution_id"])


def find_latest_installed_binary(bin_root):
    if not os.path.isdir(bin_root):
        return None
    try:
        for d in sorted(os.listdir(bin_root), reverse=True):
            cand = os.path.join(bin_root, d, "language_server")
            if os.path.isfile(cand) and os.access(cand, os.X_OK) and os.path.getsize(cand) > 50_000_000:
                return cand
    except Exception:
        pass
    return None


def ensure_binary(version, execution_id, env):
    if not version or not re.match(r"^\d+\.\d+\.\d+$", str(version)):
        version = "2.28.2"
    if not execution_id or (execution_id != "auto" and not re.match(r"^\d+$", str(execution_id))):
        execution_id = "5937220255875072" if version == "2.28.2" else "auto"
    home = os.path.expanduser("~")
    bin_root = os.path.join(home, ".antigravity-server", "bin")
    bin_dir = os.path.join(bin_root, version)
    os.makedirs(bin_dir, exist_ok=True)
    bin_path = os.path.join(bin_dir, "language_server")

    if os.path.isfile(bin_path) and os.access(bin_path, os.X_OK) and os.path.getsize(bin_path) > 50_000_000:
        return bin_path

    machine = os.uname().machine.lower()
    arch = "arm64" if machine in ("aarch64", "arm64") else "x64"

    tmp_path = os.path.join(bin_dir, f".language_server.tmp.{os.getpid()}")
    try:
        if not execution_id or execution_id == "auto":
            execution_id = resolve_execution_id_for_version(version, env)
        url = f"https://storage.googleapis.com/antigravity-public/antigravity-hub/{version}-{execution_id}/unsigned/language_server-linux-{arch}"
        subprocess.run(
            ["curl", "-fSL", "--connect-timeout", "10", "--retry", "2", "-o", tmp_path, url],
            env=env,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        os.chmod(tmp_path, 0o755)
        os.replace(tmp_path, bin_path)
        return bin_path
    except Exception:
        fallback = find_latest_installed_binary(bin_root)
        if fallback:
            return fallback
        raise
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass


def ensure_patched_web_bundle(bin_path):
    bin_dir = os.path.dirname(bin_path)
    out_zip = os.path.join(bin_dir, "web_bundle_patched.zip")
    ver_file = os.path.join(bin_dir, "web_bundle_patched.version")

    if os.path.isfile(out_zip) and os.path.isfile(ver_file):
        try:
            with open(ver_file, "r", encoding="utf-8") as f:
                if f.read().strip() == WEB_BUNDLE_PATCH_VERSION and os.path.getsize(out_zip) > 1_000_000:
                    return out_zip
        except Exception:
            pass

    with open(bin_path, "rb") as f:
        data = f.read()

    idx = data.find(b"compiled_tailwind.css")
    if idx < 0:
        raise RuntimeError("Could not locate embedded web bundle in language_server binary")
    idx_cd = data.find(b"PK\x01\x02", idx)
    idx_eocd = data.find(b"PK\x05\x06", idx_cd)
    cd_size, cd_offset, comment_len = struct.unpack("<IIH", data[idx_eocd + 12 : idx_eocd + 22])
    zip_start = idx_cd - cd_offset
    zip_end = idx_eocd + 22 + comment_len

    src_zf = zipfile.ZipFile(io.BytesIO(data[zip_start:zip_end]), "r")
    buf = io.BytesIO()

    inject_head = """<script>
window.__ag_is_ssh_remote = true;
window.process = window.process || {};
window.process.env = window.process.env || {};
window.process.platform = "linux";
try {
  Object.defineProperty(window, "dialog", { get: () => undefined, configurable: true });
} catch (e) {}
window.__agExtensions = {
  sendAuthorities(map) {
    window.__ag_last_authorities = map;
    if (typeof window.__agSyncSidecarAuthorities === "function") {
      try { window.__agSyncSidecarAuthorities(JSON.stringify(map || {})); } catch (e) {}
    }
    return window.extensions?.sendAuthorities?.(map);
  }
};
window.languageServer = {
  getCsrfToken: async () => window.__APP_CONFIG__?.csrfToken || "",
  getHttpPort: async () => Number(window.__ag_ssh_state?.remoteHttpPort || location.port),
  getHttpsPort: async () => Number(location.port),
  restartAndConnect: async () => {
    if (typeof window.__agSshAction === "function") {
      try { await window.__agSshAction(JSON.stringify({ action: "restart" })); } catch (e) {}
    }
    location.reload();
  }
};
</script>"""

    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as dst_zf:
        for item in src_zf.infolist():
            content = src_zf.read(item.filename)
            if item.filename == "index.html":
                text = content.decode("utf-8")
                text = text.replace("<head>", "<head>\n" + inject_head, 1)
                content = text.encode("utf-8")
            elif item.filename == "main.js":
                text = content.decode("utf-8")
                text = (
                    "window.__ag_is_ssh_remote=true;"
                    + text.replace("window.dialog", "(window.__ag_is_ssh_remote?void 0:window.dialog)")
                    .replace("window.nativeStorage", "(window.__ag_is_ssh_remote?void 0:window.nativeStorage)")
                    .replace("window.wsl", "(window.__agWsl||window.wsl)")
                    .replace("window.extensions", "(window.__agExtensions||window.extensions)")
                )
                marker = ".CortexTrajectorySource.JETBOX"
                m_idx = text.find(marker)
                if m_idx > 20:
                    prefix_window = text[max(0, m_idx - 24) : m_idx + len(marker)]
                    m_src = re.search(r"([\w$]+)\s*===\s*([\w$]+\.CortexTrajectorySource)\.JETBOX$", prefix_window)
                    if m_src:
                        var_a, enum_obj = m_src.group(1), m_src.group(2)
                        orig_expr = m_src.group(0)
                        new_expr = f"({var_a}==={enum_obj}.JETBOX||{var_a}==={enum_obj}.CLI||{var_a}==={enum_obj}.AGENT_API||{var_a}==={enum_obj}.SDK)"
                        text = text[: m_idx + len(marker) - len(orig_expr)] + new_expr + text[m_idx + len(marker) :]
                content = text.encode("utf-8")
            dst_zf.writestr(item, content)

    tmp_zip = out_zip + f".tmp.{os.getpid()}"
    with open(tmp_zip, "wb") as f:
        f.write(buf.getvalue())
    os.replace(tmp_zip, out_zip)
    with open(ver_file, "w", encoding="utf-8") as f:
        f.write(WEB_BUNDLE_PATCH_VERSION + "\n")
    return out_zip


def is_pid_alive(pid, match_substr):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().decode("utf-8", errors="ignore")
        return match_substr in cmd
    except Exception:
        return False


def is_pid_alive_ls(pid):
    return is_pid_alive(pid, "language_server") and is_pid_alive(pid, "web_bundle_patched.zip")


_LAST_HTTPS_OK = {"pid": 0, "port": 0, "csrf": "", "ts": 0.0}


def check_https_alive(port, csrf_token=None, timeout=4.0):
    if not isinstance(port, int) or port <= 0:
        return False
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        req = urllib.request.Request(f"https://127.0.0.1:{port}/")
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            if resp.status != 200:
                return False
            body = resp.read(2048).decode("utf-8", errors="ignore")
            if "__ag_is_ssh_remote" not in body:
                return False
            if csrf_token and csrf_token not in body:
                return False
            return True
    except Exception:
        return False


def check_bridge_alive(port):
    if not isinstance(port, int) or port <= 0:
        return False
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/ping")
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        return False


def is_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port(preferred):
    for p in range(preferred, preferred + 40):
        if is_port_free(p):
            return p
    return 0


def kill_existing_ls(run_dir):
    killed_pids = set()
    state_file = os.path.join(run_dir, "server.json")
    if os.path.isfile(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                st = json.load(f)
            pid = st.get("pid")
            if isinstance(pid, int) and pid > 0:
                try:
                    os.kill(pid, signal.SIGTERM)
                    killed_pids.add(pid)
                except Exception:
                    pass
        except Exception:
            pass
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == os.getpid():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read().decode("utf-8", errors="ignore")
                if ".antigravity-server/bin/" in cmd and "language_server" in cmd:
                    os.kill(pid, signal.SIGTERM)
                    killed_pids.add(pid)
            except Exception:
                pass
    except Exception:
        pass

    deadline = time.time() + 1.5
    while killed_pids and time.time() < deadline:
        alive = set()
        for pid in killed_pids:
            try:
                os.kill(pid, 0)
                alive.add(pid)
            except Exception:
                pass
        if not alive:
            break
        time.sleep(0.08)

    for pid in killed_pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    if killed_pids:
        time.sleep(0.1)


def extract_open_urls(log_path):
    urls = []
    if not os.path.isfile(log_path):
        return urls
    try:
        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                m = re.search(r"ANTIGRAVITY_OPEN_URL:\s*(\S+)", line)
                if m:
                    urls.append(m.group(1))
    except Exception:
        pass
    return urls


def ensure_bridge_daemon(run_dir, preferred_port=DEFAULT_BRIDGE_PORT):
    state_file = os.path.join(run_dir, "bridge.json")
    if os.path.isfile(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                st = json.load(f)
            b_pid = st.get("pid")
            b_port = st.get("port")
            b_ver = st.get("version")
            if b_ver == BRIDGE_DAEMON_VERSION and is_pid_alive(b_pid, "bridge-daemon"):
                if b_pid == os.getpid() or check_bridge_alive(b_port):
                    return b_port
        except Exception:
            pass

    # Kill any stale bridge-daemon
    killed_pids = set()
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            if pid == os.getpid():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    cmd = f.read().decode("utf-8", errors="ignore")
                if "bridge-daemon" in cmd and ("remote-ctl.py" in cmd or "ag-remote-ctl.py" in cmd):
                    os.kill(pid, signal.SIGTERM)
                    killed_pids.add(pid)
            except Exception:
                pass
    except Exception:
        pass

    deadline = time.time() + 1.0
    while killed_pids and time.time() < deadline:
        alive = set()
        for pid in killed_pids:
            try:
                os.kill(pid, 0)
                alive.add(pid)
            except Exception:
                pass
        if not alive and is_port_free(preferred_port):
            break
        time.sleep(0.06)

    for pid in killed_pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    if killed_pids:
        time.sleep(0.08)

    port = pick_port(preferred_port)
    script_path = os.path.abspath(__file__)
    if not os.path.isfile(script_path) or script_path.endswith("<stdin>"):
        script_path = os.path.expanduser("~/.antigravity-server/bin/ag-remote-ctl.py")
    log_path = os.path.join(run_dir, "bridge.log")
    log_fd = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, script_path, "bridge-daemon", str(port)],
        stdin=subprocess.DEVNULL,
        stdout=log_fd,
        stderr=subprocess.STDOUT,
        env=_child_env(),
        start_new_session=True,
        close_fds=True,
    )
    log_fd.close()

    deadline = time.time() + 5.0
    while time.time() < deadline:
        if check_bridge_alive(port):
            break
        time.sleep(0.1)

    with open(state_file, "w", encoding="utf-8") as f:
        json.dump({"pid": proc.pid, "port": port, "version": BRIDGE_DAEMON_VERSION}, f)
    return port


def get_status_dict():
    home = os.path.expanduser("~")
    run_dir = os.path.join(home, ".antigravity-server", "run")
    state_file = os.path.join(run_dir, "server.json")
    log_path = os.path.join(run_dir, "server.log")
    st = {}
    if os.path.isfile(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                st = json.load(f)
        except Exception:
            st = {}
    pid = st.get("pid")
    https_port = st.get("httpsPort")
    csrf = st.get("csrfToken")
    pid_ok = is_pid_alive_ls(pid)
    now = time.time()
    if (
        pid_ok
        and _LAST_HTTPS_OK["pid"] == pid
        and _LAST_HTTPS_OK["port"] == https_port
        and _LAST_HTTPS_OK["csrf"] == (csrf or "")
        and (now - _LAST_HTTPS_OK["ts"]) < 20.0
    ):
        alive = True
    else:
        alive = pid_ok and check_https_alive(https_port, csrf, timeout=4.0)
        if alive:
            _LAST_HTTPS_OK.update({"pid": pid, "port": https_port, "csrf": csrf or "", "ts": now})
    return {
        "ok": True,
        "running": alive,
        "bridgeVersion": BRIDGE_DAEMON_VERSION,
        "relay": RELAY_PROTOCOL_VERSION,
        "hostname": socket.gethostname(),
        "arch": os.uname().machine,
        "homeDir": home,
        "hasAuth": ensure_auth_token(),
        **st,
        "openUrls": extract_open_urls(log_path),
    }


def ensure_server(version, execution_id, force_restart=False):
    sanitize_git_worktree_configs()
    sync_cli_store()
    env = load_user_env()
    has_auth = ensure_auth_token()
    home = os.path.expanduser("~")
    run_dir = os.path.join(home, ".antigravity-server", "run")
    os.makedirs(run_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(run_dir, 0o700)  # holds server.json (CSRF token) and logs
    except OSError:
        pass
    state_file = os.path.join(run_dir, "server.json")
    log_path = os.path.join(run_dir, "server.log")

    bin_path = ensure_binary(version, execution_id, env)
    zip_path = ensure_patched_web_bundle(bin_path)
    bridge_port = ensure_bridge_daemon(run_dir, DEFAULT_BRIDGE_PORT)

    prev_state = {}
    if os.path.isfile(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                prev_state = json.load(f)
        except Exception:
            prev_state = {}

    if not force_restart and prev_state:
        pid = prev_state.get("pid")
        https_port = prev_state.get("httpsPort")
        http_port = prev_state.get("httpPort")
        csrf_token = prev_state.get("csrfToken")
        if (
            prev_state.get("version") == version
            and prev_state.get("webBundleVersion") == WEB_BUNDLE_PATCH_VERSION
            and is_pid_alive_ls(pid)
            and check_https_alive(https_port, csrf_token)
        ):
            if prev_state.get("bridgePort") != bridge_port:
                prev_state["bridgePort"] = bridge_port
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump(prev_state, f, indent=2)
            return {
                "ok": True,
                "reused": True,
                "hostname": socket.gethostname(),
                "arch": os.uname().machine,
                "homeDir": home,
                "hasAuth": has_auth,
                "pid": pid,
                "version": version,
                "httpsPort": https_port,
                "httpPort": http_port,
                "bridgePort": bridge_port,
                "csrfToken": csrf_token,
                "openUrls": extract_open_urls(log_path),
            }

    # Per-install random token. Older versions fell back to a fixed, publicly known constant;
    # replace that one if it is still in the saved state.
    csrf_token = prev_state.get("csrfToken") or ""
    if not csrf_token or csrf_token == "fe9a2c44-8811-4b22-9933-aabbccddeeff":
        csrf_token = str(uuid.uuid4())
    kill_existing_ls(run_dir)

    https_port = pick_port(DEFAULT_HTTPS_PORT)
    http_port = pick_port(DEFAULT_HTTP_PORT if DEFAULT_HTTP_PORT != https_port else DEFAULT_HTTP_PORT + 1)

    args = [
        bin_path,
        "--standalone",
        "--override_ide_name",
        "antigravity",
        "--subclient_type",
        "hub",
        "--override_ide_version",
        version,
        "--override_user_agent_name",
        "antigravity",
        "--https_server_port",
        str(https_port),
        "--http_server_port",
        str(http_port),
        "--csrf_token",
        csrf_token,
        "--app_data_dir",
        "antigravity",
        "--api_server_url",
        "https://generativelanguage.googleapis.com",
        "--cloud_code_endpoint",
        "https://daily-cloudcode-pa.googleapis.com",
        "--enable_sidecars",
        "--enable_lsp=true",
        "--remote_agent_fastpush_override=false",
        "--web_bundle_path",
        zip_path,
    ]

    log_fd = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=log_fd,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
        close_fds=True,
    )
    log_fd.close()

    actual_https = None
    actual_http = None
    deadline = time.time() + 20.0
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"language_server exited early with code {proc.returncode}")
        if os.path.isfile(log_path):
            with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                log_text = f.read()
            m_s = re.search(r"listening on \w+ port at (\d+) for HTTPS\b", log_text, re.I)
            m_h = re.search(r"listening on \w+ port at (\d+) for HTTP\b", log_text, re.I)
            if m_s:
                actual_https = int(m_s.group(1))
            if m_h:
                actual_http = int(m_h.group(1))
            if actual_https and check_https_alive(actual_https, csrf_token):
                break
        time.sleep(0.2)

    if not actual_https:
        raise RuntimeError("Timed out waiting for remote language_server HTTPS port")

    state = {
        "pid": proc.pid,
        "version": version,
        "webBundleVersion": WEB_BUNDLE_PATCH_VERSION,
        "httpsPort": actual_https,
        "httpPort": actual_http or http_port,
        "bridgePort": bridge_port,
        "csrfToken": csrf_token,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    tmp_state = state_file + f".tmp.{os.getpid()}"
    with open(tmp_state, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.chmod(tmp_state, 0o600)
    os.replace(tmp_state, state_file)

    return {
        "ok": True,
        "reused": False,
        "hostname": socket.gethostname(),
        "arch": os.uname().machine,
        "homeDir": home,
        "hasAuth": has_auth,
        "pid": proc.pid,
        "version": version,
        "httpsPort": actual_https,
        "httpPort": actual_http or http_port,
        "bridgePort": bridge_port,
        "csrfToken": csrf_token,
        "openUrls": extract_open_urls(log_path),
    }


def decode_pbtxt_string(raw_str):
    if not raw_str:
        return ""
    out = bytearray()
    i = 0
    n = len(raw_str)
    while i < n:
        ch = raw_str[i]
        if ch == "\\" and i + 1 < n:
            nxt = raw_str[i + 1]
            if nxt in "01234567" and i + 3 < n and all(c in "01234567" for c in raw_str[i + 1 : i + 4]):
                out.append(int(raw_str[i + 1 : i + 4], 8))
                i += 4
                continue
            elif nxt == "n":
                out.append(10)
            elif nxt == "r":
                out.append(13)
            elif nxt == "t":
                out.append(9)
            elif nxt in ('"', "'", "\\"):
                out.extend(nxt.encode("utf-8"))
            else:
                out.extend(nxt.encode("utf-8"))
            i += 2
        else:
            out.extend(ch.encode("utf-8"))
            i += 1
    return out.decode("utf-8", errors="replace")


def _deleted_tombstones_path():
    home = os.path.expanduser("~")
    run_dir = os.path.join(home, ".antigravity-server", "run")
    os.makedirs(run_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(run_dir, 0o700)  # holds server.json (CSRF token) and logs
    except OSError:
        pass
    return os.path.join(run_dir, "deleted_conversations.json")


def load_deleted_conversations():
    p = _deleted_tombstones_path()
    if not os.path.isfile(p):
        return set()
    try:
        with open(p, "r", encoding="utf-8") as f:
            arr = json.load(f)
        return set(arr) if isinstance(arr, list) else set()
    except Exception:
        return set()


_CLI_SYNC_STATE = {
    "last_sync_sig": "",
    "last_summaries_sig": "",
    "cached_summaries_res": None,
    "pbtxt_cache": {},
    "realpath_cache": {},
    "repo_info_cache": {},
    "metrics_row_cache": {},
}


def _stat_sig(p):
    try:
        st = os.stat(p)
        return f"{int(st.st_mtime * 1000)}:{st.st_size}"
    except Exception:
        return "0"


def _compute_cli_store_sig():
    home = os.path.expanduser("~")
    cli_root = os.path.join(home, ".gemini", "antigravity-cli")
    app_root = os.path.join(home, ".gemini", "antigravity")
    paths = [
        os.path.join(cli_root, "conversations"),
        os.path.join(app_root, "conversations"),
        os.path.join(cli_root, "brain"),
        os.path.join(cli_root, "annotations"),
        os.path.join(app_root, "annotations"),
        os.path.join(cli_root, "conversation_summaries.db"),
        os.path.join(cli_root, "conversation_summaries.db-wal"),
        os.path.join(app_root, "conversation_summaries.db"),
        os.path.join(app_root, "conversation_summaries.db-wal"),
        _deleted_tombstones_path(),
    ]
    return "|".join(_stat_sig(p) for p in paths)


def delete_cli_conversation(cid):
    if not cid or not re.match(r"^[0-9a-f-]{36}$", str(cid), re.I):
        return {"ok": False, "error": "Invalid conversation ID"}
    _CLI_SYNC_STATE["last_sync_sig"] = ""
    _CLI_SYNC_STATE["last_summaries_sig"] = ""
    _CLI_SYNC_STATE["cached_summaries_res"] = None
    deleted = load_deleted_conversations()
    deleted.add(cid)
    try:
        with open(_deleted_tombstones_path(), "w", encoding="utf-8") as f:
            json.dump(sorted(deleted), f)
    except Exception:
        pass
    home = os.path.expanduser("~")
    for store_name in ["antigravity-cli", "antigravity"]:
        root = os.path.join(home, ".gemini", store_name)
        for ext in [".db", ".db-wal", ".db-shm", ".pb"]:
            p = os.path.join(root, "conversations", f"{cid}{ext}")
            try:
                if os.path.islink(p) or os.path.isfile(p):
                    os.unlink(p)
            except Exception:
                pass
        db_path = os.path.join(root, "conversation_summaries.db")
        if os.path.isfile(db_path):
            try:
                conn = sqlite3.connect(db_path, timeout=2.0)
                conn.execute("DELETE FROM conversation_summaries WHERE conversation_id = ?", (cid,))
                conn.commit()
                conn.close()
            except Exception:
                pass
    return {"ok": True, "deletedId": cid}


def sync_cli_store():
    home = os.path.expanduser("~")
    cli_root = os.path.join(home, ".gemini", "antigravity-cli")
    app_root = os.path.join(home, ".gemini", "antigravity")
    if not os.path.isdir(cli_root):
        return
    cur_sig = _compute_cli_store_sig()
    if cur_sig and cur_sig == _CLI_SYNC_STATE["last_sync_sig"]:
        return
    deleted_set = load_deleted_conversations()

    # 1. Symlink conversation .db/.pb files one-way from antigravity-cli -> antigravity & prune broken symlinks
    cli_conv = os.path.join(cli_root, "conversations")
    app_conv = os.path.join(app_root, "conversations")
    for conv_dir in [cli_conv, app_conv]:
        if os.path.isdir(conv_dir):
            try:
                for name in os.listdir(conv_dir):
                    p = os.path.join(conv_dir, name)
                    if os.path.islink(p) and not os.path.exists(p):
                        try:
                            os.unlink(p)
                        except Exception:
                            pass
            except Exception:
                pass
    if os.path.isdir(cli_conv):
        os.makedirs(app_conv, exist_ok=True)
        try:
            dst_existing = set(os.listdir(app_conv))
            for name in os.listdir(cli_conv):
                if not (name.endswith(".db") or name.endswith(".pb")) or name.startswith("conversation_summaries."):
                    continue
                stem = name[:-3]
                if stem in deleted_set:
                    continue
                src_path = os.path.join(cli_conv, name)
                if not os.path.exists(src_path):
                    continue
                if name not in dst_existing:
                    dst_path = os.path.join(app_conv, name)
                    try:
                        os.symlink(src_path, dst_path)
                    except Exception:
                        pass
        except Exception:
            pass

    # 2. Symlink brain/<cid> directories one-way from antigravity-cli -> antigravity
    cli_brain = os.path.join(cli_root, "brain")
    app_brain = os.path.join(app_root, "brain")
    if os.path.isdir(cli_brain):
        os.makedirs(app_brain, exist_ok=True)
        try:
            dst_existing = set(os.listdir(app_brain))
            for name in os.listdir(cli_brain):
                if name in deleted_set:
                    continue
                if name not in dst_existing and re.match(r"^[0-9a-f-]{36}$", name, re.I):
                    src_path = os.path.join(cli_brain, name)
                    dst_path = os.path.join(app_brain, name)
                    try:
                        if os.path.islink(dst_path) and not os.path.exists(dst_path):
                            os.unlink(dst_path)
                        if os.path.exists(src_path):
                            os.symlink(src_path, dst_path)
                    except Exception:
                        pass
        except Exception:
            pass

    # 3. Sync annotations/<cid>.pbtxt from antigravity-cli -> antigravity (preserving title:)
    cli_ann = os.path.join(cli_root, "annotations")
    app_ann = os.path.join(app_root, "annotations")
    if os.path.isdir(cli_ann):
        os.makedirs(app_ann, exist_ok=True)
        try:
            for name in os.listdir(cli_ann):
                if not name.endswith(".pbtxt"):
                    continue
                if name[:-6] in deleted_set:
                    continue
                src_path = os.path.join(cli_ann, name)
                dst_path = os.path.join(app_ann, name)
                if not os.path.isfile(src_path):
                    continue
                if not os.path.exists(dst_path):
                    try:
                        shutil.copy2(src_path, dst_path)
                    except Exception:
                        pass
                else:
                    try:
                        with open(src_path, "r", encoding="utf-8", errors="ignore") as f:
                            src_txt = f.read()
                        m_title = re.search(r'^(title:\s*"(?:\\.|[^"\\])*")', src_txt, re.M)
                        if m_title:
                            with open(dst_path, "r", encoding="utf-8", errors="ignore") as f:
                                dst_txt = f.read()
                            if "title:" not in dst_txt:
                                merged_txt = m_title.group(1) + "\n" + dst_txt
                                with open(dst_path, "w", encoding="utf-8") as f:
                                    f.write(merged_txt)
                    except Exception:
                        pass
        except Exception:
            pass
    _CLI_SYNC_STATE["last_sync_sig"] = _compute_cli_store_sig()


def _expand_remote_workspace_uris(ws_uris):
    out = []
    seen = set()
    rp_cache = _CLI_SYNC_STATE["realpath_cache"]
    for raw_u in ws_uris or []:
        if not isinstance(raw_u, str):
            continue
        clean = raw_u.rstrip("/")
        if not clean:
            continue
        if clean not in seen:
            seen.add(clean)
            out.append(clean)
        if clean.startswith("file:///"):
            fs_path = urllib.parse.unquote(clean[7:])
            try:
                real_p = rp_cache.get(fs_path)
                if real_p is None:
                    real_p = os.path.realpath(fs_path).rstrip("/")
                    if len(rp_cache) > 512:
                        rp_cache.clear()
                    rp_cache[fs_path] = real_p
                if real_p and real_p != fs_path:
                    real_u = f"file://{real_p}"
                    if real_u not in seen:
                        seen.add(real_u)
                        out.append(real_u)
            except Exception:
                pass
    return out


def get_cli_summaries(client_sig=""):
    sync_cli_store()
    cur_sig = _compute_cli_store_sig()
    if (
        cur_sig
        and cur_sig == _CLI_SYNC_STATE["last_summaries_sig"]
        and _CLI_SYNC_STATE["cached_summaries_res"] is not None
    ):
        if client_sig and client_sig == cur_sig:
            return {"ok": True, "unchanged": True, "sig": cur_sig}
        return _CLI_SYNC_STATE["cached_summaries_res"]

    home = os.path.expanduser("~")
    deleted_set = load_deleted_conversations()
    summaries = {}
    pbtxt_titles = {}
    pbtxt_archived = set()
    cli_conv = os.path.join(home, ".gemini", "antigravity-cli", "conversations")
    app_conv = os.path.join(home, ".gemini", "antigravity", "conversations")
    existing_conv_ids = set()
    for conv_d in (cli_conv, app_conv):
        if os.path.isdir(conv_d):
            try:
                for fn in os.listdir(conv_d):
                    if fn.endswith(".db") or fn.endswith(".pb"):
                        existing_conv_ids.add(fn[:-3])
            except Exception:
                pass

    pbtxt_cache = _CLI_SYNC_STATE["pbtxt_cache"]
    for store_idx, ann_dir in enumerate([
        os.path.join(home, ".gemini", "antigravity-cli", "annotations"),
        os.path.join(home, ".gemini", "antigravity", "annotations"),
    ]):
        if not os.path.isdir(ann_dir):
            continue
        try:
            for name in os.listdir(ann_dir):
                if not name.endswith(".pbtxt"):
                    continue
                cid = name[:-6]
                p = os.path.join(ann_dir, name)
                try:
                    st_m = os.stat(p).st_mtime
                    cached_p = pbtxt_cache.get(p)
                    if not cached_p or cached_p[0] != st_m:
                        with open(p, "r", encoding="utf-8", errors="ignore") as f:
                            txt = f.read()
                        m = re.search(r'title:\s*"((?:\\.|[^"\\])*)"', txt)
                        dec_t = decode_pbtxt_string(m.group(1)).strip() if m else ""
                        arch_t = bool(re.search(r"\barchived:\s*true\b", txt))
                        arch_f = bool(re.search(r"\barchived:\s*false\b", txt))
                        cached_p = (st_m, dec_t, arch_t, arch_f)
                        pbtxt_cache[p] = cached_p
                    if cached_p[1]:
                        pbtxt_titles[cid] = cached_p[1]
                    if cached_p[2]:
                        pbtxt_archived.add(cid)
                    elif store_idx == 1 and cached_p[3]:
                        pbtxt_archived.discard(cid)
                except Exception:
                    pass
        except Exception:
            pass

    allowed_non_jetbox_sources = {
        "CORTEX_TRAJECTORY_SOURCE_CLI",
        "CORTEX_TRAJECTORY_SOURCE_AGENT_API",
        "CORTEX_TRAJECTORY_SOURCE_SDK",
        "CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE",
    }

    for store_name in ["antigravity-cli", "antigravity"]:
        db_path = os.path.join(home, ".gemini", store_name, "conversation_summaries.db")
        if not os.path.isfile(db_path):
            continue
        conn = None
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            # Use SELECT * so future schema additions/removals in conversation_summaries never break SQL parsing
            cur.execute("SELECT * FROM conversation_summaries")
            for row_obj in cur.fetchall():
                row = dict(row_obj)
                cid = str(row.get("conversation_id") or row.get("id") or "").strip()
                if not cid:
                    continue
                if bool(row.get("archived")):
                    pbtxt_archived.add(cid)
                    continue
                if cid in pbtxt_archived or cid in deleted_set:
                    continue
                has_file = cid in existing_conv_ids or any(
                    os.path.exists(os.path.join(cdir, f"{cid}{ext}"))
                    for cdir in (app_conv, cli_conv)
                    for ext in (".db", ".pb")
                )
                if not has_file:
                    continue
                step_count = int(row.get("step_count") if row.get("step_count") is not None else 1)
                if step_count <= 0:
                    continue
                source = str(row.get("source") or "")
                if store_name != "antigravity-cli" and source not in allowed_non_jetbox_sources:
                    continue
                if source == "CORTEX_TRAJECTORY_SOURCE_SUBAGENT":
                    continue
                parent_cid = str(row.get("parent_conversation_id") or "").strip()
                nesting_depth = int(row.get("nesting_depth") or 0)
                if parent_cid or nesting_depth > 0:
                    continue
                title = pbtxt_titles.get(cid, "") or str(row.get("title") or "").strip()
                preview = str(row.get("preview") or row.get("summary") or "").strip()
                if not title and not preview:
                    continue
                last_mod = str(row.get("last_modified_time") or "")
                raw_uris = row.get("workspace_uris") or "[]"
                try:
                    ws_uris = json.loads(raw_uris) if isinstance(raw_uris, str) and raw_uris else []
                    if not isinstance(ws_uris, list):
                        ws_uris = []
                except Exception:
                    ws_uris = []
                ws_uris = _expand_remote_workspace_uris(ws_uris)
                status = str(row.get("status") or "CASCADE_RUN_STATUS_IDLE")
                project_id = str(row.get("project_id") or "")
                agent_name = str(row.get("agent_name") or "")
                not_fully_idle = bool(row.get("not_fully_idle"))
                killed = bool(row.get("killed"))
                last_input_time = str(row.get("last_user_input_time") or "")
                last_input_idx = int(
                    row.get("last_user_input_step_index")
                    if row.get("last_user_input_step_index") is not None
                    else -1
                )

                prev = summaries.get(cid)
                if prev:
                    summaries[cid] = {
                        "conversationId": cid,
                        "title": title or prev["title"],
                        "preview": preview if (not prev["preview"] or store_name == "antigravity-cli") else prev["preview"],
                        "stepCount": max(step_count, prev["stepCount"]),
                        "lastModifiedTime": max(last_mod, prev["lastModifiedTime"]),
                        "workspaceUris": ws_uris if ws_uris else prev["workspaceUris"],
                        "status": status or prev["status"],
                        "source": source or prev["source"],
                        "projectId": project_id if (project_id and project_id != "default-cli-project") else (prev["projectId"] or project_id),
                        "agentName": agent_name or prev["agentName"],
                        "parentConversationId": parent_cid or prev["parentConversationId"],
                        "nestingDepth": max(nesting_depth, prev["nestingDepth"]),
                        "notFullyIdle": not_fully_idle or prev["notFullyIdle"],
                        "killed": killed or prev["killed"],
                        "lastUserInputTime": max(last_input_time, prev["lastUserInputTime"]),
                        "lastUserInputStepIndex": max(last_input_idx, prev["lastUserInputStepIndex"]),
                        "isCli": store_name == "antigravity-cli" or prev.get("isCli", False) or source in allowed_non_jetbox_sources,
                    }
                else:
                    summaries[cid] = {
                        "conversationId": cid,
                        "title": title,
                        "preview": preview,
                        "stepCount": step_count,
                        "lastModifiedTime": last_mod,
                        "workspaceUris": ws_uris,
                        "status": status,
                        "source": source,
                        "projectId": project_id,
                        "agentName": agent_name,
                        "parentConversationId": parent_cid,
                        "nestingDepth": nesting_depth,
                        "notFullyIdle": not_fully_idle,
                        "killed": killed,
                        "lastUserInputTime": last_input_time,
                        "lastUserInputStepIndex": last_input_idx,
                        "isCli": store_name == "antigravity-cli" or source in allowed_non_jetbox_sources,
                    }
        except Exception:
            pass
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass

    res_obj = {
        "ok": True,
        "sig": cur_sig,
        "summaries": summaries,
        "archivedIds": sorted(pbtxt_archived),
        "deletedIds": sorted(deleted_set),
        "titles": pbtxt_titles,
    }
    _CLI_SYNC_STATE["last_summaries_sig"] = cur_sig
    _CLI_SYNC_STATE["cached_summaries_res"] = res_obj
    if client_sig and client_sig == cur_sig:
        return {"ok": True, "unchanged": True, "sig": cur_sig}
    return res_obj


def read_conversation_raw(cascade_id, client_sig="", after_idx=-1):
    if not cascade_id or not re.match(r"^[0-9a-f-]{36}$", cascade_id, re.I):
        return {"ok": True, "cascadeId": cascade_id, "hasData": False}
    home = os.path.expanduser("~")
    db_path = os.path.join(home, ".gemini", "antigravity", "conversations", f"{cascade_id}.db")
    if not os.path.isfile(db_path):
        alt_path = os.path.join(home, ".gemini", "antigravity-cli", "conversations", f"{cascade_id}.db")
        if os.path.isfile(alt_path):
            sync_cli_store()
            db_path = alt_path
        else:
            return {"ok": True, "cascadeId": cascade_id, "hasData": False}
    try:
        real_db_path = os.path.realpath(db_path)
        st = os.stat(real_db_path)
        wal_path = real_db_path + "-wal"
        if os.path.isfile(wal_path):
            wst = os.stat(wal_path)
            wal_sig = f"{int(wst.st_mtime * 1000)}:{wst.st_size}"
        else:
            wal_sig = "0:0"
        sig = f"remote:{int(st.st_mtime * 1000)}:{st.st_size}|{wal_sig}"
        if client_sig and client_sig == sig:
            return {"ok": True, "cascadeId": cascade_id, "hasData": True, "unchanged": True, "sig": sig}

        m_cache = _CLI_SYNC_STATE["metrics_row_cache"]
        cached_entry = m_cache.get(cascade_id)
        if not cached_entry or cached_entry.get("sig") != sig:
            prev_rows_map = cached_entry.get("rows_map", {}) if cached_entry else {}
            prev_max_idx = max(prev_rows_map.keys()) if prev_rows_map else -1
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
            cur = conn.cursor()
            if prev_max_idx >= 0:
                cur.execute("SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx ASC", (prev_max_idx,))
            else:
                cur.execute("SELECT idx, data FROM gen_metadata ORDER BY idx ASC")
            rows_map = dict(prev_rows_map)
            for r in cur.fetchall():
                b64_str = base64.b64encode(r[1]).decode("ascii")
                # Single copy: the Mac side reads r.data ?? r.b64. Sending both doubled the payload.
                rows_map[int(r[0])] = {"idx": int(r[0]), "data": b64_str}
            if not rows_map:
                conn.close()
                return {"ok": True, "cascadeId": cascade_id, "hasData": False, "sig": sig}
            cur.execute("SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx ASC")
            user_steps = [r[0] for r in cur.fetchall()]
            cur.execute("SELECT idx FROM steps WHERE step_type = 15 ORDER BY idx ASC")
            planner_steps = [r[0] for r in cur.fetchall()]
            conn.close()
            if len(m_cache) > 64:
                m_cache.clear()
            cached_entry = {
                "sig": sig,
                "rows_map": rows_map,
                "user_steps": user_steps,
                "planner_steps": planner_steps,
            }
            m_cache[cascade_id] = cached_entry

        rows_map = cached_entry["rows_map"]
        all_sorted_keys = sorted(rows_map.keys())
        is_delta = isinstance(after_idx, int) and after_idx >= 0 and all_sorted_keys and all_sorted_keys[0] <= after_idx
        if is_delta:
            out_rows = [rows_map[k] for k in all_sorted_keys if k > after_idx]
        else:
            out_rows = [rows_map[k] for k in all_sorted_keys]

        return {
            "ok": True,
            "cascadeId": cascade_id,
            "hasData": True,
            "delta": bool(is_delta),
            "sig": sig,
            "rows": out_rows,
            "userSteps": cached_entry["user_steps"],
            "plannerSteps": cached_entry["planner_steps"],
        }
    except Exception as e:
        return {"ok": False, "cascadeId": cascade_id, "hasData": False, "error": str(e)}


def sanitize_git_worktree_configs():
    for base_root in ["/develop", os.path.expanduser("~")]:
        if not os.path.isdir(base_root):
            continue
        try:
            candidates = [base_root]
            for entry in os.listdir(base_root):
                if entry.startswith("."):
                    continue
                sub = os.path.join(base_root, entry)
                if os.path.isdir(sub):
                    candidates.append(sub)
            for root in candidates:
                for name in os.listdir(root):
                    if name.startswith(".") and name != ".git":
                        continue
                    repo_dir = root if name == ".git" else os.path.join(root, name)
                    git_dir = os.path.join(repo_dir, ".git")
                    cfg_path = os.path.join(git_dir, "config")
                    wt_cfg = os.path.join(git_dir, "config.worktree")
                    if os.path.isfile(cfg_path) and not os.path.exists(wt_cfg):
                        with open(cfg_path, "r", encoding="utf-8", errors="ignore") as f:
                            txt = f.read()
                        if "worktreeConfig" in txt:
                            new_txt = re.sub(r"\n?\[extensions\]\s*\n\s*worktreeConfig\s*=\s*true\s*\n?", "\n", txt)
                            if new_txt != txt:
                                with open(cfg_path, "w", encoding="utf-8") as f:
                                    f.write(new_txt)
        except Exception:
            pass


def get_git_repo_infos(repo_uris):
    repos = []
    seen = set()
    for raw_uri in repo_uris or []:
        if not isinstance(raw_uri, str):
            continue
        uri = raw_uri.rstrip("/")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        repo_path = urllib.parse.unquote(uri[7:]) if uri.startswith("file://") else uri
        if not os.path.isdir(repo_path):
            continue
        try:
            head_proc = subprocess.run(
                ["git", "-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            if head_proc.returncode != 0:
                continue
            cur_branch = head_proc.stdout.strip()
            refs_proc = subprocess.run(
                ["git", "-C", repo_path, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
                capture_output=True,
                text=True,
                timeout=3,
            )
            branches = []
            has_cur = False
            for line in refs_proc.stdout.splitlines():
                bname = line.strip()
                if not bname:
                    continue
                if bname == cur_branch:
                    branches.append({"name": bname, "isCurrentBranch": True})
                    has_cur = True
                else:
                    branches.append({"name": bname})
            if cur_branch and cur_branch != "HEAD" and not has_cur:
                branches.insert(0, {"name": cur_branch, "isCurrentBranch": True})
            repos.append(
                {
                    "name": os.path.basename(repo_path) or repo_path,
                    "repoPath": repo_path,
                    "branches": branches,
                    "scmType": "SCM_TYPE_GIT",
                    "repoUri": uri if uri.startswith("file://") else f"file://{repo_path}",
                }
            )
        except Exception:
            pass
    return {"repos": repos}


# ---- Resumable stream relay ------------------------------------------------------------
# The Mac side used to proxy server-streaming RPCs (StreamAgentStateUpdates, ...) straight
# through the SSH tunnel. When the tunnel dropped, every stream died; the Antigravity UI then
# reset its conversation state and re-subscribed, which re-downloads the whole trajectory
# snapshot (hundreds of KB to MBs) over the slow relay route.
#
# The relay keeps the language_server subscription here, on the remote host, inside this
# detached bridge daemon. Every Connect envelope coming out of the LS gets a sequence number
# and is kept in a bounded replay buffer. The Mac side attaches with `afterSeq` and gets the
# frames it missed, then the live tail. The LS never sees the disconnect.
#
# Wire format (bridge -> Mac), one record after another until the connection closes:
#   u8 type | u64 seq (BE) | u32 len (BE) | payload[len]
#   type 1 META  payload = JSON {streamId, status, headers, oldestSeq, lastSeq, resumed}
#   type 2 FRAME payload = one raw Connect envelope (5-byte header + message), seq = 1, 2, ...
#   type 3 END   payload = JSON {reason, lastSeq}; upstream finished, no more frames
#   type 4 BEAT  payload = JSON {lastSeq, ts}; sent when idle so the Mac can detect stalls
# See docs/resumable-relay.md.

RELAY_PROTOCOL_VERSION = 1
RELAY_REC_META = 1
RELAY_REC_FRAME = 2
RELAY_REC_END = 3
RELAY_REC_BEAT = 4
RELAY_HEARTBEAT_S = float(os.environ.get("AG_RELAY_HEARTBEAT_S") or 5.0)
# Keep a detached stream (and its LS subscription) this long. Must be longer than the Mac
# side's recovery window (150s) so the Mac always gives up first and never resumes into a
# stream that has just been reaped.
RELAY_RETENTION_S = float(os.environ.get("AG_RELAY_RETENTION_S") or 180.0)
# Replay buffer cap per stream. The first frame of StreamAgentStateUpdates is the full
# trajectory snapshot and can be several MB, so this is larger than Codex's 1 MiB.
RELAY_MAX_BUFFER_BYTES = int(os.environ.get("AG_RELAY_MAX_BUFFER_BYTES") or 16 * 1024 * 1024)
RELAY_MAX_STREAMS = int(os.environ.get("AG_RELAY_MAX_STREAMS") or 64)
RELAY_WRITE_TIMEOUT_S = 30.0
RELAY_ALLOWED_PATH_PREFIX = "/exa.language_server_pb.LanguageServerService/"
RELAY_DROP_REQ_HEADERS = {
    "host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length",
    "x-codeium-csrf-token", "cookie", "origin", "referer", "accept-encoding", "te",
}
RELAY_DROP_RESP_HEADERS = {"transfer-encoding", "connection", "content-length", "date", "keep-alive"}

_relay_lock = threading.Lock()
_relay_streams = {}
_relay_janitor_started = False


def _relay_upstream_target():
    """(host, port, csrf) of the LS's plain-HTTP Connect listener."""
    override = os.environ.get("AG_RELAY_UPSTREAM") or ""
    if override:
        host, _, port = override.rpartition(":")
        return host or "127.0.0.1", int(port), os.environ.get("AG_RELAY_CSRF") or ""
    state_file = os.path.join(os.path.expanduser("~"), ".antigravity-server", "run", "server.json")
    with open(state_file, "r", encoding="utf-8") as f:
        st = json.load(f)
    return "127.0.0.1", int(st.get("httpPort") or DEFAULT_HTTP_PORT), st.get("csrfToken") or ""


def _relay_record(rtype, seq, payload):
    if isinstance(payload, (dict, list)):
        payload = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return struct.pack(">BQI", rtype, seq, len(payload)) + payload


def _connect_end_error(code, message):
    body = json.dumps({"error": {"code": code, "message": message}}).encode("utf-8")
    return struct.pack(">BI", 0x02, len(body)) + body


class RelayStream:
    def __init__(self, stream_id, path, headers, body):
        self.id = stream_id
        self.path = path
        self.req_headers = headers
        self.req_body = body
        self.cond = threading.Condition()
        self.frames = []          # [(seq, bytes)], contiguous seqs
        self.buffer_bytes = 0
        self.last_seq = 0
        self.evicted_upto = 0     # highest seq dropped from the buffer
        self.status = 0
        self.resp_headers = {}
        self.ready = False        # upstream response headers received
        self.ended = False
        self.end_reason = ""
        self.attach_gen = 0
        self.writers = 0
        self.detached_since = time.time()
        self.created = time.time()
        self.attaches = 0
        self.conn = None
        self.closed = False

    # -- upstream --------------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._pump, name=f"relay-{self.id[:8]}", daemon=True).start()

    def _append(self, data):
        with self.cond:
            self.last_seq += 1
            self.frames.append((self.last_seq, data))
            self.buffer_bytes += len(data)
            # Always keep the newest frame, even if it alone exceeds the cap.
            while self.buffer_bytes > RELAY_MAX_BUFFER_BYTES and len(self.frames) > 1:
                seq, old = self.frames.pop(0)
                self.buffer_bytes -= len(old)
                self.evicted_upto = seq
            self.cond.notify_all()

    def _finish(self, reason):
        with self.cond:
            if self.ended:
                return
            self.ended = True
            self.end_reason = reason
            self.cond.notify_all()

    def _pump(self):
        import http.client

        try:
            host, port, csrf = _relay_upstream_target()
            headers = {k: v for k, v in self.req_headers.items() if k.lower() not in RELAY_DROP_REQ_HEADERS}
            headers.setdefault("content-type", "application/connect+json")
            headers.setdefault("connect-protocol-version", "1")
            if csrf:
                headers["x-codeium-csrf-token"] = csrf
            self.conn = http.client.HTTPConnection(host, port, timeout=None)
            self.conn.request("POST", self.path, body=self.req_body, headers=headers)
            resp = self.conn.getresponse()
            with self.cond:
                self.status = resp.status
                self.resp_headers = {
                    k.lower(): v for k, v in resp.getheaders() if k.lower() not in RELAY_DROP_RESP_HEADERS
                }
                self.ready = True
                self.cond.notify_all()
            if resp.status != 200:
                self._append(resp.read())
                self._finish("upstream-status")
                return
            while not self.closed:
                hdr = resp.read(5)
                if not hdr:
                    break
                if len(hdr) < 5:
                    raise IOError("truncated envelope header")
                flags, length = struct.unpack(">BI", hdr)
                payload = resp.read(length) if length else b""
                if len(payload) < length:
                    raise IOError("truncated envelope")
                self._append(hdr + payload)
                if flags & 0x02:  # Connect end-of-stream envelope
                    self._finish("upstream-end")
                    return
            self._finish("upstream-eof")
        except Exception as e:
            if self.closed:
                self._finish("closed")
                return
            with self.cond:
                if not self.ready:
                    self.status = 200
                    self.resp_headers = {"content-type": self.req_headers.get("content-type") or "application/connect+json"}
                    self.ready = True
            # Tell the client the stream is over so the UI re-subscribes (to a new LS if it restarted).
            self._append(_connect_end_error("unavailable", f"relay upstream lost: {e}"))
            self._finish("upstream-error")
        finally:
            try:
                if self.conn:
                    self.conn.close()
            except Exception:
                pass

    def close(self):
        self.closed = True
        try:
            if self.conn and self.conn.sock:
                self.conn.sock.shutdown(socket.SHUT_RDWR)
        except Exception:
            pass
        self._finish("closed")

    # -- downstream -----------------------------------------------------------------
    def serve(self, wfile, after_seq):
        """Write META, replay frames after `after_seq`, then follow live. Runs in the handler thread."""
        with self.cond:
            self.attach_gen += 1
            gen = self.attach_gen
            self.writers += 1
            self.attaches += 1
            self.detached_since = None
            self.cond.notify_all()  # wake (and thereby preempt) any older writer
            deadline = time.time() + 30.0
            while not self.ready and not self.ended and time.time() < deadline:
                self.cond.wait(1.0)
        try:
            if after_seq and after_seq < self.evicted_upto:
                wfile.write(_relay_record(RELAY_REC_END, self.last_seq, {"reason": "gap", "oldestSeq": self.evicted_upto + 1}))
                return
            meta = {
                "streamId": self.id,
                "status": self.status or 200,
                "headers": self.resp_headers,
                "oldestSeq": self.evicted_upto + 1,
                "lastSeq": self.last_seq,
                "resumed": after_seq > 0,
            }
            wfile.write(_relay_record(RELAY_REC_META, 0, meta))
            cursor = after_seq
            while True:
                with self.cond:
                    if gen != self.attach_gen:
                        return  # a newer attach took over
                    if self.last_seq <= cursor and not self.ended:
                        self.cond.wait(RELAY_HEARTBEAT_S)
                    if gen != self.attach_gen:
                        return
                    if cursor < self.evicted_upto:
                        batch = None
                    else:
                        start = 0
                        if self.frames:
                            start = max(0, cursor + 1 - self.frames[0][0])
                        batch = self.frames[start:]
                    ended = self.ended
                    last = self.last_seq
                if batch is None:
                    wfile.write(_relay_record(RELAY_REC_END, last, {"reason": "gap", "oldestSeq": self.evicted_upto + 1}))
                    return
                if batch:
                    wfile.write(b"".join(_relay_record(RELAY_REC_FRAME, s, d) for s, d in batch))
                    cursor = batch[-1][0]
                elif not ended:
                    wfile.write(_relay_record(RELAY_REC_BEAT, cursor, {"lastSeq": cursor, "ts": int(time.time() * 1000)}))
                if ended and cursor >= last:
                    wfile.write(_relay_record(RELAY_REC_END, cursor, {"reason": self.end_reason, "lastSeq": cursor}))
                    return
        finally:
            with self.cond:
                self.writers -= 1
                if self.writers <= 0:
                    self.writers = 0
                    self.detached_since = time.time()

    def stats(self):
        with self.cond:
            return {
                "id": self.id,
                "path": self.path.rsplit("/", 1)[-1],
                "lastSeq": self.last_seq,
                "oldestSeq": self.evicted_upto + 1,
                "bufferBytes": self.buffer_bytes,
                "ended": self.ended,
                "endReason": self.end_reason,
                "writers": self.writers,
                "attaches": self.attaches,
                "detachedFor": round(time.time() - self.detached_since, 1) if self.detached_since else 0,
                "ageS": round(time.time() - self.created, 1),
            }


def _relay_janitor():
    while True:
        time.sleep(5.0)
        now = time.time()
        reap = []
        with _relay_lock:
            for sid, s in list(_relay_streams.items()):
                idle = s.detached_since is not None and now - s.detached_since > (
                    RELAY_RETENTION_S
                )
                if idle:
                    reap.append(_relay_streams.pop(sid))
        for s in reap:
            s.close()


def relay_get_or_create(stream_id, after_seq, path, headers, body):
    global _relay_janitor_started
    with _relay_lock:
        if not _relay_janitor_started:
            _relay_janitor_started = True
            threading.Thread(target=_relay_janitor, name="relay-janitor", daemon=True).start()
        s = _relay_streams.get(stream_id)
        if s is not None:
            return s, None
        if after_seq > 0:
            return None, (404, {"ok": False, "error": "unknown-stream"})
        if not path.startswith(RELAY_ALLOWED_PATH_PREFIX):
            return None, (400, {"ok": False, "error": "path not allowed"})
        if len(_relay_streams) >= RELAY_MAX_STREAMS:
            # Evict the longest-detached stream rather than refusing.
            detached = [x for x in _relay_streams.values() if x.detached_since is not None]
            if not detached:
                return None, (503, {"ok": False, "error": "too many relay streams"})
            victim = min(detached, key=lambda x: x.detached_since)
            _relay_streams.pop(victim.id, None)
            victim.close()
        s = RelayStream(stream_id, path, headers, body)
        _relay_streams[stream_id] = s
    s.start()
    return s, None


def relay_close(stream_id):
    with _relay_lock:
        s = _relay_streams.pop(stream_id, None)
    if s:
        s.close()
    return {"ok": True, "closed": bool(s)}


def relay_stats():
    with _relay_lock:
        streams = list(_relay_streams.values())
    return {"ok": True, "protocol": RELAY_PROTOCOL_VERSION, "streams": [s.stats() for s in streams]}


def handle_relay_stream(handler):
    """POST /relay/stream  {id, afterSeq, path, headers, bodyB64} -> record stream (open or resume)."""
    try:
        clen = int(handler.headers.get("Content-Length") or "0")
        req = json.loads(handler.rfile.read(clen).decode("utf-8") or "{}") if clen > 0 else {}
        stream_id = str(req.get("id") or "")
        if not re.match(r"^[A-Za-z0-9_-]{8,80}$", stream_id):
            handler._send_json(400, {"ok": False, "error": "bad id"})
            return
        after_seq = int(req.get("afterSeq") or 0)
        body = base64.b64decode(req.get("bodyB64") or "")
        headers = req.get("headers") if isinstance(req.get("headers"), dict) else {}
        s, err = relay_get_or_create(stream_id, after_seq, str(req.get("path") or ""), headers, body)
    except Exception as e:
        handler._send_json(400, {"ok": False, "error": str(e)})
        return
    if err:
        handler._send_json(err[0], err[1])
        return
    handler.close_connection = True
    try:
        handler.connection.settimeout(RELAY_WRITE_TIMEOUT_S)
        handler.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ag-relay")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Ag-Relay-Protocol", str(RELAY_PROTOCOL_VERSION))
    handler.end_headers()
    try:
        s.serve(handler.wfile, after_seq)
    except Exception:
        pass  # client went away; the stream stays buffered for RELAY_RETENTION_S


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    timeout = 5

    def log_message(self, format, *args):
        pass

    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/ping":
            self._send_json(200, {"ok": True, "ts": int(time.time() * 1000), "hostname": socket.gethostname()})
        elif parsed.path == "/status":
            self._send_json(200, get_status_dict())
        elif parsed.path == "/metrics":
            cid = (qs.get("cascadeId") or [""])[0]
            sig = (qs.get("sig") or [""])[0]
            raw_after = (qs.get("afterIdx") or ["-1"])[0]
            after_idx = int(raw_after) if str(raw_after).lstrip("-").isdigit() else -1
            self._send_json(200, read_conversation_raw(cid, sig, after_idx))
        elif parsed.path == "/repo-infos":
            uris = qs.get("uri") or []
            self._send_json(200, get_git_repo_infos(uris))
        elif parsed.path == "/cli-summaries":
            sig = (qs.get("sig") or [""])[0]
            self._send_json(200, get_cli_summaries(sig))
        elif parsed.path == "/relay/stats":
            self._send_json(200, relay_stats())
        else:
            self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/relay/stream":
            handle_relay_stream(self)
            return
        if parsed.path == "/relay/close":
            qs = urllib.parse.parse_qs(parsed.query)
            self._send_json(200, relay_close((qs.get("id") or [""])[0]))
            return
        if parsed.path == "/restart":
            try:
                clen = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(clen).decode("utf-8", errors="ignore") if clen > 0 else "{}"
                body = json.loads(raw) if raw else {}
                cur_st = get_status_dict()
                ver = (body.get("version") if isinstance(body, dict) else None) or cur_st.get("version") or "2.28.2"
                exec_id = (body.get("executionId") if isinstance(body, dict) else None) or ("5937220255875072" if ver == "2.28.2" else "auto")
                res = ensure_server(ver, exec_id, force_restart=True)
                self._send_json(200, res)
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
        elif parsed.path == "/repo-infos":
            try:
                clen = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(clen).decode("utf-8", errors="ignore") if clen > 0 else "{}"
                body = json.loads(raw) if raw else {}
                uris = body.get("repoUris") if isinstance(body, dict) else []
                self._send_json(200, get_git_repo_infos(uris))
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e), "repos": []})
        elif parsed.path == "/delete-cli-summary":
            try:
                clen = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(clen).decode("utf-8", errors="ignore") if clen > 0 else "{}"
                body = json.loads(raw) if raw else {}
                cid = (body.get("cascadeId") or body.get("id") or "") if isinstance(body, dict) else ""
                self._send_json(200, delete_cli_conversation(cid))
            except Exception as e:
                self._send_json(500, {"ok": False, "error": str(e)})
        else:
            self._send_json(404, {"ok": False, "error": "Not found"})


def _background_sync_loop():
    while True:
        try:
            sync_cli_store()
        except Exception:
            pass
        time.sleep(2.0)


def run_bridge_daemon(port):
    # AG_BRIDGE_RELAY_ONLY=1: test instance (scripts/relay-*-test.mjs) that must not touch the
    # CLI store or git configs the real bridge manages.
    if os.environ.get("AG_BRIDGE_RELAY_ONLY") != "1":
        sanitize_git_worktree_configs()
        sync_cli_store()
        t = threading.Thread(target=_background_sync_loop, daemon=True)
        t.start()
    server_cls = getattr(http.server, "ThreadingHTTPServer", http.server.HTTPServer)
    server_cls.allow_reuse_address = True
    server = server_cls(("127.0.0.1", port), BridgeHandler)
    server.serve_forever()


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "ensure"
    if action == "bridge-daemon":
        port = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else DEFAULT_BRIDGE_PORT
        run_bridge_daemon(port)
        return

    raw_ver = sys.argv[2] if len(sys.argv) > 2 else ""
    raw_exec = sys.argv[3] if len(sys.argv) > 3 else ""
    version = raw_ver if re.match(r"^\d+\.\d+\.\d+$", raw_ver) else (get_status_dict().get("version") or "2.28.2")
    execution_id = raw_exec if (raw_exec == "auto" or re.match(r"^\d+$", raw_exec)) else ("5937220255875072" if version == "2.28.2" else "auto")

    try:
        if action == "ensure":
            res = ensure_server(version, execution_id, force_restart=False)
        elif action == "restart":
            res = ensure_server(version, execution_id, force_restart=True)
        elif action == "status":
            res = get_status_dict()
        elif action == "metrics":
            cid = sys.argv[2] if len(sys.argv) > 2 else ""
            res = read_conversation_raw(cid)
        else:
            res = {"ok": False, "error": f"Unknown action: {action}"}
    except Exception as e:
        res = {"ok": False, "error": str(e)}

    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
