import { useState, useEffect, useRef } from 'react';
import { normalizeAsset, type NormalizedAsset, type SupportedChain } from '../lib/assetNormalization';

// Re-export NormalizedAsset under the legacy name so existing import sites
// continue to work without changes while new code uses NormalizedAsset directly.
export type Token = NormalizedAsset;
export type { NormalizedAsset };

interface TokenSelectorProps {
  selectedToken?: NormalizedAsset;
  onSelectToken: (token: NormalizedAsset) => void;
  chain?: SupportedChain | 'all';
  label?: string;
}

const RAW_TOKEN_LIST: Array<{
  chain: SupportedChain;
  symbol: string;
  name: string;
  logo: string;
  balance?: string;
  address?: string;
  decimals: number;
}> = [
  { chain: 'ethereum', symbol: 'ETH', name: 'Ethereum',      logo: '/images/eth.png', balance: '1.5',   decimals: 18 },
  { chain: 'ethereum', symbol: 'USDC', name: 'USD Coin',     logo: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png', balance: '500',  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6  },
  { chain: 'ethereum', symbol: 'WBTC', name: 'Wrapped Bitcoin', logo: 'https://cryptologos.cc/logos/wrapped-bitcoin-wbtc-logo.png', balance: '0.05', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8  },
  { chain: 'stellar',  symbol: 'XLM',  name: 'Stellar Lumens', logo: '/images/xlm.png', balance: '1000', decimals: 7  },
  { chain: 'stellar',  symbol: 'yXLM', name: 'Yield XLM',    logo: '/images/xlm.png', balance: '500',  address: 'GDLQY5ZKDPZWVHWCFSYCBWFPXQTDLJDKTRAOWJGZGQW5KGZFJ3IJIPT', decimals: 7  },
  { chain: 'stellar',  symbol: 'USDC', name: 'USD Coin',     logo: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.png', balance: '250',  address: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', decimals: 6  },
  { chain: 'solana',   symbol: 'SOL',  name: 'Solana',       logo: '/images/sol.svg',  balance: '2.5',  decimals: 9  },
];

// Pre-normalise the full token list once at module load time. Each token gets a
// stable canonicalId that uniquely identifies it across chains, preventing the
// USDC-on-Ethereum / USDC-on-Stellar collision that would occur with symbol-only
// comparisons.
const NORMALISED_TOKENS: Array<NormalizedAsset & { balance?: string }> = RAW_TOKEN_LIST.map(
  ({ balance, ...raw }) => ({ ...normalizeAsset(raw), balance }),
);

export default function TokenSelector({
  selectedToken,
  onSelectToken,
  chain = 'all',
  label = 'Select Token',
}: TokenSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [tokens, setTokens] = useState<Array<NormalizedAsset & { balance?: string }>>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter the normalised token list by chain whenever the `chain` prop changes.
  // Using canonicalIds as keys guarantees deterministic deduplication even when
  // the same symbol appears on multiple chains.
  useEffect(() => {
    const filtered =
      chain === 'all'
        ? NORMALISED_TOKENS
        : NORMALISED_TOKENS.filter((t) => t.chain === chain);
    setTokens(filtered);
  }, [chain]);

  // Collapse the dropdown when the user clicks outside.
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filter by query against symbol, name, and address. The query is compared
  // against the normalised symbol (upper-case) so "usdc" matches "USDC".
  const filteredTokens = tokens.filter((token) => {
    const q = searchQuery.toLowerCase();
    return (
      token.symbol.toLowerCase().includes(q) ||
      token.name.toLowerCase().includes(q) ||
      token.address?.toLowerCase().includes(q)
    );
  });

  const handleSelectToken = (token: NormalizedAsset & { balance?: string }) => {
    onSelectToken(token);
    setIsOpen(false);
    setSearchQuery('');
  };

  const chainLabel = (c: SupportedChain): string => {
    if (c === 'ethereum') return 'Ethereum';
    if (c === 'stellar') return 'Stellar';
    return 'Solana';
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <label className="block text-sm font-medium text-gray-300 mb-1">
        {label}
      </label>

      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-lg border border-cyan-200/[0.18] bg-white/[0.055] px-4 py-3 text-white transition-colors hover:border-cyan-200/35 hover:bg-cyan-200/10"
      >
        {selectedToken ? (
          <div className="flex items-center">
            {selectedToken.logo && (
              <img src={selectedToken.logo} alt={selectedToken.symbol} className="w-6 h-6 mr-2 rounded-full" />
            )}
            <span>{selectedToken.symbol}</span>
            {(selectedToken as NormalizedAsset & { balance?: string }).balance && (
              <span className="ml-2 text-sm text-gray-400">
                ({(selectedToken as NormalizedAsset & { balance?: string }).balance})
              </span>
            )}
          </div>
        ) : (
          <span className="text-gray-400">Select a token</span>
        )}
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-cyan-200/20 bg-[#070b1c]/95 shadow-2xl backdrop-blur-xl">
          <div className="p-3 border-b border-white/10">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search token name or address"
              className="w-full rounded-lg border border-cyan-200/[0.18] bg-white/[0.055] px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-200/40"
              autoFocus
            />
          </div>

          <div className="max-h-60 overflow-y-auto">
            {filteredTokens.length === 0 ? (
              <div className="p-4 text-center text-gray-400">No tokens found</div>
            ) : (
              filteredTokens.map((token) => (
                <button
                  key={token.canonicalId}
                  type="button"
                  onClick={() => handleSelectToken(token)}
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0"
                >
                  <div className="flex items-center">
                    {token.logo && (
                      <img src={token.logo} alt={token.symbol} className="w-8 h-8 mr-3 rounded-full" />
                    )}
                    <div className="text-left">
                      <div className="font-medium text-white">{token.symbol}</div>
                      <div className="text-xs text-gray-400">{token.name}</div>
                    </div>
                  </div>

                  {token.balance && (
                    <div className="text-right">
                      <div className="text-sm text-white">{token.balance}</div>
                      <div className="text-xs text-gray-400">{chainLabel(token.chain)}</div>
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
