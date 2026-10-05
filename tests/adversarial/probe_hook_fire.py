"""Live probe: does a failing value-bearing child fire __on_errored_message__?

    python tests/adversarial/probe_hook_fire.py

Needs GENLAYER_DEV_KEY (env) or tests/adversarial/.env, funded with GEN.

Background: the settlement contract relies on __on_errored_message__ to turn a
failed payout into a recoverable `owed` obligation. The docs disagree on
whether the value comes back at all (Value Transfers: "not automatically
returned"; SDK hook docstring: "simply accepts the refunded value"), and the
earlier hook_probe.py could not settle it: every trigger it tried failed at
EMIT time, so no child was ever created.

This probe uses the one trigger the earlier probe never tried: a value-bearing
call to a payable method that reverts (emit(value=...).boom()). The emit can
succeed -- the sender holds the value and the method exists -- and only the
CHILD fails, which is exactly the case the hook documents.

Prints FIRE+REFUND (hook fired and value came back), FIRE-NO-VALUE, or SKIP.
"""

import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import genlayer_py.accounts as accounts
from genlayer_py.chains import studionet
from genlayer_py.client.client import create_client

HERE = Path(__file__).resolve().parent
GEN = 10**18

TRANSIENT = ("invalid json", "502", "503", "504", "timeout", "timed out",
             "connection", "bad gateway", "rate limit", "-32029", "429")


def transient(exc):
    return any(t in str(exc).lower() for t in TRANSIENT)

RECEIVER = """# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *


class Receiver(gl.Contract):
    def __init__(self):
        pass

    @gl.public.write.payable
    def boom(self) -> None:
        raise gl.vm.UserError("[EXPECTED] deliberate child failure for the refund probe")
""".lstrip()

SENDER = """# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *


class Sender(gl.Contract):
    refunded: u256
    calls: u256

    def __init__(self):
        self.refunded = u256(0)
        self.calls = u256(0)

    @gl.public.write.payable
    def top_up(self) -> None:
        pass

    @gl.public.write
    def send_call(self, target: Address) -> None:
        if not isinstance(target, Address):
            target = Address(target)
        gl.get_contract_at(target).emit(
            value=self.balance, on="finalized"
        ).boom()

    @gl.public.view
    def refunded_amount(self) -> u256:
        return self.refunded

    @gl.public.view
    def hook_calls(self) -> u256:
        return self.calls

    @gl.public.write.payable
    def __on_errored_message__(self):
        self.refunded = self.refunded + gl.message.value
        self.calls = self.calls + 1
""".lstrip()


def receipt(tx):
    exe = shutil.which("genlayer.cmd") or shutil.which("genlayer")
    for _ in range(6):
        p = subprocess.run([exe, "receipt", tx], capture_output=True, text=True,
                           timeout=900, encoding="utf-8", errors="replace")
        out = (p.stdout or "") + (p.stderr or "")
        ex = re.search(r"execution_result:\s*'(\w+)'", out)
        if ex:
            pl = re.search(r"payload:\s*'([^']*)'", out)
            return ex.group(1), (pl.group(1) if pl else "")
        time.sleep(4)
    return None, ""


def deploy(c, code, name):
    tx = c.deploy_contract(code)
    ex, pl = receipt(tx)
    addr = dict(c.get_transaction_receipt(tx)).get("to")
    ok = False
    for _ in range(20):
        try:
            c.get_contract_schema(addr)
            ok = True
            break
        except Exception:
            time.sleep(3)
    print(f"  {name:9} {addr}  exec={ex} schema={'OK' if ok else 'UNAVAILABLE'}", flush=True)
    if not ok:
        raise SystemExit(f"{name} never indexed; payload was: {pl}")
    return addr


def main() -> int:
    import os
    key = os.environ.get("GENLAYER_DEV_KEY")
    if not key:
        env = HERE / ".env"
        if env.exists():
            key = [l.split(b"=", 1)[1].decode("utf-8").strip()
                   for l in env.read_bytes().split(b"\n")
                   if l.startswith(b"GENLAYER_DEV_KEY=")][0]
    if not key:
        raise SystemExit("set GENLAYER_DEV_KEY, or put it in tests/adversarial/.env")
    acct = accounts.create_account(key)
    c = create_client(chain=studionet, account=acct)

    print("deploying:", flush=True)
    if len(sys.argv) == 2:
        # Reuse receiver, fresh sender: python probe_hook_fire.py <receiver>
        receiver = sys.argv[1]
        print(f"  reusing receiver {receiver}", flush=True)
        sender = deploy(c, SENDER, "sender")
    elif len(sys.argv) >= 3:
        # Reuse: python probe_hook_fire.py <receiver> <sender>
        receiver, sender = sys.argv[1], sys.argv[2]
        print(f"  reusing receiver {receiver} / sender {sender}", flush=True)
    else:
        receiver = deploy(c, RECEIVER, "receiver")
        sender = deploy(c, SENDER, "sender")

    def w(addr, method, args, value=0, tries=8):
        last = None
        for i in range(tries):
            try:
                tx = c.write_contract(addr, method, account=acct,
                                      args=args, value=value)
                print(f"  {method:16} tx={tx}", flush=True)
                ex, pl = receipt(tx)
                print(f"  {method:16} exec={ex} {('| ' + pl[:80]) if pl else ''}", flush=True)
                return ex, pl
            except Exception as exc:
                last = exc
                if not transient(exc):
                    raise
                print(f"  {method:16} transient ({str(exc)[:60]}), retry {i + 1}/{tries}",
                      flush=True)
                time.sleep(15 * (i + 1))
        raise SystemExit(f"{method} unsendable after {tries} tries: {str(last)[:110]}")

    if len(sys.argv) >= 3:
        print("  (reused sender keeps its earlier 1 GEN funding)", flush=True)
    else:
        print("funding the sender with 1 GEN:", flush=True)
        w(sender, "top_up", [], value=GEN)

    print("emitting value-bearing call to the reverting method:", flush=True)
    ex, pl = w(sender, "send_call", [receiver])
    if ex != "SUCCESS":
        print("EMIT itself failed; no child created. RESULT: SKIP")
        return 2

    print("waiting for the child to fail and the value to come back...", flush=True)
    for i in range(18):
        time.sleep(10)
        try:
            refunded = c.read_contract(sender, "refunded_amount", [])
            calls = c.read_contract(sender, "hook_calls", [])
        except Exception as exc:
            print(f"  t+{(i + 1) * 10:3}s  read failed: {str(exc)[:80]}", flush=True)
            continue
        print(f"  t+{(i + 1) * 10:3}s  refunded={refunded}  calls={calls}", flush=True)
        if calls and int(calls) > 0:
            if int(refunded) > 0:
                print("RESULT: FIRE+REFUND -- hook fired and value came back.")
                return 0
            print("RESULT: FIRE-NO-VALUE -- hook fired but value did not come back.")
            return 1

    print("RESULT: SKIP -- hook never fired within 180s.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
