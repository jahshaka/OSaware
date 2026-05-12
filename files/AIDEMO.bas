10 REM ============================================================
20 REM   AIDEMO  --  LIVE BRIEFING: a retro dashboard wired into the live web,
30 REM   via Claude web search.   See  HELP AI  /  HELP WEB  for the commands used.
40 REM   Before RUN:  type  AIKEY  and paste your Anthropic API key.
50 REM ============================================================
60 REM --- give Claude a role, and let it search the web ---
70 AISYSTEM "You are BRIEFING, a terse live-data feed bolted onto an old home computer. ALWAYS use the web search tool to get current, real data. Reply with ONLY the value or short phrase asked for. No preamble, no explanation, no citations, no markdown, no quotation marks. If you genuinely cannot find it, reply exactly: UNKNOWN"
80 AIWEB ON
90 AITEMP 0
100 CITY$ = "London"
110 REM --- (re)draw the dashboard ---
120 CLS : COLOUR 14
130 PRINT "  +------------------------------------------+"
140 PRINT "  |           L I V E   B R I E F I N G      |"
150 PRINT "  +------------------------------------------+"
160 COLOUR 7 : PRINT : PRINT "   ...asking around, one moment..." : PRINT
170 REM --- weather ---
180 P$ = "Current weather in " + CITY$ + " as one short phrase, e.g. 8C light rain"
190 AI P$, A$
200 IF AIERR$<>"" THEN A$ = "(unavailable: " + AIERR$ + ")"
210 PRINT "   Weather, " + CITY$ + " :  " + A$
220 REM --- bitcoin price ---
230 AINUM "Bitcoin price in US dollars right now -- just the number, no commas, no symbols", N
240 IF AIERR$<>"" THEN PRINT "   Bitcoin (USD)      :  (unavailable)"
250 IF AIERR$="" THEN PRINT "   Bitcoin (USD)      :  $"; INT(N)
260 REM --- top headline ---
270 AI "The single biggest world news headline right now, max 55 chars, no quotes", A$
280 IF AIERR$<>"" THEN A$ = "(unavailable)"
290 PRINT "   Top story          :  " + A$
300 REM --- on this day ---
310 AI "One notable historical event that happened on today's calendar date, under 55 chars", A$
320 IF AIERR$<>"" THEN A$ = "(unavailable)"
330 PRINT "   On this day        :  " + A$
340 PRINT : COLOUR 11
350 PRINT "   [R] refresh     [C] change city     [Q] quit"
360 COLOUR 7
370 K = GETKEY()
380 IF K=81 OR K=113 THEN CLS : COLOUR 7 : PRINT "Stay curious." : END
390 IF K=67 OR K=99 THEN GOTO 420
400 GOTO 110
410 REM --- change city ---
420 PRINT
430 INPUT "   New city: "; C$
440 IF C$<>"" THEN CITY$ = C$
450 GOTO 110
