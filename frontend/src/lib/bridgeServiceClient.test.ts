// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { BridgeServiceClient } from './bridgeServiceClient';

function makeFetcher(body: unknown, status = 200, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response));
}

function makeNetworkErrorFetcher(): typeof fetch {
  return vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
}

const BASE = 'http://localhost:3001';

describe('BridgeServiceClient', () => {
  describe('getPrices', () => {
    it('returns typed price data on success', async () => {
      const payload = { xlmPerEth: 10000, ethUsd: 3500, xlmUsd: 0.35, solUsd: 150, staleness: 'fresh' };
      const client = new BridgeServiceClient(BASE, makeFetcher(payload));
      const result = await client.getPrices();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.ethUsd).toBe(3500);
        expect(result.data.xlmPerEth).toBe(10000);
        expect(result.status).toBe(200);
      }
    });

    it('classifies a network error as network_timeout', async () => {
      const client = new BridgeServiceClient(BASE, makeNetworkErrorFetcher());
      const result = await client.getPrices();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('network_timeout');
        expect(result.retryable).toBe(true);
      }
    });

    it('classifies HTTP 500 as provider_http_error', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({ error: 'internal' }, 500, false));
      const result = await client.getPrices();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('provider_http_error');
        expect(result.httpStatus).toBe(500);
        expect(result.retryable).toBe(true);
      }
    });

    it('classifies HTTP 429 as provider_http_error with retryable true', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({ message: 'rate limited' }, 429, false));
      const result = await client.getPrices();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
      }
    });
  });

  describe('createOrder', () => {
    it('returns order data on success', async () => {
      const payload = { orderId: 'ord-123', status: 'created' };
      const client = new BridgeServiceClient(BASE, makeFetcher(payload));
      const result = await client.createOrder({
        direction: 'eth_to_xlm',
        amount: '0.5',
        ethAddress: '0xabc',
        stellarAddress: 'GABC',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.orderId).toBe('ord-123');
      }
    });

    it('classifies HTTP 400 as provider_http_error with retryable false', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({ error: 'bad request' }, 400, false));
      const result = await client.createOrder({
        direction: 'eth_to_xlm',
        amount: '0',
        ethAddress: '',
        stellarAddress: '',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('provider_http_error');
        expect(result.httpStatus).toBe(400);
        expect(result.retryable).toBe(false);
      }
    });

    it('classifies a network failure on createOrder', async () => {
      const client = new BridgeServiceClient(BASE, makeNetworkErrorFetcher());
      const result = await client.createOrder({
        direction: 'eth_to_xlm',
        amount: '1',
        ethAddress: '0xabc',
        stellarAddress: 'GABC',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('network_timeout');
      }
    });
  });

  describe('processOrder', () => {
    it('returns status on success', async () => {
      const payload = { status: 'processing', stellarTxHash: 'stellar-abc' };
      const client = new BridgeServiceClient(BASE, makeFetcher(payload));
      const result = await client.processOrder({ orderId: 'ord-1', ethTxHash: '0xabc' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.status).toBe('processing');
        expect(result.data.stellarTxHash).toBe('stellar-abc');
      }
    });

    it('classifies HTTP 503 as network_timeout', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({ message: 'unavailable' }, 503, false));
      const result = await client.processOrder({ orderId: 'ord-1', ethTxHash: '0x1' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
      }
    });
  });

  describe('xlmToEth', () => {
    it('returns status on success', async () => {
      const payload = { status: 'processing', ethTxHash: '0xdef' };
      const client = new BridgeServiceClient(BASE, makeFetcher(payload));
      const result = await client.xlmToEth({ orderId: 'ord-1', stellarTxHash: 'xlm-abc' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.ethTxHash).toBe('0xdef');
      }
    });

    it('classifies network failure correctly', async () => {
      const client = new BridgeServiceClient(BASE, makeNetworkErrorFetcher());
      const result = await client.xlmToEth({ orderId: 'ord-1', stellarTxHash: 'xlm-1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('network_timeout');
    });
  });

  describe('announceOrder', () => {
    it('returns accepted status on success', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({ accepted: true }));
      const result = await client.announceOrder({
        orderId: 'ord-1',
        direction: 'eth_to_sol',
        solanaTxSignature: 'sig-123',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.accepted).toBe(true);
      }
    });
  });

  describe('getHistory', () => {
    it('returns transactions array on success', async () => {
      const payload = { transactions: [{ id: 'tx-1', txHash: '0xabc' }] };
      const client = new BridgeServiceClient(BASE, makeFetcher(payload));
      const result = await client.getHistory({ eth: '0x123', stellar: 'G123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.transactions).toHaveLength(1);
        expect(result.data.transactions[0]).toMatchObject({ id: 'tx-1' });
      }
    });

    it('returns empty array when transactions field is missing', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({}));
      const result = await client.getHistory({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.transactions).toEqual([]);
      }
    });

    it('classifies HTTP 503 as retryable', async () => {
      const client = new BridgeServiceClient(BASE, makeFetcher({ message: 'unavailable' }, 503, false));
      const result = await client.getHistory({ eth: '0x1' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(true);
      }
    });

    it('classifies network error as network_timeout', async () => {
      const client = new BridgeServiceClient(BASE, makeNetworkErrorFetcher());
      const result = await client.getHistory({ eth: '0x1' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('network_timeout');
      }
    });
  });
});
