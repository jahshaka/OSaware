9 REM ** Initialization section **
10 LET STARTTIME=INT(SECONDS)
15 LET TEST1=0 : LET TEST2=0
50 CLS : COLOUR 0,3, : ? CENTER$("** Running Tests **") : COLOUR 0,16, : ? ""
51 ? "This test tries to run as fast as possible.": ? "The approximate run-time is 5 seconds." : ? ""
52 REM Set the DELAY to a very low number:
55 DELAY 1
99 REM ** Test-section 1: NESTED FORs **
100 PRINT "** Testing nested for.... ";
110 FOR A=1 TO 20
120 FOR B=(21-A) TO A STEP -1
125 LET M=(A*B):LET TEST1=TEST1+M
140 NEXT B
150 NEXT A
170 IF TEST1=5390 THEN ? "1 OK" ELSE ? "FAIL"
199 REM ** Test 2: String routines **
200 ? "** Testing string routines.... ";
205 TEMP$=TIME$+" "+DATE$:TEST2=LEN(TEMP$)
210 IF TEST2=19 THEN ? "1 "; ELSE ? "FAIL ";
215 IF MID$(TEMP$,9,1)=" " THEN ? "2 OK" ELSE ? "FAIL"
299 REM ** Test 3: Calculations **
300 ? "** Testing calculations.... ";
305 LET TEMP1=COLS-3 : LET TEMP2=(COLS/ROWS) : LET TEMP3=(TEMP2*ROWS)
310 IF (TEMP1+3)=INT(TEMP3) THEN ? "1 "; ELSE ? "FAIL ";
315 LET TEMP2=SQR(TEMP1) : LET TEMP3=(TEMP2^2)
320 IF INT(TEMP3)=INT(TEMP1) THEN ? "2 OK" ELSE ? "FAIL"
500 REM ** End section **
510 LET ENDTIME=INT(SECONDS)
512 PRINT ""
514 TOTALTIME=ENDTIME-STARTTIME
515 PRINT "Run-time was ";TOTALTIME;" seconds."
517 REM Re-set to default delay:
518 DELAY
520 PRINT ""
525 COLOUR 0,3, : ? CENTER$("** Tests Finished **") : COLOUR 0,16, : ? ""
