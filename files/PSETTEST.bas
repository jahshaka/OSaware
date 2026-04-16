1 REM Simple PSET test - 16 solid colour columns
5 CLS
10 COLOUR 3 : PRINT "Drawing pixels..."
20 FOR I=1 TO 16
30   FOR J=0 TO 200
40     PSET I*20, J, I
50   NEXT J
60 NEXT I
70 COLOUR 3
80 PRINT "Done - 16 colour columns above"
