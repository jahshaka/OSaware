100 REM *** OSAWARE BASIC — Games Menu ***
105 DATA "[GAME] SkyFox (3D flight)",       "SKYFOX"
108 DATA "[GAME] Maze 3D",                  "MAZE3D"
111 DATA "[GAME] Tron (light cycles)",      "TRON"
114 DATA "[GAME] Pac-Man",                  "PACMAN"
200 MAX=4 : DIM DESCR$(MAX+1) : DIM CMD$(MAX+1)
201 FOR I=1 TO MAX
202 READ DESCR$(I),CMD$(I)
203 NEXT I
250 COLOUR 0,,16 : CLS : COLOUR 16,3,
251 ? CENTER$("OSAWARE BASIC — Games Menu") : COLOUR 0,16,
252 ? ""
260 PR$=MID$(DESCR$(1),1,6)
261 FOR I=1 TO MAX
262 P$=MID$(DESCR$(I),1,6)
263 IF P$<>PR$ THEN PRINT "" : PR$=P$
265 PRINT TAB$(4);"#";I;" ";:COLOUR 3,,: ? DESCR$(I):COLOUR 0,16,
270 NEXT I
271 PRINT TAB$(4);"-- ------------------------------"
272 PRINT TAB$(4);" Q ";:COLOUR 3,,: ? "Quit":COLOUR 0,16,
280 ? LINES$(1);TAB$(4);:INPUT "#? ";L$
281 IF UPPER$(L$)="Q" THEN 999
284 L=VAL(L$)
285 IF L>MAX OR L<1 THEN 250
290 CUR$=CMD$(L)
291 ? LINES$(2): ? "Loading ";CUR$;"..."
292 RUN CUR$
999 END
