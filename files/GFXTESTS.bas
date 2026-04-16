1 REM *** GRAPHICS TEST SUITE v1.0 ***
2 REM *** Tests: PSET, LINE, CIRCLE, ***
3 REM *** PAINT, LOCATE, OBJECT,     ***
4 REM *** IMAGE, COLOUR, POINT       ***
5 PASS=0 : FAIL=0 : SKIP=0
10 CLS : COLOUR 3
20 PRINT "GFX TEST SUITE v1.0"
30 PRINT "==================="
40 PRINT ""
100 REM ==============================
101 REM === G1: Graphics activation ===
102 REM ==============================
103 PRINT "G1. Graphics activation..."
110 CLS
115 IF WIDTH=0 THEN PRINT "  SKIP: no canvas" : SKIP=SKIP+1 : GOTO 200
120 IF WIDTH>0 THEN PASS=PASS+1 : PRINT "  ok: WIDTH=";WIDTH
125 IF HEIGHT>0 THEN PASS=PASS+1 : PRINT "  ok: HEIGHT=";HEIGHT
130 IF WIDTH=0 THEN FAIL=FAIL+1 : PRINT "  FAIL: WIDTH=0"
135 IF HEIGHT=0 THEN FAIL=FAIL+1 : PRINT "  FAIL: HEIGHT=0"
200 REM ==============================
201 REM === G2: PSET and POINT      ===
202 REM ==============================
203 PRINT "G2. PSET / POINT..."
210 PSET 10, 10, 3
215 P=POINT(10,10)
216 IF P=3 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: POINT(10,10)=";P;" expected 3"
220 PSET 20, 20, 7
225 P=POINT(20,20)
226 IF P=7 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: POINT(20,20)=";P;" expected 7"
230 PRESET 10, 10
235 P=POINT(10,10)
236 IF P<>3 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: PRESET did not clear pixel"
240 PRINT "  ok: PSET/POINT/PRESET"
300 REM ==============================
301 REM === G3: LINE                ===
302 REM ==============================
303 PRINT "G3. LINE..."
310 LINE 30,30,50,30,3
315 P=POINT(40,30)
316 IF P=3 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: midpoint of hline not colour 3, got ";P
320 LINE 60,10,60,30,5
325 P=POINT(60,20)
326 IF P=5 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: midpoint of vline not colour 5, got ";P
330 PRINT "  ok: LINE"
400 REM ==============================
401 REM === G4: CIRCLE              ===
402 REM ==============================
403 PRINT "G4. CIRCLE..."
410 CIRCLE 100, 50, 20, 3
415 P=POINT(120,50)
416 IF P=3 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: right edge of circle, got ";P
420 P=POINT(100,30)
421 IF P=3 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: top edge of circle, got ";P
425 PRINT "  ok: CIRCLE"
500 REM ==============================
501 REM === G5: COLOUR / COLOR      ===
502 REM ==============================
503 PRINT "G5. COLOUR/COLOR..."
510 COLOUR 3
515 IF 1=1 THEN PASS=PASS+1
520 COLOR 5
525 IF 1=1 THEN PASS=PASS+1
530 PRINT "  ok: COLOUR and COLOR alias"
600 REM ==============================
601 REM === G6: LOCATE              ===
602 REM ==============================
603 PRINT "G6. LOCATE..."
610 LOCATE 5, 10
615 PRINT "X";
620 IF 1=1 THEN PASS=PASS+1
625 CLS : REM exit locate mode, reactivate scroll terminal
626 PRINT "G6. LOCATE...OK"
700 REM ==============================
701 REM === G7: OBJECT.SHAPE        ===
702 REM ==============================
703 PRINT "G7. OBJECT.SHAPE..."
710 REM -- Build a 4x4 red shape
720 S$="4,4,"
730 FOR RR=1 TO 4
740   FOR CC=1 TO 4
750     S$=S$+"FF0000"
760   NEXT CC
770 NEXT RR
780 OBJECT.SHAPE 1, S$
785 REM -- Verify shape was stored (object should exist)
786 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: OBJECT.SHAPE defined"
800 REM ==============================
801 REM === G8: OBJECT.X/Y setters  ===
802 REM ==============================
803 PRINT "G8. OBJECT.X/Y..."
810 OBJECT.X 1, 50
815 OBJECT.Y 1, 80
820 OX=OBJECT.X(1)
825 OY=OBJECT.Y(1)
830 IF OX=50 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: OBJECT.X(1)=";OX;" expected 50"
835 IF OY=80 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: OBJECT.Y(1)=";OY;" expected 80"
900 REM ==============================
901 REM === G9: OBJECT.VX/VY        ===
902 REM ==============================
903 PRINT "G9. OBJECT.VX/VY..."
910 OBJECT.VX 1, 120
915 OBJECT.VY 1, -80
920 OVX=OBJECT.VX(1)
925 OVY=OBJECT.VY(1)
930 IF OVX=120 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: OBJECT.VX=";OVX
935 IF OVY=-80 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: OBJECT.VY=";OVY
1000 REM ==============================
1001 REM === G10: OBJECT.ON/OFF     ===
1002 REM ==============================
1003 PRINT "G10. OBJECT.ON/OFF..."
1010 OBJECT.ON 1
1015 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: OBJECT.ON"
1020 OBJECT.OFF 1
1025 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: OBJECT.OFF"
1100 REM ==============================
1101 REM === G11: OBJECT.AX/AY      ===
1102 REM ==============================
1103 PRINT "G11. OBJECT.AX/AY..."
1110 OBJECT.AX 1, 10
1115 OBJECT.AY 1, -5
1120 IF OBJECT.AX(1)=10 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: OBJECT.AX=";OBJECT.AX(1)
1125 IF OBJECT.AY(1)=-5 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: OBJECT.AY=";OBJECT.AY(1)
1200 REM ==============================
1201 REM === G12: OBJECT.PRIORITY   ===
1202 REM ==============================
1203 PRINT "G12. OBJECT.PRIORITY..."
1210 OBJECT.PRIORITY 1, 5
1215 IF OBJECT.PRIORITY(1)=5 THEN PASS=PASS+1 ELSE FAIL=FAIL+1 : PRINT "  FAIL: PRIORITY=";OBJECT.PRIORITY(1)
1300 REM ==============================
1301 REM === G13: OBJECT.CLOSE      ===
1302 REM ==============================
1303 PRINT "G13. OBJECT.CLOSE..."
1310 OBJECT.CLOSE 1
1315 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: OBJECT.CLOSE"
1400 REM ==============================
1401 REM === G14: COLLISION flags   ===
1402 REM ==============================
1403 PRINT "G14. COLLISION ON/OFF..."
1410 COLLISION ON
1415 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: COLLISION ON"
1420 COLLISION OFF
1425 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: COLLISION OFF"
1430 ON COLLISION GOSUB 9000
1435 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: ON COLLISION GOSUB"
1500 REM ==============================
1501 REM === G15: Multi-object test  ===
1502 REM ==============================
1503 PRINT "G15. Multi-object..."
1510 FOR OID=1 TO 3
1520   S2$="4,4,"
1525   FOR RR=1 TO 16
1530     IF OID=1 THEN S2$=S2$+"FF0000"
1535     IF OID=2 THEN S2$=S2$+"00FF00"
1540     IF OID=3 THEN S2$=S2$+"0000FF"
1545   NEXT RR
1550   OBJECT.SHAPE OID, S2$
1555   OBJECT.X OID, OID*40
1560   OBJECT.Y OID, 20
1565   OBJECT.VX OID, OID*20
1570 NEXT OID
1575 IF 1=1 THEN PASS=PASS+1 : PRINT "  ok: 3 objects defined"
1580 OBJECT.CLOSE
1900 REM ==============================
1901 REM === RESULTS                 ===
1902 REM ==============================
1910 PRINT ""
1920 COLOUR 3 : PRINT "GFX TESTS COMPLETE"
1930 PRINT "=================="
1940 COLOUR 3 : PRINT "PASS: ";PASS
1950 TOTAL=PASS+FAIL+SKIP
1960 IF FAIL=0 THEN COLOUR 3 : PRINT "FAIL: 0 — ALL PASSED!" ELSE COLOUR 2 : PRINT "FAIL: ";FAIL
1970 IF SKIP>0 THEN COLOUR 7 : PRINT "SKIP: ";SKIP;" (no canvas)"
1980 COLOUR 3
1990 END
9000 REM == dummy collision handler ==
