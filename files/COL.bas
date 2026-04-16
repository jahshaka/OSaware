1 REM ******************************************************
2 REM ** COL v0.1: This demo prints out the colours.      **
3 REM ** (w) Jahshaka, 2025 **
4 REM ******************************************************
5 CLS:COLOUR 11,2:? CENTER$("Colour Map");:COLOUR 14,8:? LINES$(1)
9 ? TAB$(8);"BG  Foreground"
10 FOR I=1 TO 15
20 COLOUR I,8
30 IF I<10 THEN ? TAB$(9); ELSE ? TAB$(8);
45 PRINT STR$(I);": ";
50 FOR J=1 TO 15
60 COLOUR J,I
70 IF J<10 THEN 80 ELSE 90
80 PRINT " ";
90 PRINT J;"";
100 NEXT J
110 PRINT
120 NEXT I
140 COLOUR 14,1
