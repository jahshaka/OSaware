'use strict';

import * as C from '../constants.js';
import { WalletTokens } from './wallet_tokens.js';


// ---------------------------------------------------------------------------
// WalletDriver  (drivers/wallet.js)
//
// Stage 1 of OSAWARE's browser-extension wallet integration. Owns:
//   - EIP-6963 multi-wallet discovery
//   - EIP-1193 provider calls (allowlist-gated)
//   - Ethereum-mainnet network whitelist
//   - Read-only address / native-balance / ERC-20-balance access
//   - Provider event subscriptions (accountsChanged / chainChanged)
//
// What this DOES NOT do (by design — see docs/OSaware Wallet.pdf):
//   - WalletConnect v2 / mobile wallets / QR codes / relay servers
//   - Signing or transaction-sending of any kind
//   - L2 / sidechain / non-mainnet networks
//   - NFT enumeration
//
// Wired into Interpreter.prototype via the mixin block at the bottom of this
// file. Mirrors the pattern used by gfx.js / gl3d.js.
// ---------------------------------------------------------------------------

// Network whitelist. One config entry per supported chain.
// `name`     — human label.
// `symbol`   — native gas-token ticker (ETH / BNB / etc).
// `explorer` — block explorer for future deep-links.
const WALLET_NETWORKS = {
    1:     { name: 'Ethereum',     symbol: 'ETH', explorer: 'https://etherscan.io' },
    56:    { name: 'BNB Chain',    symbol: 'BNB', explorer: 'https://bscscan.com' },
    8453:  { name: 'Base',         symbol: 'ETH', explorer: 'https://basescan.org' },
    42161: { name: 'Arbitrum One', symbol: 'ETH', explorer: 'https://arbiscan.io' },
};

