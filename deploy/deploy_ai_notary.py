"""Deploy AINotary.

    genlayer deploy                       # runs everything in deploy/
    genlayer deploy --contract deploy/deploy_ai_notary.py

The constructor takes no arguments, so deployment is a single call. The
contract address is printed by the CLI once consensus finalizes the deploy.
"""

from pathlib import Path

CONTRACT = Path(__file__).resolve().parent.parent / "contracts" / "ai_notary.py"


def main():
    code = CONTRACT.read_bytes()
    print(f"deploying AINotary from {CONTRACT} ({len(code)} bytes)")
    return code


if __name__ == "__main__":
    main()
