0 REM ** Data section has to be at the beginning for OSAWARE **
1 DATA 148,185,160,120,105,205,228,248,268,285
2 DATA 283,260,240,220,203,303,328,368,383,340
3 DATA 20508,010310,20412,30514,10406,50715,60817,10709
4 DATA 81018,20911,101219,31113,121420,41315,61416
5 DATA 151720,71618,91719,111820,131619
9 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16, : ? "" : ? ""
10 PRINT CENTER$("WUMPUS I")
11 PRINT CENTER$("(c) Creative Computing") : PRINT ""
12 PRINT CENTER$("Wumpus I appeared in Creative Computing" ) : PRINT CENTER$("Volume 1 Issue 5 in 1975") : PRINT ""
15 PRINT CENTER$("This version has been adjusted for OSAWARE") : PRINT CENTER$("by Jahshaka in 2025")
16 PRINT LINES$(2) : PRINT CENTER$("** Hit any key to continue. **")
17 DUMMY=GETKEY()
20 REM  ADAPTED FOR SOL BY DAVID FOX - MARIN COMPUTER CENTER
25 REM  ADAPTED FOR TRS-80 LEVEL II BASIC BY DOUG BENEDICT
28 REM  Adapted for OSAWARE by Jahshaka, 2025.
30 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16,
50 DIM L0(21) : DIM L2(21) : DIM L3(21) : LET L1=20
70 PRINT ""
80 PRINT "Would you like some instructions [N/y]? ";:INPUT A$
90 IF MID$(A$,1,1)="Y" THEN 95
91 IF MID$(A$,1,1)="y" THEN 95 ELSE 100
95 GOSUB 850
100 ? ""
110 ? "Please enter a RANDOM number: ";:INPUT R1
112 REM CLS
120 IF R1=0 THEN LET R1=123
130 R1=ABS(R1)+1 : R1=R1/10
132 IF R1>1 THEN GOTO 130
140 R1=RND(R1)
150 FOR I=1 TO L1
152 READ L3(I)
155 NEXT I
180 FOR I=1 TO L1
182 READ L2(I)
185 NEXT I
220 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16, : ? ""
221 PRINT "The WUMPUS is HIDING.";
230 FOR I=1 TO L1
232 LET L0(I)=I
233 PRINT ".";
234 REM PRINT "I=";I;", L0(I)=";L0(I)
235 NEXT I
240 FOR I=L1 TO 2 STEP -1
241 PRINT ".";
242 REM PRINT I
250 LET J=RND(I)+1 : REM PRINT "J=";J
251 LET K=L0(I) : REM PRINT "K=";K
252 LET L0(I)=L0(J) : REM LET L0(J)=K
254 REM PRINT "L0(";J;")=";L0(J)
255 NEXT I
256 PRINT "." : SLEEP 1000
257 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16, : ? ""
260 LET W1=RND(L1)
265 LET B1=RND(L1)
270 LET B2=RND(L1)
280 IF B1=B2 THEN 270
290 LET H1=RND(L1)
300 IF H1=B2 THEN 290
310 IF H1=B1 THEN 290
320 LET P1=RND(L1)
330 IF P1=W1 THEN 320
331 IF P1=B1 THEN 320
332 IF P1=B2 THEN 320
333 IF P1=H1 THEN 320
340 GOSUB 770
350 GOSUB 790
355 LET D5=D4
360 IF P1<>W1 THEN 400
370 PRINT "LOOK OUT, it's the WUMPUS room!!!"
375 SLEEP 1500
377 PRINT ""
380 PRINT "Too late... You've been eaten. :("
390 GOTO 660
400 IF P1<>B1 THEN 401 ELSE 410
401 IF P1<>B2 THEN 420
410 PRINT "SUPER BATS *WHOOOSH*"
415 GOTO 320
420 IF P1<>H1 THEN 490
430 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16, : ? ""
432 ? "LOOK OUT!  BOTTOMLESS PIT!!" : ? ""
450 PRINT TAB$(5);"A I":SLEEP 500:PRINT TAB$(10);"E":SLEEP 500:PRINT TAB$(12);"E":SLEEP 500
460 PRINT TAB$(13);"E":SLEEP 500
461 FOR I=1 TO 6
462 PRINT "             E":SLEEP 500:
463 NEXT I
480 GOTO 660
490 GOSUB 790
499 REM PRINT "D4=";D4;" D5=";D5
500 IF D4<D5 THEN ? "You are CLOSER to the WUMPUS."
510 IF D4>D5 THEN ? "YOU are FARTHER from the WUMPUS."
520 D5=D4
530 P0=W1 : GOSUB 750
531 IF K0>0 THEN PRINT "I smell a WUMPUS."
540 P0=B1 : GOSUB 750
541 K1=K0:P0=B2 : GOSUB 750
550 IF K0+K1>0 THEN PRINT "I hear BATS."
560 P0=H1 : GOSUB 750
561 IF K0>0 THEN PRINT "I feel a draft of PITS."
570 ? "" : ? "You are in room #";L0(P1);", adjacent to ";
580 ? L0(P5);",";L0(P6);",";L0(P7);"."
590 ? "" : ? "[S]hoot or [M]ove: ";
595 A1=GETKEY()
596 LET A1$=UPPER$(CHR$(A1))
597 IF A1$="" THEN GOTO 595
598 PRINT A1$
600 IF A1$="M" THEN GOTO 700
610 IF A1$<>"S" THEN GOTO 590
620 PRINT "Into which room ? ";:INPUT P2
630 GOSUB 730
632 IF K0<>1 THEN GOTO 570
635 REM PRINT P2;"W1:";W1
640 IF P2<>W1 THEN GOTO 680
650 ? "Hurray! One less WUMPUS."
660 ? "": ? "Care for another game [y/N]? ";
665 A1=GETKEY()
666 LET A1$=UPPER$(CHR$(A1))
667 IF A1$="" THEN GOTO 665
670 IF A1$="Y" THEN GOTO 220 ELSE GOTO 820
680 W1=RND(L1) : ? "" : ? "You MISSED!" : ? ""
682 REM PRINT "W1:";W1;" L1:";L1
690 PRINT "The WUMPUS is moving.":GOTO 420
700 PRINT "Move to room #? ";:INPUT P2
702 ? ""
710 GOSUB 730
711 IF K0>0 THEN P1=P2 ELSE GOTO 570
720 GOSUB 770
721 GOTO 360
730 P0=L1+1
731 FOR I=1 TO L1
732 IF L0(I)=P2 THEN P0=I
740 NEXT I
741 P2=P0
749 K0=0
750 IF P0=P5 THEN K0=1
751 IF P0=P6 THEN K0=1
752 IF P0=P7 THEN K0=1
760 RETURN
770 LET P4=L2(P1) : LET P5=INT(P4/10000)
771 REM ? "P5=";P5
772 LET PT=10000*P5
773 LET P4=P4-PT
780 LET P6=INT(P4/100)
781 REM ? "P6=";P6
782 LET PT=INT(100*P6) : LET P7=P4-PT
783 REM ? "P4=";P4;", Pt=";PT;" P7=";P7
785 RETURN
790 LET D6=L3(P1)
791 LET D7=L3(W1)
792 LET D0=0
793 FOR I=1 TO 3 : REM This is still buggy!
800 LET D8=INT(D6/10)
801 LET D9=INT(D7/10)
802 LET DT=D8-D9 : LET DT=10*DT
805 LET D6=D6-D7-DT : REM PRINT "D6=";D6;" D7=";D7;" DT=";DT
806 LET D0=D0+D6*D6 : LET D6=D8 : LET D7=D9
811 NEXT I
812 REM ? "D0=";D0
813 D4=SQR(D0)
815 RETURN
820 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16,
822 PRINT "" : PRINT "" : PRINT "Thank you for playing with me."
840 REM ? "To load another program, type 'LOAD'." : ? "To list all available programs, type 'LOAD WEB:*'."
841 ? ""
842 RUN MENU
850 REM RULES
860 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16, : ? "" : ? ""
870 PRINT "The WUMPUs is a shy, timid person-eating animal. It lives in "
880 PRINT "one of 20 connecting rooms.  The object is to find and shoot "
890 PRINT "the WUMPUS with your bows and arros." : PRINT ""
900 PRINT "In some of the rooms are SUPER BATS.  If you walk into their"
910 PRINT "room they will pick you up and drop you into one of the rooms"
920 PRINT "randomly."
925 PRINT ""
930 PRINT "Also some of the rooms contan BOTTOMLESS PITS.   Falling into"
940 PRINT "one will cause a sudden attack of death."
942 PRINT ""
950 PRINT "The WUMPUS will stay in one place unless disturbed by the sound "
960 PRINT "of an arrow shooting through a room."
965 PRINT ""
970 PRINT "Hit any key to continue...":TMP=GETKEY()
975 CLS : COLOUR 0,3, : PRINT CENTER$("* * *  H U N T  T H E  W U M P U S  * * *") : COLOUR 0,16, : ? "" : ? ""
980 PRINT "To help you in your quest are the following aids:"
990 PRINT "1) If you are in a room ADJOINING the WUMPUS's room, "
1000 PRINT "     'I SMELL A WUMPUS' is printed out."
1010 PRINT "2) If you are in a room AJOINING the BAT's ROOM,"
1020 PRINT "     'I HEAR BATS' is printed out."
1030 PRINT "3) If an ADJOINING room contains BOTTOMLESS PITS,"
1040 PRINT "     'I FEEL A DRAFT OF PITS' is printed out."
1050 PRINT "4) As you move, you are told whether your new room number is "
1060 PRINT "   CLOSER or FARTHER to the WUMPUS's room number than your last"
1070 PRINT "   room number.  If they are the SAME distance, NO message is"
1080 PRINT "   prnted.  The numbering of the rooms is random and some of "
1090 PRINT "   the passages go only in one direction."
1100 PRINT ""
1102 PRINT "Have FUN and GOOD HUNTING!"
1110 RETURN
