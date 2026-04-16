0 REM VFSTEST2 — draw VFS textures to screen
5 CLS : COLOUR 3
6 PRINT "VFS TEXTURE DISPLAY TEST"
7 PRINT "Loading textures from MAZE3D/..."
8 PRINT ""
10 LOADIMG "stone", "MAZE3D/STONE.PNG"
11 LOADIMG "floor", "MAZE3D/FLOOR.PNG"
12 LOADIMG "ceil",  "MAZE3D/CEIL.PNG"
20 PRINT "Displaying textures..."
21 PRINT ""
22 PRINT "STONE (128x128)    FLOOR (128x128)    CEIL (128x128)"
30 DISPLAY "stone", 10,  60, 128, 128
31 DISPLAY "floor", 160, 60, 128, 128
32 DISPLAY "ceil",  310, 60, 128, 128
40 REM Also show tiled repeats below
50 PRINT ""
51 PRINT "Tiled 4x repeats:"
52 PRINT ""
60 FOR TX=0 TO 3
61 DISPLAY "stone", 10  + TX*64, 230, 64, 64
62 DISPLAY "floor", 10  + TX*64, 300, 64, 64
63 DISPLAY "ceil",  10  + TX*64, 370, 64, 64
64 NEXT TX
70 PRINT ""
71 PRINT "Press any key to exit."
72 DUMMY = GETKEY()
