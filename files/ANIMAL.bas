1 REM **********************************************************************
2 REM ** Animal Guessing Game                                             **
3 REM **                   (C) CREATIVE COMPUTING  MORRISTOWN, NEW JERSEY **
4 REM **                                                                  **
5 REM ** This implementation modified for OSAWARE by Jahshaka, 2025 **
6 REM ** Last change: Sun Dec 11 17:07:17 CET 2005                        **
7 REM **********************************************************************
8 REM DATA before READ calls:
10 DATA "4","*QDOES IT SWIM*Y2*N3*","*AFISH","*ABIRD"
11 REM ** Opening screen **
12 COLOUR 0,3: GOSUB 800 : REM Title bar
13 PRINT CENTER$("ANIMAL GUESSER")
14 PRINT CENTER$("(c) Creative Computing") : PRINT ""
15 PRINT CENTER$("Animal appeared in The Best Of Creative Computing" ) : PRINT CENTER$("Volume 1 in 1976") : PRINT ""
16 PRINT CENTER$("This version has been adjusted for OSAWARE") : PRINT CENTER$("by Jahshaka in 2025")
17 PRINT LINES$(2) : PRINT CENTER$("** Hit any key to continue. **")
18 DUMMY=GETKEY()
49 REM ** Game start **
50 GOSUB 800 : REM Title bar
60 PRINT "Think of an ANIMAL and the computer will try to guess it." : PRINT LINES$(2)
70 DIM A$(200)
80 FOR I=0 TO 3
90 READ A$(I)
100 NEXT I
110 N=VAL(A$(0))
120 REM ***** Main control section *****
129 REM GOSUB 800 : REM Title bar
130 PRINT "Are you thinking of an animal [y/N]? ";:INPUT A$
135 A$=UPPER$(A$)
140 IF A$="LIST" THEN 600
150 IF LEFT$(A$,1)<>"Y" THEN 120
160 K=1
162 GOSUB 800 : REM Title bar
170 GOSUB 390
180 IF LEN(A$(K))=0 THEN 999
190 IF LEFT$(A$(K),2)="*Q" THEN 170
200 KT=LEN(A$(K))-2
201 REM PRINT "KT=";KT
202 PRINT "IS IT A ";
203 PRINT RIGHT$(A$(K),KT);
204 PRINT "? ";:INPUT A$
220 A$=LEFT$(A$,1) : A$=UPPER$(A$)
230 IF LEFT$(A$,1)="Y" THEN 700
240 INPUT "What was the animal you were thinking of? ";V$
242 V$=UPPER$(V$)
250 PRINT "Please type in a QUESTION that would distinguish a "
260 PRINT V$;" from a ";
265 KT=LEN(A$(K))-2
266 PRINT RIGHT$(A$(K),KT)
270 INPUT X$
271 X$=UPPER$(X$)
280 PRINT "For a ";V$;" the ANSWER would be? ";
290 INPUT A$
294 A$=UPPER$(A$)
300 A$=LEFT$(A$,1): IF A$<>"Y" AND A$<>"N" THEN 280
310 IF A$="Y" THEN B$="N"
320 IF A$="N" THEN B$="Y"
330 Z1=VAL(A$(0))
340 A$(0)=STR$(Z1+2)
350 A$(Z1)=A$(K)
351 ZT=Z1+1
360 A$(ZT)="*A"+V$
370 A$(K)="*Q"+X$+"*"+A$+STR$(ZT)+"*"+B$+STR$(Z1)+"*"
372 REM DEBUG: PRINT "A$(K)=";A$(K)
380 GOTO 120
390 REM ***** Subroutine that prints the questions *****
400 LET Q$=A$(K)
401 QT$="" : ZS=0
410 FOR Z=3 TO LEN(Q$)
413 IF ZS=0 THEN 415 ELSE 418
414 REM IF MID$(Q$,Z,1)<>"*" THEN PRINT MID$(Q$,Z,1); ELSE GOTO 417
415 IF MID$(Q$,Z,1)<>"*" THEN QT$=QT$+MID$(Q$,Z,1) ELSE GOTO 417
416 GOTO 418
417 ZS=1
418 NEXT Z
419 PRINT QT$;"? ";:INPUT C$
430 C$=LEFT$(C$,1) : C$=UPPER$(C$)
440 IF C$<>"Y" THEN 445 ELSE 450
445 IF C$<>"N" THEN 410
450 T$="*"+C$
451 ZX=0
455 FOR X=3 TO LEN(Q$)-1
456 REM PRINT "MID$=";MID$(Q$,X,2);",T=";T$
460 IF MID$(Q$,X,2)=T$ THEN GOTO 461 ELSE GOTO 470
461 LET ZX=X
470 NEXT X
475 REM PRINT "STOP!" : END
480 REM PRINT "ZX=";ZX
481 YS=0
482 FOR Y=ZX+1 TO LEN(Q$)
490 IF MID$(Q$,Y,1)="*" THEN YS=Y
500 NEXT Y
505 REM STOP
510 REM
511 XT=ZX+2 : YT=YS-ZX-2 : REM PRINT "Y=";YS;" X=";ZX;" Xt=";XT;" Yt=";YT
512 QT$=MID$(Q$,XT,YT)
513 REM PRINT "QT=";QT$
515 K=VAL(QT$)
520 RETURN
530 REM DATA "4","*QDOES IT SWIM*Y2*N3*","*AFISH","*ABIRD"
600 PRINT "" :PRINT "Animals I already know are:" : ? ""
605 X=0
609 CC=0
610 FOR AI=1 TO 200 STEP 1
620 IF LEFT$(A$(AI),2)="*A" THEN PRINT TAB$(10);MID$(A$(AI),3)
622 IF LEN(A$(AI))=0 THEN BREAK
625 NEXT AI
660 PRINT ""
680 GOTO 120
700 PRINT "Want to try another animal? ";:INPUT YN$
702 YN$=UPPER$(YN$)
704 IF MID$(YN$,1,1)="Y" THEN 120
705 RUN MENU
800 REM *** Title routine ***
801 CLS:COLOUR 0,3: PRINT CENTER$("* * *  A N I M A L   G U E S S E R  * * *") : COLOUR 0,16: ? LINES$(2)
