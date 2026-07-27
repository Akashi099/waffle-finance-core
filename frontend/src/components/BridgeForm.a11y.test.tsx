// @vitest-environment jsdom
/**
 * Accessibility contract tests for the bridge form.
 *
 * These tests verify that ARIA structure, labelling, and live-region
 * semantics are present so the form is navigable by keyboard and
 * screen-reader users under normal conditions.
 */

import { render, screen, within, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import BridgeForm from './BridgeForm';

vi.mock('../config/networks', () => ({
  isTestnet: () => true,
  getCurrentNetwork: () => ({
    ethereum: { explorerUrl: 'https://sepolia.etherscan.io' },
    stellar: {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      explorerUrl: 'https://stellar.expert',
    },
  }),
}));

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const noopSign = async () => 'signed-xdr';

const flush = () => act(async () => { await Promise.resolve(); });

describe('BridgeForm accessibility', () => {
  beforeEach(() => {
    // Suppress fetch noise — the form attempts a price fetch on mount
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network offline'));
  });

  it('amount input is associated with the "You pay" label', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    const input = screen.getByLabelText(/you pay/i);
    expect(input).toBeInTheDocument();
    expect(input.tagName.toLowerCase()).toBe('input');
  });

  it('each route selector button exposes aria-pressed', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    const routeGroup = screen.getByRole('group', { name: /bridge route/i });
    const btns = within(routeGroup).getAllByRole('button');
    expect(btns.length).toBeGreaterThan(0);
    for (const btn of btns) {
      expect(btn).toHaveAttribute('aria-pressed');
    }
  });

  it('exactly one route button has aria-pressed="true"', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    const routeGroup = screen.getByRole('group', { name: /bridge route/i });
    const pressed = within(routeGroup)
      .getAllByRole('button')
      .filter(b => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
  });

  it('swap-direction button has an accessible name', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    const swapBtn = screen.getByRole('button', { name: /swap direction/i });
    expect(swapBtn).toBeInTheDocument();
  });

  it('status announcer region has aria-live="polite"', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toBeInTheDocument();
  });

  it('form-level error container uses aria-live="assertive" for assertive announcement', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    // The error container is present in the DOM even when empty so assistive
    // technology has a stable node to watch. Verify the live region is wired up.
    const assertiveRegion = document.querySelector('[aria-live="assertive"]');
    expect(assertiveRegion).toBeInTheDocument();
  });

  it('estimated receive panel is labelled for screen readers', async () => {
    render(<BridgeForm ethAddress={ETH} stellarAddress={XLM} signStellarTransaction={noopSign} />);
    await flush();
    const receiveLabel = screen.getByText(/you receive/i);
    expect(receiveLabel).toBeInTheDocument();
  });
});
