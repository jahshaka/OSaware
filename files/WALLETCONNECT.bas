10 REM ============================================================
20 REM   WALLETCONNECT  --  smoke test for the OSAWARE wallet driver.
30 REM   Stage 1: browser-extension wallets only. Read-only.
40 REM   See docs/OSaware Wallet.pdf for the full spec.
50 REM
60 REM   Uses the kernel built-ins directly, GL-style:
70 REM     WALLET.INIT / WALLET.END / WALLET.SWITCH / WALLET.REFRESH
80 REM     WALLET$ / WALLET.NETWORK$ / WALLET.BALANCE / WALLET.TOKEN()
90 REM ============================================================
100 CLS : COLOUR 3
110 PRINT "+----------------------------+"
120 PRINT "|   OSAWARE WALLET CONNECT   |"
130 PRINT "+----------------------------+"
140 COLOUR 7 : PRINT ""
150 PRINT "This program will open your wallet extension."
160 PRINT "Supported: MetaMask, Rabby, Coinbase, Frame, Brave."
170 PRINT "Networks: Ethereum, Base, Arbitrum, BNB Chain."
180 PRINT ""
190 PRINT "Press any key to begin..."
200 DUMMY = GETKEY()
210 PRINT ""
220 WALLET.INIT
230 IF WALLET.CONNECTED = 0 THEN PRINT "" : PRINT "  No wallet connected." : END
240 ZF = 0
250 REM First print: inline below the connect output, no CLS.
260 GOTO ShowStatus
270 KeyLoop:
280 K = GETKEY()
290 IF K = 69 OR K = 101 THEN WALLET.SWITCH "Ethereum"    : CLS : GOTO ShowStatus
300 IF K = 66 OR K = 98  THEN WALLET.SWITCH "Base"        : CLS : GOTO ShowStatus
310 IF K = 65 OR K = 97  THEN WALLET.SWITCH "Arbitrum One": CLS : GOTO ShowStatus
320 IF K = 78 OR K = 110 THEN WALLET.SWITCH "BNB Chain"   : CLS : GOTO ShowStatus
330 IF K = 82 OR K = 114 THEN WALLET.REFRESH              : CLS : GOTO ShowStatus
340 IF K = 90 OR K = 122 THEN ZF = 1 - ZF : WALLET.SHOWZERO ZF : CLS : GOTO ShowStatus
350 IF K = 68 OR K = 100 THEN WALLET.END
360 PRINT "" : PRINT "  Done." : END
400 ShowStatus:
410 PRINT ""
420 COLOUR 3
430 PRINT "  Network : "; WALLET.NETWORK$; " (chain "; WALLET.CHAINID; ")"
440 PRINT "  Address : "; WALLET$
450 COLOUR 14 : PRINT ""
460 PRINT "  Native  : "; WALLET.BALANCE; " "; WALLET.SYMBOL$
470 PRINT ""
480 PRINT "  Tokens:"
490 TN = WALLET.TOKENCOUNT
500 IF TN = 0 THEN PRINT "    (no token balances)"
510 FOR TI = 0 TO TN - 1
520    TS$ = WALLET.TOKENSYMBOL$(TI)
530    PRINT "    "; TS$; SPACE$(8 - LEN(TS$)); ": "; WALLET.TOKENAT(TI)
540 NEXT TI
550 COLOUR 7 : PRINT ""
560 PRINT "  (E)thereum  (B)ase  (A)rbitrum  (N) BNB"
570 IF ZF = 1 THEN ZS$ = "ON" ELSE ZS$ = "OFF"
580 PRINT "  (Z) View Zero Balances "; ZS$
590 PRINT "  (R)efresh   (D)isconnect   any other = exit"
600 GOTO KeyLoop
