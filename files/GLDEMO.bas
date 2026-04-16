0 REM *****************************************************
1 REM ** GLDEMO — 3D Wireframe Spinning Cube             **
2 REM ** Uses the GL 3D rendering system                 **
3 REM *****************************************************
10 CLS : COLOUR 3
20 PRINT "GL 3D DEMO — Spinning Wireframe Cube"
30 PRINT "Press Q to quit."
40 SLEEP 1500
50 GL.INIT
60 GL.PERSPECTIVE 60
70 GL.CAMERA 0, 0, -4
80 GL.LOOKAT 0, 0, 0
90 REM === Define a unit cube ===
100 GL.BEGIN
110 REM -- 8 vertices of a unit cube
120 GL.VERTEX -1, -1, -1
130 GL.VERTEX  1, -1, -1
140 GL.VERTEX  1,  1, -1
150 GL.VERTEX -1,  1, -1
160 GL.VERTEX -1, -1,  1
170 GL.VERTEX  1, -1,  1
180 GL.VERTEX  1,  1,  1
190 GL.VERTEX -1,  1,  1
200 REM -- 6 faces (front, back, left, right, top, bottom)
210 GL.FACE 1,2,3,4
220 GL.FACE 5,6,7,8
230 GL.FACE 1,4,8,5
240 GL.FACE 2,3,7,6
250 GL.FACE 4,3,7,8
260 GL.FACE 1,2,6,5
270 GL.END
280 CUBE=GL.MESHID
290 REM === Spin loop ===
300 RX=0 : RY=0
310 K=INKEY
320 IF K=81 OR K=113 OR K=27 THEN GOTO 900
330 GL.CLS 0,0,20
340 GL.COLOUR 0,255,128
350 GL.ROTATE CUBE, RX, RY, 0
360 GL.DRAW CUBE
370 RX=RX+1 : RY=RY+1.5
380 IF RX>=360 THEN RX=RX-360
390 IF RY>=360 THEN RY=RY-360
400 SLEEP 16
410 GOTO 310
900 COLOUR 3 : CLS : PRINT "GL demo ended."
