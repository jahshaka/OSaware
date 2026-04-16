0 REM *** MOUSEDEMO — Mouse input demonstration ***
5 CLS : COLOUR 3
10 PRINT "MOUSE DEMO"
20 PRINT "=========="
30 PRINT ""
40 PRINT "Move the mouse over the canvas."
50 PRINT "Click to draw dots. Double-click to clear."
60 PRINT "Press Q to quit."
70 PRINT ""
80 ON MOUSE GOSUB 1000
90 MOUSE ON
100 DELAY 0
110 K = INKEY
120 IF K=81 OR K=113 OR K=27 THEN GOTO 500
130 REM --- Show live position ---
140 LOCATE 8, 1
150 COLOUR 7
160 PRINT "Mouse: X="; MOUSE(1); "  Y="; MOUSE(2); "    "
170 SLEEP 30
180 GOTO 110
500 MOUSE OFF
510 CLS : COLOUR 3
520 PRINT "Mouse demo ended."
530 END
1000 REM === Mouse event handler ===
1010 B = MOUSE(0)
1020 MX = MOUSE(3) : MY = MOUSE(4)
1030 IF B = 2 THEN CLS : COLOUR 3 : PRINT "MOUSE DEMO - Click to draw, Q to quit" : RETURN
1040 IF B = -1 OR B = 1 THEN GOSUB 2000
1050 RETURN
2000 REM === Draw a dot at click position ===
2010 IF MX < 1 OR MY < 1 THEN RETURN
2020 C = INT(RND(1)*14)+1
2030 CIRCLE MX, MY, 6, C
2040 PAINT MX, MY, C
