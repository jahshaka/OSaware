0 REM *****************************************************
1 REM ** IMGDEMO — Image Store Demo                     **
2 REM ** Loads images from DEMO/ VFS folder             **
3 REM *****************************************************
10 CLS : COLOUR 3
20 PRINT "IMAGE STORE DEMO"
30 PRINT "================"
40 PRINT ""
50 PRINT "Loading images from DEMO/ folder..."
51 LOADIMG "checkerboard", "DEMO/CHECKERBOARD.PNG"
52 LOADIMG "gradient",     "DEMO/GRADIENT.PNG"
53 LOADIMG "smiley",       "DEMO/SMILEY.PNG"
54 LOADIMG "palette",      "DEMO/PALETTE.PNG"
60 IMGLIST
70 PRINT ""
80 PRINT "Press any key to display images on canvas..."
90 DUMMY=GETKEY()
100 CLS : DELAY 0
110 REM === Display the images ===
120 DISPLAY "checkerboard", 10, 10
130 DISPLAY "checkerboard", 50, 10
140 DISPLAY "smiley", 10, 50
150 DISPLAY "palette", 50, 50, 128, 128
160 DISPLAY "gradient", 10, 200, 256, 64
170 REM === Add custom images from web if available ===
180 REM LOADIMG "myimg","https://example.com/image.png"
190 REM DISPLAY "myimg", 200, 10
200 PRINT "Press any key for sprite demo..."
210 DUMMY=GETKEY()
220 REM === Use smiley as a bouncing OBJECT sprite ===
230 CLS : DELAY 0
240 OBJECT.SHAPE 1, "smiley"
250 OBJECT.SHAPE 2, "smiley"
260 OBJECT.SHAPE 3, "smiley"
270 OBJECT.X 1, 50  : OBJECT.Y 1, 50
280 OBJECT.X 2, 200 : OBJECT.Y 2, 80
290 OBJECT.X 3, 120 : OBJECT.Y 3, 150
300 OBJECT.VX 1, 60 : OBJECT.VY 1, 45
310 OBJECT.VX 2,-50 : OBJECT.VY 2, 70
320 OBJECT.VX 3, 80 : OBJECT.VY 3,-55
330 OBJECT.ON 1 : OBJECT.ON 2 : OBJECT.ON 3
340 OBJECT.START
400 PRINT "Bouncing smileys! Press Q to quit."
500 K=INKEY
510 IF K=81 OR K=113 OR K=27 THEN GOTO 900
520 GOSUB 1000
530 SLEEP 30
540 GOTO 500
900 OBJECT.CLOSE
910 COLOUR 3 : CLS : PRINT "Done."
920 END
1000 REM == BOUNCE CHECK ==
1010 W=WIDTH : H=HEIGHT : SZ=32
1020 FOR BID=1 TO 3
1030   IF OBJECT.X(BID)<=0 AND OBJECT.VX(BID)<0 THEN OBJECT.VX BID,-OBJECT.VX(BID)
1040   IF OBJECT.X(BID)>=W-SZ AND OBJECT.VX(BID)>0 THEN OBJECT.VX BID,-OBJECT.VX(BID)
1050   IF OBJECT.Y(BID)<=0 AND OBJECT.VY(BID)<0 THEN OBJECT.VY BID,-OBJECT.VY(BID)
1060   IF OBJECT.Y(BID)>=H-SZ AND OBJECT.VY(BID)>0 THEN OBJECT.VY BID,-OBJECT.VY(BID)
1070 NEXT BID
