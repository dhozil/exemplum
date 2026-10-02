import { describe, expect, it } from 'vitest';

import { connectViaSnap, disconnect, signer } from '../lib/wallet';
import { clearWalletSelection, client } from '../lib/chain';

/**
 * The shape a signer has to be in.
 *
 * `genlayer-js` reads `senderAccount.address` on whatever it is handed. Handed a
 * bare address string, `.address` is `undefined`, and the failure arrives three
 * layers away as:
 *
 *     Address "undefined" is invalid. - Address must be a hex value of 20 bytes.
 *     Version: viem@2.56.9
 *
 * That reads like a checksum error about something the user typed, which is why
 * it was so hard to place. `validateAccount` only rejects a falsy value, so the
 * string sails past the SDK's own check and breaks in viem instead.
 */

const ADDRESS = '0x' + '33'.repeat(20);

describe('signer', () => {
  it('is an object with an address, never a bare string', async () => {
    disconnect();
    clearWalletSelection();
    (window as unknown as { ethereum?: unknown }).ethereum = {
      isRabby: true,
      request: async (r: { method: string }) => {
        if (r.method === 'eth_chainId') return '0x' + (61999).toString(16);
        if (r.method === 'eth_requestAccounts') return [ADDRESS];
        return null;
      },
    };

    await connectViaSnap('rabby');
    const s = (await signer()) as { address?: string };

expect(typeof s).toBe('object');
    expect(s.address).toBe(ADDRESS);
    // The exact failure: given a bare string, `.address` is undefined, and that is
    // the value viem rejects three layers further down.
    expect((s as { address?: string }).address).toBeDefined();
  });

  it('puts the same object shape on the client as on the signer', async () => {
    const s = (await signer()) as { address?: string };
    const onClient = (client as unknown as { account?: { address?: string } }).account;
    // Both are read the same way by the SDK, so they have to agree.
    expect(typeof onClient).toBe('object');
    expect(onClient?.address).toBe(s.address);
  });
});