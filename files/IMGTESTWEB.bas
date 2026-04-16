5 REM ** IMGTESTWEB - Load images over HTTPS **
10 CLS : COLOUR 3
20 PRINT "Loading images from web..."
30 LOADIMG "img1", "https://www.aisolver.com/wp-content/uploads/2026/03/featured.png"
40 PRINT "1/3 loaded"
50 LOADIMG "img2", "https://www.aisolver.com/wp-content/uploads/2026/03/soulbank.jpg"
60 PRINT "2/3 loaded"
70 LOADIMG "img3", "https://www.aisolver.com/wp-content/uploads/2026/02/gkoi.png"
80 PRINT "3/3 loaded"
90 CLS
100 REM ** Slideshow loop **
110 K = INKEY : IF K=81 OR K=113 THEN END
120 R = INT(RND(1)*3)+1
130 IMG$ = "img" + STR$(R)
140 X = INT(RND(1)*(WIDTH-160))
150 Y = INT(RND(1)*(HEIGHT-120))
160 SX = INT(RND(1)*200)+100
170 SY = INT(RND(1)*150)+80
180 DISPLAY IMG$, X, Y, SX, SY
190 SLEEP 1000
200 GOTO 110
