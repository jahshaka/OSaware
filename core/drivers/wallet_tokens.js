'use strict';

// ---------------------------------------------------------------------------
// WalletTokens  (drivers/wallet_tokens.js)
//
// Token-list discovery for the wallet driver. Keeps the on-disk surface
// small in wallet.js by isolating the "find every token the user holds"
// logic here.
//
// Strategy: fetch curated, audited token lists (Uniswap-format JSON) per
// chain from public URLs, cache in localStorage for 24h, then query each
// candidate token's balanceOf via the user's already-connected provider
// in parallel chunks. Non-zero balances merge into the wallet driver's
// existing token cache so the BASIC API (WALLET.TOKENS$, WALLET.TOKEN()
// etc.) returns the broader set transparently.
//
// Trade-offs:
//   - No third-party API key, no backend dependency.
//   - Depends on the curated list URLs staying available + CORS-friendly.
//   - Long-tail tokens not on any major DEX list still won't show.
// ---------------------------------------------------------------------------

// One URL per supported chain. Uniswap's default list covers Ethereum, Base,
// and Arbitrum (filtered by chainId field). PancakeSwap's extended list
// covers BNB Chain. All are EIP-2424 / Uniswap-standard JSON.
const TOKEN_LIST_URLS = {
    1:     'https://tokens.uniswap.org',
    8453:  'https://tokens.uniswap.org',
    42161: 'https://tokens.uniswap.org',
    56:    'https://tokens.pancakeswap.finance/pancakeswap-extended.json',
};

// 24h — token lists are slow-moving; refreshing daily keeps us current
// without hammering the source on every connect.
const TOKEN_LIST_TTL_MS = 24 * 60 * 60 * 1000;

// Chunk size for parallel balanceOf calls. Conservative default that
// most free-tier RPCs (including wallet-provided ones) tolerate.
const BALANCE_BATCH_SIZE = 40;

// Per-process in-memory cap on token-list size to keep huge lists (some
// have 5k+ entries) from blowing up memory and request budget.
const MAX_TOKENS_PER_CHAIN = 800;

// ERC-20 balanceOf(address) selector.
const ERC20_BALANCEOF_SEL = '0x70a08231';

class WalletTokens {

    constructor() {
        // In-memory cache: url -> { tokens, ts }. Avoids re-parsing the
        // same JSON when the user switches chains that share a list.
        this._memCache = new Map();
    }

    // Fetch + cache the token list for `chainId`. Returns an array of
    // { address, symbol, decimals, name } entries filtered to that chain.
    fetchTokenList(chainId) {
        const url = TOKEN_LIST_URLS[chainId];
        if (!url) return Promise.resolve([]);
        const memHit = this._memCache.get(url);
        if (memHit && (Date.now() - memHit.ts) < TOKEN_LIST_TTL_MS) {
            return Promise.resolve(this._filterByChain(memHit.tokens, chainId));
        }
        // localStorage cache.
        const lsKey = 'osaware:walletTokenList:' + url;
        try {
            const raw = localStorage.getItem(lsKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.ts && (Date.now() - parsed.ts) < TOKEN_LIST_TTL_MS) {
                    this._memCache.set(url, { tokens: parsed.tokens, ts: parsed.ts });
                    return Promise.resolve(this._filterByChain(parsed.tokens, chainId));
                }
            }
        } catch (_) { /* ignore — fall through to fetch */ }
        // Network fetch. Read paths must never throw — graceful empty on
        // CORS errors, DNS failures, malformed JSON, etc.
        return fetch(url, { cache: 'force-cache' })
            .then((r) => r.json())
            .then((j) => {
                const tokens = Array.isArray(j && j.tokens) ? j.tokens : [];
                this._memCache.set(url, { tokens, ts: Date.now() });
                try {
                    localStorage.setItem(lsKey, JSON.stringify({ tokens, ts: Date.now() }));
                } catch (_) { /* quota / private-mode — ignore */ }
                return this._filterByChain(tokens, chainId);
            })
            .catch(() => []);
    }

    _filterByChain(all, chainId) {
        const cid = Number(chainId);
        const out = [];
        for (const t of all) {
            if (!t || Number(t.chainId) !== cid) continue;
            if (!t.address || !t.symbol) continue;
            out.push({
                address:  String(t.address),
                symbol:   String(t.symbol),
                decimals: Number(t.decimals) || 18,
                name:     t.name ? String(t.name) : '',
            });
            if (out.length >= MAX_TOKENS_PER_CHAIN) break;
        }
        return out;
    }

    // Query balanceOf for each token in `tokens` for `address`. Calls
    // happen via providerCall(method, params) — the wallet driver's
    // allowlist-gated wrapper, so we never bypass its security model.
    // Returns a Map<symbol, {value, decimals, address}> with ONLY
    // non-zero balances.
    discoverBalances(providerCall, chainId, address) {
        return this.fetchTokenList(chainId).then((tokens) => {
            if (tokens.length === 0) return new Map();
            const paddedAddr = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
            const data = ERC20_BALANCEOF_SEL + paddedAddr;
            const found = new Map();
            // Sequential chunks so we don't slam the provider with
            // hundreds of parallel requests at once.
            let chain = Promise.resolve();
            for (let i = 0; i < tokens.length; i += BALANCE_BATCH_SIZE) {
                const chunk = tokens.slice(i, i + BALANCE_BATCH_SIZE);
                chain = chain.then(() => Promise.all(chunk.map((t) =>
                    providerCall('eth_call', [{ to: t.address, data }, 'latest'])
                        .then((hex) => {
                            const v = this._scaledFromHex(hex, t.decimals);
                            if (v > 0) {
                                // Upper-case symbol for case-insensitive
                                // lookup parity with the curated registry.
                                found.set(t.symbol.toUpperCase(), {
                                    value: v, decimals: t.decimals, address: t.address,
                                });
                            }
                        })
                        .catch(() => {})
                )));
            }
            return chain.then(() => found);
        });
    }

    _scaledFromHex(hex, decimals) {
        try {
            const big = BigInt(hex);
            const scale = BigInt(10) ** BigInt(decimals);
            const whole = big / scale;
            const frac  = big % scale;
            return Number(whole) + Number(frac) / Number(scale);
        } catch (_) { return 0; }
    }
}
