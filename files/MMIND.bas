1 REM ******************************************
2 REM ** Mastermind v2.0 for OSAWARE          **
3 REM ** Guess the 4-digit secret code        **
4 REM ** (c) Jahshaka/Exedos 2025-2026        **
5 REM ******************************************
10 GOTO 100
100 GOSUB 1000
110 INPUT "Instructions [y/N]? ";Y$
115 Y$=UPPER$(Y$)
120 IF MID$(Y$,1,1)="Y" THEN GOSUB 2000
200 REM == NEW GAME ==
205 GOSUB 1000
210 MAXTRY=10 : TRY=0 : WON=0
220 REM -- Generate secret code (4 digits 1-6)
225 RANDOMIZE TIMER
230 DIM SECRET(4) : DIM GUESS(4)
240 FOR I=1 TO 4
250   SECRET(I)=INT(RND(6))+1
260 NEXT I
270 COLOUR 7 : PRINT TAB$(2);"I have chosen a secret 4-digit code."
275 PRINT TAB$(2);"Each digit is 1-6. You have ";MAXTRY;" tries."
280 PRINT TAB$(2);"B=right digit & position, W=right digit wrong pos"
285 PRINT ""
300 REM == MAIN GUESS LOOP ==
310 TRY=TRY+1
315 IF TRY>MAXTRY THEN GOTO 800
320 COLOUR 14 : PRINT TAB$(2);"Try ";TRY;"/";MAXTRY;": ";
325 COLOUR 3 : INPUT G$
330 REM -- Validate input
335 G$=LEFT$(G$,4)
340 IF LEN(G$)<>4 THEN COLOUR 2 : PRINT TAB$(4);"Enter exactly 4 digits (1-6)" : TRY=TRY-1 : GOTO 310
345 VALID=1
350 FOR I=1 TO 4
355   C=ASC(MID$(G$,I,1))-48
360   IF C<1 OR C>6 THEN VALID=0
365   GUESS(I)=C
370 NEXT I
375 IF VALID=0 THEN COLOUR 2 : PRINT TAB$(4);"Digits must be 1-6" : TRY=TRY-1 : GOTO 310
400 REM -- Score the guess
405 BLACKS=0 : WHITES=0
410 DIM USED_S(4) : DIM USED_G(4)
415 FOR I=1 TO 4
420   USED_S(I)=0 : USED_G(I)=0
425 NEXT I
430 REM -- Count blacks (exact matches)
440 FOR I=1 TO 4
450   IF GUESS(I)=SECRET(I) THEN BLACKS=BLACKS+1 : USED_S(I)=1 : USED_G(I)=1
460 NEXT I
470 REM -- Count whites (right digit wrong position)
480 FOR I=1 TO 4
490   IF USED_G(I)=1 THEN GOTO 530
492   FOR J=1 TO 4
494     FOUND=0
496     IF USED_S(J)=0 AND GUESS(I)=SECRET(J) THEN FOUND=1
498     IF FOUND=1 THEN WHITES=WHITES+1 : USED_S(J)=1 : USED_G(I)=1
500   NEXT J
530 NEXT I
540 REM -- Display result
545 COLOUR 3 : PRINT TAB$(4);
550 FOR I=1 TO 4 : PRINT GUESS(I); : NEXT I
555 PRINT "  ";
560 FOR I=1 TO BLACKS : COLOUR 3 : PRINT "B"; : NEXT I
565 FOR I=1 TO WHITES : COLOUR 4 : PRINT "W"; : NEXT I
570 IF BLACKS=0 AND WHITES=0 THEN COLOUR 7 : PRINT "(no match)"
575 IF BLACKS>0 OR WHITES>0 THEN PRINT ""
580 IF BLACKS=4 THEN WON=1 : GOTO 700
590 GOTO 310
700 REM == WIN ==
710 COLOUR 3 : PRINT ""
720 PRINT TAB$(2);"*** CORRECT! You cracked it in ";TRY;" ";
725 IF TRY=1 THEN PRINT "try!" ELSE PRINT "tries!"
730 GOTO 900
800 REM == LOSE ==
810 COLOUR 2 : PRINT ""
820 PRINT TAB$(2);"Out of tries! The code was: ";
825 FOR I=1 TO 4 : PRINT SECRET(I); : NEXT I
830 PRINT ""
900 REM == PLAY AGAIN ==
910 COLOUR 7 : PRINT "" : INPUT "Play again [y/N]? ";Y$
915 Y$=UPPER$(Y$)
920 IF MID$(Y$,1,1)="Y" THEN GOTO 200
925 COLOUR 3 : PRINT "" : PRINT "Thanks for playing!"
930 END
1000 REM == TITLE ==
1005 CLS
1010 COLOUR 0,3, : PRINT CENTER$("** MASTERMIND **") : COLOUR 0,16,
1015 PRINT ""
1020 RETURN
2000 REM == INSTRUCTIONS ==
2005 GOSUB 1000
2010 COLOUR 3 : PRINT TAB$(2);"HOW TO PLAY"
2015 COLOUR 7
2020 PRINT TAB$(2);"Guess the secret 4-digit code."
2025 PRINT TAB$(2);"Each digit is between 1 and 6."
2030 PRINT ""
2035 PRINT TAB$(2);"After each guess you get clues:"
2040 COLOUR 3 : PRINT TAB$(4);"B"; : COLOUR 7 : PRINT " = right digit, right position"
2045 COLOUR 4 : PRINT TAB$(4);"W"; : COLOUR 7 : PRINT " = right digit, wrong position"
2050 PRINT ""
2055 PRINT TAB$(2);"Example: secret=1234, guess=1356"
2060 COLOUR 3 : PRINT TAB$(4);"B"; : COLOUR 7 : PRINT " for the 1 (pos 1 exact)"
2065 COLOUR 4 : PRINT TAB$(4);"W"; : COLOUR 7 : PRINT " for the 3 (in code, wrong pos)"
2070 PRINT ""
2075 COLOUR 7 : PRINT TAB$(2);"Press any key..."
2080 DUMMY=GETKEY()
