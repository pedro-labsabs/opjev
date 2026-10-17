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
                  "timeout_ms": 60000}},
    {"wait_dump": {"regex": "Orquestracao", "min_extra": 1, "timeout_ms": 120000}}
  ],
  "dump_to": "/caminho/pty-dump.bin"
}

- Todo output do PTY e gravado em dump_to (para grep de visibilidade).
- wait_log: le o arquivo (log do gateway) e espera NOVAS ocorrencias do regex
  a partir do baseline do inicio do passo; faz pump do PTY durante a espera.
- exit 0 confirma somente que os passos do script terminaram; nao confirma
  submit, intercept, admission ou dispatch. O chamador valida eventos do gateway.
- progresso stdout e allowlisted (step, bytes escritos, Enter); nunca inclui o
  texto digitado nem o output bruto do PTY.
- No fim (ou erro) envia SIGTERM/SIGKILL no filho: o TUI nunca fica orfao.
"""
import json
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def terminate_and_reap(pid: int) -> None:
    """Stop the PTY child without blocking on a silent master PTY read."""
    def wait_nonblocking() -> bool:
        while True:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                return done == pid
            except InterruptedError:
                continue
            except ChildProcessError:
                # ECHILD means this process is no longer waitable by us.
                return True

    def signal_child(signum: int) -> None:
        while True:
            try:
                os.kill(pid, signum)
                return
            except InterruptedError:
                continue
            except ProcessLookupError:
                # The child may have exited between waitpid and kill. Keep
                # checking waitpid so an exited-but-unreaped child is reaped.
                return

    if wait_nonblocking():
        return

    signal_child(signal.SIGTERM)
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if wait_nonblocking():
            return
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))

    signal_child(signal.SIGKILL)
    while True:
        try:
            done, _ = os.waitpid(pid, 0)
            if done == pid:
                return
        except InterruptedError:
            continue
        except ChildProcessError:
            return


def main() -> int:
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    # Parent cancellation must unwind through finally so the PTY child is reaped.
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
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

    # janela 50x300 (TUI renderiza sem truncar a mensagem do toast e o runID)
    try:
      fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 300, 0, 0))
    except OSError:
      pass

    dump = open(spec["dump_to"], "wb", buffering=0)
    alive = True

    def progress(event: str, step: int, **fields: int) -> None:
        # Allowlisted metrics only. Never echo input text, PTY output, or IDs.
        record = {"source": "opjev-e2e-tui", "event": event, "step": step, **fields}
        sys.stdout.write(json.dumps(record, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def write_all(payload: bytes) -> int:
        written_total = 0
        while written_total < len(payload):
            written = os.write(fd, payload[written_total:])
            if written <= 0:
                raise OSError("PTY write made no progress")
            written_total += written
        return written_total

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
                payload = step["type"].encode("utf-8")
                try:
                    written = write_all(payload)
                except OSError:
                    sys.stderr.write(f"driver: falha de escrita PTY no passo {idx}\n")
                    return 1
                progress("pty-write", idx, bytesRequested=len(payload), bytesWritten=written)
                if not pump(0.4):
                    sys.stderr.write(f"driver: filho morreu apos bytes PTY no passo {idx}\n")
                    return 1
                if step.get("enter", True):
                    try:
                        enter_written = write_all(b"\r")
                    except OSError:
                        sys.stderr.write(f"driver: falha ao enviar Enter PTY no passo {idx}\n")
                        return 1
                    progress("enter-sent", idx, bytesWritten=enter_written)
                    if not pump(step.get("after_enter_ms", 500) / 1000.0):
                        sys.stderr.write(f"driver: filho morreu apos Enter PTY no passo {idx}\n")
                        return 1
            elif "key" in step:
                os.write(fd, step["key"].encode("utf-8").decode("unicode_escape").encode("utf-8"))
                pump(step.get("after_ms", 500) / 1000.0)
            elif "sleep_ms" in step:
                pump(step["sleep_ms"] / 1000.0)
            elif "wait_log" in step:
                wl = step["wait_log"]
                # baseline ABSOLUTO (quando fornecido pelo orquestrador, contado
                # ANTES do spawn do TUI): elimina a corrida em que o submit
                # acontece entre o type e a leitura do baseline no wait.
                if "baseline" in wl:
                    baseline = int(wl["baseline"])
                else:
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
            elif "wait_dump" in step:
                # Espera o render REAL aparecer no proprio dump do PTY (o
                # arquivo que o driver esta escrevendo). Sem isso o harness
                # torceria por um toast transitorio e o gate de apresentacao
                # viraria flaky por construcao.
                wd = step["wait_dump"]
                target = int(wd.get("min_extra", 1))
                deadline = time.time() + wd.get("timeout_ms", 30000) / 1000.0
                ok = False
                while time.time() < deadline:
                    if count_in_file(spec["dump_to"], wd["regex"]) >= target:
                        ok = True
                        break
                    if not pump(0.5):
                        break
                if not ok:
                    sys.stderr.write(
                        f"driver: wait_dump '{wd['regex']}' nao apareceu no dump "
                        f"no passo {idx}\n"
                    )
                    return 1
            else:
                sys.stderr.write(f"driver: passo {idx} desconhecido\n")
                return 1
        pump(spec.get("tail_ms", 1000) / 1000.0)
        return 0
    finally:
        previous_sigterm = signal.signal(signal.SIGTERM, signal.SIG_IGN)
        previous_sigint = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            try:
                dump.close()
            finally:
                try:
                    terminate_and_reap(pid)
                finally:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
        finally:
            signal.signal(signal.SIGINT, previous_sigint)
            signal.signal(signal.SIGTERM, previous_sigterm)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
