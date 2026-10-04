"""Does __on_errored_message__ fire, and does the value actually come back?

    python hook_probe.py --deploy

The two official sources contradict each other on the point that matters most for
a payout contract:

  docs.genlayer.com, Value Transfers:
    "If the child transaction fails, the value is not automatically returned to
     the sender."

  sdk.genlayer.com, the __on_errored_message__ docstring:
    "This method is called when an emitted message with non-zero value fails
     during execution. By default, it simply accepts the refunded value."

Read together, the value does come back - but through the contract's own callback
rather than automatically, which means a contract that does not implement it has
no idea a payout failed. That is the mechanism this probe measures, because if it
is true the whole balance-guessing design can be replaced by the platform telling
us directly.

Trigger used: an INTERNAL message carrying value to an Intelligent Contract that
defines no __receive__. The special-methods dispatch diagram documents that path as
an error - value present, no method name, no __receive__ - so the child fails and
the value is refunded to the sender.
"""

import json
import re
import shutil
import subprocess
import time
from pathlib import Path

import genlayer_py.accounts as accounts
from genlayer_py.chains import studionet
from genlayer_py.client.client import create_client

HERE = Path(__file__).resolve().parent
GEN = 10**18

# A receiver with NO __receive__ and NO __handle_undefined_method__. Per the
# documented dispatch graph, a value-bearing message to it must error.
RECEIVER = """
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class Receiver(gl.Contract):
    def __init__(self):
        pass

    @gl.public.write.payable
    def poke(self) -> None:
        pass
"""

# The sender: records every refunded value it is handed.
SENDER = """
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class Sender(gl.Contract):
    refunded: u256
    calls: u256
    last_from: str

    def __init__(self):
        self.refunded = 0
        self.calls = 0
        self.last_from = ""

    @gl.public.write
    def top_up(self) -> None:
        pass

    @gl.public.write
    def send_internal(self, target: gl.Address) -> None:
        # Documented to error at the child: value, no method name, no __receive__.
        gl.get_contract_at(target).emit(value=self.balance, on="finalized")

    @gl.public.write.payable
    def __on_errored_message__(self):
        self.refunded = self.refunded + gl.message.value
        self.calls = self.calls + 1
        self.last_from = str(gl.message.sender_address)
"""


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
        time.sleep(5)
    return None, ""


def deploy(c, code, name):
    for i in range(1, 9):
        try:
            addr = dict(c.get_transaction_receipt(c.deploy_contract(code)))["to"]
            break
        except Exception as exc:
            if "rate limit" not in str(exc).lower() and "-32029" not in str(exc):
                raise
            time.sleep(20 * i)
    print(f"  {name:10} {addr}")
    for _ in range(20):
        try:
            c.get_contract_schema(addr)
            return addr
        except Exception:
            time.sleep(3)
    print(f"  {name}: schema never became available")
    return addr


def main():
    key = [l.split(b"=", 1)[1].decode("utf-8").strip()
           for l in (HERE / ".env").read_bytes().split(b"\n")
           if l.startswith(b"GENLAYER_DEV_KEY=")][0]
    acct = accounts.create_account(key)
    c = create_client(chain=studionet, account=acct)

    print("deploying:")
    receiver = deploy(c, RECEIVER, "receiver")
    sender = deploy(c, SENDER, "sender")

    def w(addr, method, args, value=0):
        ex, pl = receipt(c.write_contract(addr, method, account=acct, args=args,
                                          value=value))
        print(f"  {method:16} exec={ex} {('| ' + pl[:50]) if pl else ''}")
        return ex, pl

    def bal(a):
        return int(c.provider.make_request("eth_getBalance", [a, "latest"])["result"], 16)

    print("\nfunding the sender so it can carry value")
    w(sender, "top_up", [], value=GEN)
    print(f"  sender chain balance: {bal(sender)} wei")
    w(sender, "send_internal", [receiver])
    print(f"  sender chain balance after emit: {bal(sender)} wei")

    print("\nwaiting for the child transaction to fail and refund...")
    for i in range(12):
        time.sleep(10)
        refunded = c.read_contract(sender, "refunded", [])
        calls = c.read_contract(sender, "calls", [])
        print(f"  t+{(i+1)*10:3}s  refunded={refunded}  calls={calls}  "
              f"sender_balance={bal(sender)}")
        if calls > 0:
            print("\nRESULT: __on_errored_message__ FIRED")
            print(f"  refunded value : {refunded}")
            print(f"  calls          : {calls}")
            print(f"  came from      : {c.read_contract(sender, 'last_from', [])}")
            if refunded > 0:
                print("  => the value CAME BACK, through the contract's own callback")
            else:
                print("  => the hook fired but the value did NOT come back")
            return 0 if refunded > 0 else 1

    print("\nRESULT: the hook never fired within 120s")
    print("  sender refunded:", c.read_contract(sender, "refunded", []))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