// ERC-20 token registry, per chain. Fixed in source — prevents a hostile
// BASIC program from declaring a fake "USDC" that points at a malicious
// contract. Adding a token is one entry per chain.
//
// Notes:
//   - BNB Chain stablecoins use 18 decimals (NOT 6 like on Ethereum).
//   - Each chain's "wrapped native" varies (WETH on Ethereum/Base/Arbitrum,
//     WBNB on BNB Chain).
//   - WETH on BNB Chain is bridged Ethereum-ETH, not native.
const WALLET_TOKENS = {
    1: [
        { symbol: 'USDC', addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
        { symbol: 'USDT', addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
        { symbol: 'DAI',  addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
        { symbol: 'WETH', addr: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
        { symbol: 'WBTC', addr: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8  },
        { symbol: 'LINK', addr: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
        { symbol: 'UNI',  addr: '0x1f9840a85d5aF5bf1D1762F925BdAdDC4201F984', decimals: 18 },
    ],
    56: [
        { symbol: 'USDT', addr: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
        { symbol: 'USDC', addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
        { symbol: 'DAI',  addr: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18 },
        { symbol: 'WBNB', addr: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
        { symbol: 'ETH',  addr: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
        { symbol: 'BTCB', addr: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
        { symbol: 'CAKE', addr: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
    ],
    8453: [
        { symbol: 'USDC',  addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6  },
        { symbol: 'DAI',   addr: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
        { symbol: 'WETH',  addr: '0x4200000000000000000000000000000000000006', decimals: 18 },
        { symbol: 'cbETH', addr: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', decimals: 18 },
    ],
    42161: [
        { symbol: 'USDC', addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6  },
        { symbol: 'USDT', addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6  },
        { symbol: 'DAI',  addr: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
        { symbol: 'WETH', addr: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
        { symbol: 'WBTC', addr: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8  },
        { symbol: 'ARB',  addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
    ],
};

// Provider methods the driver is allowed to forward. Anything not in this set
// throws — this keeps Stage 1 strictly read-only and makes it a code-review
// flag if anyone tries to add signing/sending.
const WALLET_METHOD_ALLOWLIST = new Set([
    'eth_requestAccounts',
    'eth_accounts',
    'eth_chainId',
    'eth_getBalance',
    'eth_call',
    // EIP-2255 — REVOKES OSAWARE's permission on the wallet side so the
    // next eth_requestAccounts forces a fresh popup. Used by
    // WALLETDISCONNECT. Cannot move funds.
    'wallet_revokePermissions',
    // EIP-3326 — asks the wallet to switch its active chain. User must
    // approve in the wallet UI. Cannot sign or move funds. Used by
    // WALLETSWITCH so a BASIC program can prompt the user to switch to a
    // different supported network and re-read balances.
    'wallet_switchEthereumChain',
]);

// Token-balance read cache TTL (ms). Short — wallets refresh fast.
const WALLET_TOKEN_TTL_MS = 4000;

// Auto-disconnect after the tab has been hidden continuously for this many
// ms. Set long enough that a game or demo running in the foreground but
// briefly tabbed-out doesn't drop the user's session.
const WALLET_IDLE_DISCONNECT_MS = 30 * 60 * 1000;   // 30 minutes

export class WalletDriver {

    constructor(host) {
        this._host = host;

        // EIP-6963 provider list. Populated by _walletInit() on first use.
        // Each entry: { info: {name, icon, rdns, uuid}, provider }.
        this._providers = [];
        this._discovered = false;

        // Token-list discovery (Uniswap-format JSON + chunked balanceOf).
        // Lives in core/drivers/wallet_tokens.js so wallet.js stays focused
        // on the connect/permission flow.
        this._tokens = (typeof WalletTokens !== 'undefined') ? new WalletTokens() : null;
    }

    appendLine(t, n) { return this._host.appendLine(t, n); }

    // ── EIP-6963 discovery ────────────────────────────────────────────────
    // Listen first, THEN dispatch the request. Wallets respond synchronously
    // in the same event loop tick, so a tiny setTimeout(0) gives them a beat.
    _walletInit() {
        if (this._discovered) return;
        this._discovered = true;
        this._providers = [];
        const onAnnounce = (e) => {
            // Dedupe by rdns — extensions sometimes announce multiple times.
            const d = e.detail;
            if (!d || !d.info || !d.provider) return;
            const rdns = d.info.rdns || d.info.uuid || d.info.name;
            if (this._providers.some(p => (p.info.rdns || p.info.uuid || p.info.name) === rdns)) return;
            this._providers.push(d);
        };
        window.addEventListener('eip6963:announceProvider', onAnnounce);
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        // Keep listening for late announcers (some wallets are slow to inject).
        // No removeEventListener — the OSAWARE page is single-document.
    }

    // ── Picker UX ─────────────────────────────────────────────────────────
    // Auto-select if 0 or 1 provider. For >1, print a numbered menu and use
    // GETKEY() via the interpreter's input flow. cb(err, providerRecord).
    _walletPickProvider(cb) {
        this._walletInit();
        // Race window — give wallets one extra tick to announce.
        setTimeout(() => {
            let providers = this._providers.slice();
            // Legacy fallback: if EIP-6963 returned nothing but window.ethereum
            // exists, synthesise a provider entry.
            if (providers.length === 0 && typeof window !== 'undefined' &&
                window.ethereum && typeof window.ethereum.request === 'function') {
                providers = [{
                    info: { name: 'Browser Wallet', rdns: 'legacy', uuid: 'legacy' },
                    provider: window.ethereum,
                }];
            }
            if (providers.length === 0) {
                cb('No wallet extension detected. Install MetaMask, Rabby, or Coinbase Wallet.', null);
                return;
            }
            if (providers.length === 1) { cb(null, providers[0]); return; }
            // Multi-wallet picker. Print menu and read a single keypress.
            const host = this._host;
            host.appendLine('Pick a wallet:', 1);
            providers.forEach((p, i) => host.appendLine('  ' + (i + 1) + '. ' + p.info.name, 1));
            host.appendLine('Press 1-' + providers.length + ' (Esc to cancel):', 1);
            const tryKey = () => {
                if (typeof host._walletPickKey === 'function') host._walletPickKey();
                host._walletPickerCb = (k) => {
                    if (k === 27) { cb('User cancelled.', null); return; }
                    const idx = k - 49; // '1' is 49
                    if (idx >= 0 && idx < providers.length) cb(null, providers[idx]);
                    else { host.appendLine('Invalid choice. Press 1-' + providers.length + ' (Esc to cancel):', 1); tryKey(); }
                };
                host.want_keypress = 1;
                host._walletWaitingKey = true;
            };
            tryKey();
        }, 30);
    }

    // ── Allowlist-gated provider call ─────────────────────────────────────
    _walletProviderCall(provider, method, params) {
        if (!WALLET_METHOD_ALLOWLIST.has(method)) {
            return Promise.reject(new Error('Method not allowed in Stage 1: ' + method));
        }
        return provider.request({ method, params: params || [] });
    }

    // ── WALLETCONNECT ─────────────────────────────────────────────────────
    cmdWALLETCONNECT() {
        const host = this._host;
        if (host._walletPending) return C.CMD_OK;
        host._walletPending = true;
        host.appendLine('Opening your wallet extension...', 1);

        // Capture the ProcessMemory this call started in. Every async step
        // checks `host._mem === memAtStart` before touching state — so if
        // BREAK runs and a new RUN swaps memory, the late callback is a
        // no-op and can't strand the next program with _walletPending=true.
        const memAtStart = host._mem;
        const aliveCheck = () => host._mem === memAtStart;

        const resume = () => {
            if (!aliveCheck()) return;
            host._walletPending = false;
            if (host.running) host.tick(1);
        };

        this._walletPickProvider((err, rec) => {
            if (!aliveCheck()) return;
            if (err) {
                host.appendLine(err, 1);
                resume();
                return;
            }
            const provider = rec.provider;
            // Request accounts. This is what triggers the extension popup.
            this._walletProviderCall(provider, 'eth_requestAccounts', [])
                .then((accounts) => {
                    if (!aliveCheck()) return;
                    if (!accounts || accounts.length === 0) {
                        host.appendLine('No accounts returned.', 1);
                        resume();
                        return;
                    }
                    const address = accounts[0];
                    return this._walletProviderCall(provider, 'eth_chainId', [])
                        .then((chainIdHex) => {
                            if (!aliveCheck()) return;
                            const chainId = parseInt(chainIdHex, 16) || 0;
                            const net = WALLET_NETWORKS[chainId];
                            if (!net) {
                                const supported = Object.values(WALLET_NETWORKS).map(n => n.name).join(', ');
                                host.appendLine('Wallet is on chain ' + chainId + '. OSAWARE supports: ' + supported + '.', 1);
                                host.appendLine('Switch network in your wallet, then re-run WALLETCONNECT.', 1);
                                resume();
                                return;
                            }
                            // Confirm-on-connect: show what we're about to bind
                            // and require an explicit Y/N — defeats silent
                            // auto-approval and forces user intent every time.
                            host.appendLine('', 1);
                            host.appendLine('Wallet ready to bind:', 1);
                            host.appendLine('  Address : ' + address, 1);
                            host.appendLine('  Network : ' + net.name + ' (chain ' + chainId + ')', 1);
                            host.appendLine('  Source  : ' + rec.info.name, 1);
                            host.appendLine('Approve? (Y/N)', 1);
                            this._walletAwaitConfirm((approved) => {
                                if (!aliveCheck()) return;
                                if (!approved) {
                                    host.appendLine('Connection declined.', 1);
                                    resume();
                                    return;
                                }
                                // Bind. Subscribe to provider events. Start idle watch.
                                host._walletAddress  = address;
                                host._walletChainId  = chainId;
                                host._walletProvider = rec;
                                this._walletAttachEvents(provider);
                                this._walletSetupIdleWatch();
                                host.appendLine('Connected. Fetching balances...', 1);
                                this._walletPrefetch(provider).then(() => {
                                    if (!aliveCheck()) return;
                                    host.appendLine('Balances ready.', 1);
                                    resume();
                                });
                            });
                        });
                })
                .catch((e) => {
                    if (!aliveCheck()) return;
                    const msg = (e && e.message) ? e.message : String(e);
                    // User-rejection error codes: MetaMask uses code 4001.
                    if (e && (e.code === 4001 || /reject/i.test(msg))) {
                        host.appendLine('User rejected connection.', 1);
                    } else {
                        host.appendLine('Wallet connect failed: ' + msg, 1);
                    }
                    resume();
                });
        });

        return C.CMD_OK;
    }

    // ── WALLETDISCONNECT ──────────────────────────────────────────────────
    // Tells the wallet to forget our origin (EIP-2255 wallet_revokePermissions
    // — supported by MetaMask, Rabby, Coinbase Wallet, others). Then clears
    // local state. After this, the NEXT WALLETCONNECT forces a fresh popup;
    // the wallet won't auto-approve us anymore even after a hard reload.
    cmdWALLETDISCONNECT() {
        const host = this._host;
        if (!host._walletAddress) {
            host.appendLine('No wallet connected.', 1);
            return C.CMD_OK;
        }
        host._walletPending = true;
        const provider = host._walletProvider ? host._walletProvider.provider : null;
        const finish = (revoked) => {
            this._walletDetachEvents();
            this._walletTeardownIdleWatch();
            host._walletAddress = '';
            host._walletChainId = 0;
            host._walletProvider = null;
            host._walletBalanceCache = null;
            if (host._walletTokenCache) host._walletTokenCache.clear();
            if (revoked) {
                host.appendLine('Wallet disconnected. The wallet was told to forget OSAWARE.', 1);
                host.appendLine('Next connect will require a fresh approval.', 1);
            } else {
                host.appendLine('Wallet disconnected from OSAWARE (local state cleared).', 1);
                host.appendLine('Your wallet may still auto-approve OSAWARE on next connect.', 1);
                host.appendLine('Revoke via your wallet\'s Connected Sites menu for a hard disconnect.', 1);
            }
            host._walletPending = false;
            if (host.running) host.tick(1);
        };
        if (!provider) { finish(false); return C.CMD_OK; }
        // Best-effort revoke. Older wallets / wallets without EIP-2255 support
        // throw method-not-found — fall through to local-clear-only.
        this._walletProviderCall(provider, 'wallet_revokePermissions',
            [{ eth_accounts: {} }])
            .then(() => finish(true))
            .catch(() => finish(false));
        return C.CMD_OK;
    }

    // ── WALLETSWITCH chainIdOrName ────────────────────────────────────────
    // Asks the wallet to switch its active network. Accepts either:
    //   numeric chain ID (e.g. 8453), or
    //   case-insensitive network name (e.g. "Base", "Arbitrum One").
    // The wallet pops up an "Approve network switch?" UI. On approval, the
    // wallet emits chainChanged; our existing onChain handler refetches all
    // balances for the new chain automatically.
    cmdWALLETSWITCH(param) {
        const host = this._host;
        if (!host._walletAddress || !host._walletProvider) {
            host.appendLine('No wallet connected. Connect first.', 1);
            return C.CMD_OK;
        }
        const raw = String(param == null ? '' : param).trim();
        if (!raw) {
            host.appendLine('Usage: WALLETSWITCH <chainId | "Name">', 1);
            return C.CMD_OK;
        }
        // Resolve target chain ID from either a number or a name.
        let targetId = 0;
        const asNum = Number(raw);
        if (!Number.isNaN(asNum) && asNum > 0) {
            targetId = asNum;
        } else {
            const wanted = raw.replace(/^"|"$/g, '').trim().toLowerCase();
            for (const [cidStr, net] of Object.entries(WALLET_NETWORKS)) {
                if (net.name.toLowerCase() === wanted) { targetId = Number(cidStr); break; }
            }
        }
        if (!targetId || !WALLET_NETWORKS[targetId]) {
            const supported = Object.entries(WALLET_NETWORKS)
                .map(([cid, n]) => n.name + ' (' + cid + ')').join(', ');
            host.appendLine('Unknown or unsupported chain: ' + raw, 1);
            host.appendLine('Supported: ' + supported, 1);
            return C.CMD_OK;
        }
        if (targetId === host._walletChainId) {
            host.appendLine('Already on ' + WALLET_NETWORKS[targetId].name + '.', 1);
            return C.CMD_OK;
        }
        if (host._walletPending) return C.CMD_OK;
        host._walletPending = true;
        const provider = host._walletProvider.provider;
        const memAtStart = host._mem;
        const aliveCheck = () => host._mem === memAtStart;
        const resume = () => {
            if (!aliveCheck()) return;
            host._walletPending = false;
            if (host.running) host.tick(1);
        };
        host.appendLine('Asking wallet to switch to ' + WALLET_NETWORKS[targetId].name + '...', 1);
        // chainId param is hex per EIP-3326.
        const hexId = '0x' + targetId.toString(16);
        this._walletProviderCall(provider, 'wallet_switchEthereumChain', [{ chainId: hexId }])
            .then(() => {
                if (!aliveCheck()) return;
                host.appendLine('Switched. Refreshing balances...', 1);
                // Confirm the new chain ID, clear caches, and wait for the
                // prefetch to complete BEFORE resuming BASIC — otherwise the
                // next BASIC statement reads stale 0s.
                return this._walletProviderCall(provider, 'eth_chainId', [])
                    .then((hex) => {
                        if (!aliveCheck()) return;
                        host._walletChainId = parseInt(hex, 16) || 0;
                        host._walletBalanceCache = null;
                        if (host._walletTokenCache) host._walletTokenCache.clear();
                        return this._walletPrefetch(provider);
                    })
                    .then(() => {
                        if (!aliveCheck()) return;
                        host.appendLine('Ready.', 1);
                        resume();
                    });
            })
            .catch((e) => {
                if (!aliveCheck()) return;
                const msg = (e && e.message) ? e.message : String(e);
                if (e && e.code === 4902) {
                    host.appendLine('Wallet has not added ' + WALLET_NETWORKS[targetId].name + ' yet.', 1);
                    host.appendLine('Add the network in your wallet, then re-run WALLETSWITCH.', 1);
                } else if (e && (e.code === 4001 || /reject/i.test(msg))) {
                    host.appendLine('Switch declined.', 1);
                } else {
                    host.appendLine('Switch failed: ' + msg, 1);
                }
                resume();
            });
        return C.CMD_OK;
    }

    // ── WALLETREFRESH ─────────────────────────────────────────────────────
    // Force a re-fetch of ETH + all token balances. Useful when the user
    // expects an on-chain change (e.g. just received a transfer) while the
    // program is still running. Blocks via _walletPending until done.
    cmdWALLETREFRESH() {
        const host = this._host;
        if (!host._walletAddress || !host._walletProvider) {
            host.appendLine('No wallet connected.', 1);
            return C.CMD_OK;
        }
        if (host._walletPending) return C.CMD_OK;
        host._walletPending = true;
        const resume = () => { host._walletPending = false; if (host.running) host.tick(1); };
        this._walletPrefetch(host._walletProvider.provider)
            .then(() => resume(), () => resume());
        return C.CMD_OK;
    }

    // ── Prefetch — populate balance caches in parallel ────────────────────
    // Called once on successful connect (and again on chain/account changes
    // via the event handlers) so that BASIC reads are always cache hits.
    // Also fans out to every whitelisted chain via its public RPC so the
    // combined-cache (used by wallet.AllTokens$) is populated regardless of
    // which chain the wallet itself is currently pointed at.
    _walletPrefetch(provider) {
        const host = this._host;
        if (!host._walletAddress) return Promise.resolve();
        const addr = host._walletAddress;
        const tokens = WALLET_TOKENS[host._walletChainId] || [];
        if (!host._walletTokenCache) host._walletTokenCache = new Map();

        const ethFetch = this._walletProviderCall(provider, 'eth_getBalance', [addr, 'latest'])
            .then((wei) => { host._walletBalanceCache = { value: this._weiToEth(wei), ts: Date.now() }; })
            .catch(() => { /* read paths never throw to BASIC */ });

        const sel = '0x70a08231';   // ERC-20 balanceOf(address) selector
        const paddedAddr = addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
        const tokenFetches = tokens.map((tok) =>
            this._walletProviderCall(provider, 'eth_call',
                [{ to: tok.addr, data: sel + paddedAddr }, 'latest'])
                .then((hex) => {
                    host._walletTokenCache.set(tok.symbol, {
                        value: this._scaledFromHex(hex, tok.decimals),
                        ts: Date.now(),
                    });
                })
                .catch(() => {})
        );

        // Broad discovery: fetch the curated token list (cached 24h) and
        // query balanceOf for every token on this chain in parallel chunks.
        // Non-zero results merge into _walletTokenCache so the BASIC API
        // (WALLET.TOKENS$, WALLET.TOKEN()) transparently sees them.
        const discoveryFetch = this._tokens
            ? this._tokens.discoverBalances(
                (m, p) => this._walletProviderCall(provider, m, p),
                host._walletChainId,
                addr,
            ).then((found) => {
                for (const [sym, info] of found) {
                    host._walletTokenCache.set(sym, { value: info.value, ts: Date.now() });
                }
            }).catch(() => {})
            : Promise.resolve();

        return Promise.all([ethFetch, discoveryFetch].concat(tokenFetches));
    }

    // ── Provider event subscriptions ──────────────────────────────────────
    _walletAttachEvents(provider) {
        this._walletDetachEvents();
        const host = this._host;
        const onAccounts = (accounts) => {
            if (!accounts || accounts.length === 0) {
                host._walletAddress = '';
                host._walletBalanceCache = null;
                if (host._walletTokenCache) host._walletTokenCache.clear();
                host.appendLine('Wallet account disconnected.', 1);
                return;
            }
            host._walletAddress = accounts[0];
            host._walletBalanceCache = null;
            if (host._walletTokenCache) host._walletTokenCache.clear();
            // Re-prefetch in background — keeps caches warm for BASIC reads.
            this._walletPrefetch(provider).catch(() => {});
        };
        const onChain = (chainIdHex) => {
            const chainId = parseInt(chainIdHex, 16) || 0;
            const net = WALLET_NETWORKS[chainId];
            host._walletBalanceCache = null;
            if (host._walletTokenCache) host._walletTokenCache.clear();
            if (!net) {
                host._walletAddress = '';
                host._walletChainId = 0;
                host.appendLine('Wallet switched to unsupported network.', 1);
                return;
            }
            host._walletChainId = chainId;
            this._walletPrefetch(provider).catch(() => {});
        };
        if (typeof provider.on === 'function') {
            provider.on('accountsChanged', onAccounts);
            provider.on('chainChanged', onChain);
            host._walletEvents = { provider, onAccounts, onChain };
        }
    }

    _walletDetachEvents() {
        const host = this._host;
        const ev = host._walletEvents;
        if (!ev) return;
        try {
            if (typeof ev.provider.removeListener === 'function') {
                ev.provider.removeListener('accountsChanged', ev.onAccounts);
                ev.provider.removeListener('chainChanged', ev.onChain);
            }
        } catch (_) { /* ignore */ }
        host._walletEvents = null;
    }

    // ── Reads ─────────────────────────────────────────────────────────────
    // These are sync from BASIC's perspective: the driver caches what it can
    // and returns the cached value. BASIC programs that need fresh data can
    // re-run WALLETCONNECT or wait for a chainChanged/accountsChanged event.
    walletAddress() {
        return this._host._walletAddress || '';
    }
    walletNetworkName() {
        const cid = this._host._walletChainId;
        const net = WALLET_NETWORKS[cid];
        return net ? net.name : '';
    }
    walletSymbol() {
        const cid = this._host._walletChainId;
        const net = WALLET_NETWORKS[cid];
        return net ? net.symbol : '';
    }
    walletChainId() {
        return Number(this._host._walletChainId || 0);
    }
    walletConnected() {
        return this._host._walletAddress ? 1 : 0;
    }

    // ETH balance — async-fetched, cached on the interpreter. Returns the
    // last known value immediately and kicks off a refresh in the background.
    walletBalance() {
        const host = this._host;
        if (!host._walletAddress || !host._walletProvider) return 0;
        const now = Date.now();
        const cached = host._walletBalanceCache;
        if (cached && (now - cached.ts) < WALLET_TOKEN_TTL_MS) return cached.value;
        const cachedValue = cached ? cached.value : 0;
        // Mark a refresh in-flight so we don't queue parallel calls.
        if (!host._walletBalanceFetching) {
            host._walletBalanceFetching = true;
            this._walletProviderCall(host._walletProvider.provider, 'eth_getBalance', [host._walletAddress, 'latest'])
                .then((wei) => {
                    const eth = this._weiToEth(wei);
                    host._walletBalanceCache = { value: eth, ts: Date.now() };
                })
                .catch(() => { /* silent — read paths must never throw to BASIC */ })
                .then(() => { host._walletBalanceFetching = false; });
        }
        return cachedValue;
    }

    // ERC-20 balanceOf via eth_call.
    walletToken(symbol) {
        const host = this._host;
        if (!host._walletAddress || !host._walletProvider) return 0;
        const sym = String(symbol || '').toUpperCase();
        const tokens = WALLET_TOKENS[host._walletChainId] || [];
        const tok = tokens.find(t => t.symbol === sym);
        if (!tok) return 0;
        const now = Date.now();
        if (!host._walletTokenCache) host._walletTokenCache = new Map();
        const cached = host._walletTokenCache.get(sym);
        if (cached && (now - cached.ts) < WALLET_TOKEN_TTL_MS) return cached.value;
        const cachedValue = cached ? cached.value : 0;
        const key = sym + ':fetching';
        if (!host._walletTokenCache.get(key)) {
            host._walletTokenCache.set(key, { fetching: true });
            // balanceOf(address) — selector 0x70a08231 + 32-byte address pad.
            const sel = '0x70a08231';
            const paddedAddr = host._walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
            const data = sel + paddedAddr;
            this._walletProviderCall(host._walletProvider.provider, 'eth_call',
                [{ to: tok.addr, data }, 'latest'])
                .then((hex) => {
                    const v = this._scaledFromHex(hex, tok.decimals);
                    host._walletTokenCache.set(sym, { value: v, ts: Date.now() });
                })
                .catch(() => {})
                .then(() => { host._walletTokenCache.delete(key); });
        }
        return cachedValue;
    }

    // Build the canonical sorted token list for the current chain. Curated
    // registry first (stable order); discovered tokens (from
    // wallet_tokens.js) appended alphabetically. When `includeZero` is
    // true, curated tokens with 0 balance are kept too — useful for
    // diagnostic "show all" displays.
    _walletListTokens(includeZero) {
        const host = this._host;
        if (!host._walletAddress) return [];
        const out = [];
        const seen = new Set();
        const tokens = WALLET_TOKENS[host._walletChainId] || [];
        for (const t of tokens) {
            const v = this.walletToken(t.symbol);
            if (includeZero || v > 0) {
                out.push({ symbol: t.symbol, value: v });
            }
            seen.add(t.symbol.toUpperCase());
        }
        const cache = host._walletTokenCache;
        if (cache) {
            const extras = [];
            for (const [sym, info] of cache) {
                if (typeof sym !== 'string') continue;
                if (sym.endsWith(':fetching')) continue;
                if (seen.has(sym.toUpperCase())) continue;
                if (info && info.value > 0) extras.push({ symbol: sym, value: info.value });
            }
            extras.sort((a, b) => a.symbol.localeCompare(b.symbol));
            for (const e of extras) out.push(e);
        }
        return out;
    }

    walletTokenCount() {
        const inc = !!this._host._walletShowZero;
        return this._walletListTokens(inc).length;
    }
    walletTokenSymbol(i) {
        const inc = !!this._host._walletShowZero;
        const list = this._walletListTokens(inc);
        const idx = Math.floor(Number(i));
        return (idx >= 0 && idx < list.length) ? list[idx].symbol : '';
    }
    walletTokenValueAt(i) {
        const inc = !!this._host._walletShowZero;
        const list = this._walletListTokens(inc);
        const idx = Math.floor(Number(i));
        return (idx >= 0 && idx < list.length) ? list[idx].value : 0;
    }

    cmdWALLETSHOWZERO(param) {
        this._host._walletShowZero = Number(param) ? 1 : 0;
        return C.CMD_OK;
    }

    // Comma-joined "SYM=value,SYM=value,..." across BOTH the curated
    // registry AND any tokens discovered via wallet_tokens.js. Skips zero
    // balances. Curated tokens render first (stable order); discovered
    // tokens append alphabetically.
    walletTokensJoined() {
        const host = this._host;
        if (!host._walletAddress) return '';
        const tokens = WALLET_TOKENS[host._walletChainId] || [];
        const parts = [];
        const seen = new Set();
        // Curated first — stable, fixed order.
        for (const t of tokens) {
            const v = this.walletToken(t.symbol);
            if (v > 0) parts.push(t.symbol + '=' + this._fmtFloat(v));
            seen.add(t.symbol.toUpperCase());
        }
        // Then anything else the discovery pass found.
        const cache = host._walletTokenCache;
        if (cache) {
            const extras = [];
            for (const [sym, info] of cache) {
                if (typeof sym !== 'string') continue;
                if (sym.endsWith(':fetching')) continue;   // skip in-flight markers
                if (seen.has(sym.toUpperCase())) continue;
                if (info && info.value > 0) extras.push([sym, info.value]);
            }
            extras.sort((a, b) => a[0].localeCompare(b[0]));
            for (const [sym, v] of extras) parts.push(sym + '=' + this._fmtFloat(v));
        }
        return parts.join(',');
    }

    // ── Confirm-on-connect (Y/N) ──────────────────────────────────────────
    // Reuses the same keypress-callback pattern as the picker. cb(approved).
    _walletAwaitConfirm(cb) {
        const host = this._host;
        const tryKey = () => {
            host._walletPickerCb = (k) => {
                // Y/y/Enter/Space => approve; N/n/Esc => decline; else re-ask.
                if (k === 89 || k === 121 || k === 13 || k === 32) { cb(true); return; }
                if (k === 78 || k === 110 || k === 27)             { cb(false); return; }
                host.appendLine('Press Y to approve, N to decline:', 1);
                host.want_keypress = 1;
                host._walletWaitingKey = true;
                tryKey();
            };
            host.want_keypress = 1;
            host._walletWaitingKey = true;
        };
        tryKey();
    }

    // ── Idle auto-disconnect (visibility-based) ───────────────────────────
    // When the document is hidden continuously for WALLET_IDLE_DISCONNECT_MS
    // (30 min), auto-disconnect the wallet. Cancelled if the tab becomes
    // visible again before the timer fires.
    _walletSetupIdleWatch() {
        if (this._idleVisHandler) return;  // already watching
        const host = this._host;
        this._idleVisHandler = () => {
            if (typeof document === 'undefined') return;
            if (document.visibilityState === 'hidden') {
                if (this._idleTimer) clearTimeout(this._idleTimer);
                this._idleTimer = setTimeout(() => {
                    if (host._walletAddress) {
                        host.appendLine('Idle auto-disconnect: wallet released after 30 min hidden.', 1);
                        this.cmdWALLETDISCONNECT();
                    }
                }, WALLET_IDLE_DISCONNECT_MS);
            } else if (this._idleTimer) {
                clearTimeout(this._idleTimer);
                this._idleTimer = null;
            }
        };
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._idleVisHandler);
            // If the tab is ALREADY hidden when we connect, start the timer.
            if (document.visibilityState === 'hidden') this._idleVisHandler();
        }
    }
    _walletTeardownIdleWatch() {
        if (this._idleVisHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._idleVisHandler);
        }
        this._idleVisHandler = null;
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────
    _weiToEth(weiHex) {
        // weiHex looks like '0x...'. Avoid BigInt-to-Number lossiness on huge
        // balances by dividing as a string. For everyday balances, parseFloat
        // through BigInt is fine.
        try {
            const wei = BigInt(weiHex);
            // 1 ETH = 1e18 wei. We want ~6 sig figs of precision for display.
            const whole = wei / 1000000000000000000n;
            const frac  = wei % 1000000000000000000n;
            return Number(whole) + Number(frac) / 1e18;
        } catch (_) { return 0; }
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
    _fmtFloat(v) {
        if (v >= 1)    return v.toFixed(2);
        if (v >= 0.01) return v.toFixed(4);
        return v.toFixed(6);
    }
}

// ---------------------------------------------------------------------------
// Mixin: inject all WalletDriver methods AND a thin Interpreter forwarder
// for each so that lookup_ / cmdWALLETCONNECT etc. can call them naturally.
// Mirrors the pattern used at the bottom of compiler.js for the Compiler
// class — runs once after this file is parsed, before boot.js instantiates
// the interpreter.
// ---------------------------------------------------------------------------
if (typeof Interpreter !== 'undefined') {
    // Convenience: make the constant tables and key allowlist readable from
    // outside (e.g. tests, future Stage-2 backend hooks).
    Interpreter.WALLET_NETWORKS         = WALLET_NETWORKS;
    Interpreter.WALLET_TOKENS           = WALLET_TOKENS;
    Interpreter.WALLET_METHOD_ALLOWLIST = WALLET_METHOD_ALLOWLIST;
}
