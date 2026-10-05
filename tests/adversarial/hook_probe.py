"""Does __on_errored_message__ fire on StudioNet, and does the value come back?

    python hook_probe.py

The two official sources contradict each other on the point that matters most for
a payout contract:

  docs.genlayer.com, Value Transfers:
    "If the child transaction fails, the value is not automatically returned to
     the sender."

  sdk.genlayer.com, the __on_errored_message__ docstring:
    "This method is called when an emitted message with non-zero value fails
     during execution. By default, it simply accepts the refunded value."

Read together, the value does come back - but through the contract's own callback
rather than automatically. That is why NotarizedSettlement overrides the hook
instead of inferring delivery from its balance, and this probe is the measurement
that the inference is unnecessary.

Trigger: an INTERNAL message carrying value to an Intelligent Contract that
defines no __receive__ and no __handle_undefined_method__. The special-methods
dispatch diagram documents that path as an error - value present, no method name,
no __receive__ - so the child fails and the value is refunded to the sender.

Two things about deploying an inline contract, both learned the hard way here:

  * The `# { "Depends": ... }` header must be the FIRST line of the source. A
    leading newline - which is what a triple-quoted string naturally produces -
    means the header is not parsed, the deploy appears to succeed, and the
    contract is never indexed: every later call answers "Contract not found".
    Hence the `.lstrip()` on both sources below.
  * `from genlayer import *`, not `import genlayer as gl`. With the latter, bare
    names like `u256` are undefined, the class body raises at load time, and the
    deploy fails with a bare `exit_code 1`.

Prints PASS if the hook fired *and* value was returned, FAIL if the hook fired with
no value, and SKIP if it never fired within the window.
"""

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

HEADER = ('# { "Depends": '
          '"py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }')

# No __receive__, no __handle_undefined_method__. A value-bearing message to this
# must error, per the documented dispatch graph.
RECEIVER = """# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class Receiver(gl.Contract):
    def __init__(self):
        pass

    @gl.public.write.payable
    def poke(self) -> None:
        pass
""".lstrip()

SENDER = """# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *


class Sender(gl.Contract):
    refunded: u256
    calls: u256

    def __init__(self):
        self.refunded = 0
        self.calls = 0

    @gl.public.write.payable
    def top_up(self) -> None:
        pass

    @gl.public.write
    def send_internal(self, target: Address) -> None:
        gl.get_contract_at(target).emit(value=self.balance, on="finalized")

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
    for i in range(1, 9):
        try:
            tx = c.deploy_contract(code)
            break
        except Exception as exc:
            if "rate limit" not in str(exc).lower() and "-32029" not in str(exc):
                raise
            time.sleep(20 * i)
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
    print(f"  {name:9} {addr}  exec={ex} schema={'OK' if ok else 'UNAVAILABLE'} "
          f"{pl[:60]}")
    if not ok:
        raise SystemExit(f"{name} never indexed; deploy payload was: {pl}")
    return addr


def main() -> int:
    key = [l.split(b"=", 1)[1].decode("utf-8").strip()
           for l in (HERE / ".env").read_bytes().split(b"\n")
           if l.startswith(b"GENLAYER_DEV_KEY=")][0]
    acct = accounts.create_account(key)
    c = create_client(chain=studionet, account=acct)

    print("deploying:")
    receiver = deploy(c, RECEIVER, "receiver")
    sender = deploy(c, SENDER, "sender")

    def w(addr, method, args, value=0):
        ex, pl = receipt(c.write_contract(addr, method, account=acct,
                                          args=args, value=value))
        print(f"  {method:16} exec={ex} {('| ' + pl[:50]) if pl else ''}")
        return ex, pl

    def bal(a):
        return int(c.provider.make_request("eth_getBalance", [a, "latest"])["result"], 16)

    # The concrete, reportable fact: the hook is published, not just inherited.
    schema = c.get_contract_schema(sender)
    methods = schema.get("methods", {})
    hook_published = "__on_errored_message__" in methods
    print(f"\n__on_errored_message__ published in the on-chain schema: "
          f"{hook_published}  ({len(methods)} methods)")

    print("\nfunding the sender so it can carry value")
    w(sender, "top_up", [], value=GEN)
    funded = bal(sender)
    print(f"  sender chain balance: {funded} wei")

    print("\nemitting a value-bearing message to a contract that cannot receive it")
    w(sender, "send_internal", [receiver])
    print(f"  sender chain balance after emit: {bal(sender)} wei")

    print("\nwaiting for the child to fail and the value to come back...")
    for i in range(12):
        time.sleep(10)
        refunded = c.read_contract(sender, "refunded_amount", [])
        calls = c.read_contract(sender, "hook_calls", [])
        print(f"  t+{(i + 1) * 10:3}s  refunded={refunded}  calls={calls}  "
              f"sender_balance={bal(sender)}")
        if calls > 0:
            print("\nRESULT: __on_errored_message__ FIRED")
            print(f"  refunded value : {refunded}")
            if refunded > 0:
                print("  => the value CAME BACK, through the contract's own callback.")
                print("  => NotarizedSettlement overriding the hook is sufficient; "
                      "no balance inference is needed to detect a failed payout.")
                return 0
            print("  => the hook fired but the value did NOT come back.")
            print("  => docs.genlayer.com was right; a failed payout destroys value.")
            return 1

    print("\nRESULT: SKIP - the hook never fired within 120s")
    print("  This trigger does not produce a failing child on StudioNet, so the")
    print("  question stays open and the override stands on the SDK's own wording.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())