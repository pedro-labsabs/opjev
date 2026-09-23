#!/usr/bin/env python3
"""Driver PTY generico para o TUI real do OpenCode (E2E da issue #24).

Uso: python3 scripts/e2e-tui.py <spec.json>

Spec (JSON):
{
  "bin": "/caminho/opencode",
  "args": ["--server", "http://127.0.0.1:PORTA"],
  "cwd": "/workspace-do-projeto",
  "env": {"OPENCODE_PASSWORD": "...", "HOME": "..."},
  "boot_ms": 10000,
  "steps": [
    {"type": "texto digitado", "enter": true},
    {"sleep_ms": 2000},
    {"key": "\\u001b"},
    {"wait_log": {"file": "/caminho/gateway.log",
                  "regex": "rpc-dispatched", "min_extra": 1,
                  "timeout_ms": 60000}}
  ],
  "dump_to": "/caminho/pty-dump.bin"
}

- Todo output do PTY e gravado em dump_to (para grep de visibilidade).
- wait_log: le o arquivo (log do gateway) e espera NOVAS ocorrencias do regex
  a partir do baseline do inicio do passo; faz pump do PTY durante a espera.
- No fim (ou erro) envia SIGTERM/SIGKILL no filho: o TUI nunca fica orfao.
"""
import json
import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("uso: e2e-tui.py <spec.json>\n")
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    env = {**os.environ, **{k: str(v) for k, v in spec.get("env", {}).items()}}
    pid, fd = pty.fork()
    if pid == 0:  # filho: executa o TUI
        os.chdir(spec["cwd"])
        os.execvpe(spec["bin"], [spec["bin"], *spec["args"]], env)
        os._exit(127)

    # janela 40x120 (TUI renderiza melhor e o dump tem texto "cru" legivel)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    except OSError:
        pass

    dump = open(spec["dump_to"], "wb", buffering=0)
    alive = True

    def pump(seconds: float) -> bool:
        """Le o output do PTY durante `seconds`. False = filho morreu."""
        nonlocal alive
        end = time.time() + seconds
        while alive and time.time() < end:
            timeout = min(0.2, max(0.0, end - time.time()))
            ready, _, _ = select.select([fd], [], [], timeout)
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    alive = False
                    return False
                if not data:
                    alive = False
                    return False
                dump.write(data)
        return alive

    def count_in_file(path: str, pattern: str) -> int:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return len(re.findall(pattern, fh.read()))
        except OSError:
            return 0

    try:
        pump(spec.get("boot_ms", 10000) / 1000.0)
        for idx, step in enumerate(spec.get("steps", [])):
            if not alive:
                sys.stderr.write(f"driver: filho morreu no passo {idx}\n")
                return 1
            if "type" in step:
                os.write(fd, step["type"].encode("utf-8"))
                pump(0.4)
                if step.get("enter", True):
                    os.write(fd, b"\r")
                    pump(step.get("after_enter_ms", 500) / 1000.0)
            elif "key" in step:
                os.write(fd, step["key"].encode("utf-8").decode("unicode_escape").encode("utf-8"))
                pump(step.get("after_ms", 500) / 1000.0)
            elif "sleep_ms" in step:
                pump(step["sleep_ms"] / 1000.0)
            elif "wait_log" in step:
                wl = step["wait_log"]
                baseline = count_in_file(wl["file"], wl["regex"])
                target = baseline + int(wl.get("min_extra", 1))
                deadline = time.time() + wl.get("timeout_ms", 30000) / 1000.0
                ok = False
                while time.time() < deadline:
                    if count_in_file(wl["file"], wl["regex"]) >= target:
                        ok = True
                        break
                    if not pump(0.5):
                        break
                if not ok:
                    sys.stderr.write(
                        f"driver: wait_log '{wl['regex']}' nao alcancou {target} "
                        f"(baseline {baseline}) no passo {idx}\n"
                    )
                    return 1
            else:
                sys.stderr.write(f"driver: passo {idx} desconhecido\n")
                return 1
        pump(spec.get("tail_ms", 1000) / 1000.0)
        return 0
    finally:
        dump.close()
        try:
            os.kill(pid, 15)  # SIGTERM -> TUI fecha
        except OSError:
            pass
        end = time.time() + 3
        while time.time() < end:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                break
            try:
                os.read(fd, 4096)
            except OSError:
                break
            time.sleep(0.1)
        else:
            try:
                os.kill(pid, 9)
                os.waitpid(pid, 0)
            except OSError:
                pass
        try:
            os.close(fd)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
