0 REM *** GLMODEL — GL Model Viewer (GLTF/GLB on the PBR stage) ***
1 REM *** Loads a 3D model onto the checkerboard floor; turntable spin ***
5 CLS : COLOUR 3
10 PRINT "GL MODEL VIEWER"
12 PRINT ""
14 PRINT "Loads a 3D GLTF model onto the PBR demo stage."
16 PRINT ""
20 PRINT "Q=quit  F=fog  L=light  M=mouse  H=hide UI"
22 PRINT "Mouse drag = orbit camera"
30 SLEEP 1500
40 GL.INIT
41 LOADIMG "checkerboard", "DEMO/CHECKERBOARD.PNG"
50 GL.PERSPECTIVE 55
60 REM Camera orbit state
70 ORBIT = 0
80 CDIST = 11 : CY = 4
90 GL.CAMERA SIN(ORBIT)*CDIST, CY, -COS(ORBIT)*CDIST
100 GL.LOOKAT 0, 0, 0
110 REM === Lighting ===
120 GL.LIGHT 1, 2, -1
130 GL.AMBIENT 0.22
140 GL.POINTLIGHT 0, 5, -2, 255, 200, 120, 3, 14
150 GL.POINTLIGHT 0, 0, 4, 120, 160, 255, 3, 10
160 REM === Fog ===
170 GL.FOG 5, 5, 18, 6, 22
180 REM ==================================================
190 REM Build checkerboard floor
200 REM ==================================================
210 GL.SOLID
220 GL.COLOUR 255, 255, 255
230 GL.SHINE 5 : GL.ALPHA 1.0 : GL.EMISSIVE 0, 0, 0
240 GL.BEGIN
250 GL.VERTEX -1, 0, -1 : GL.VERTEX  1, 0, -1
260 GL.VERTEX  1, 0,  1 : GL.VERTEX -1, 0,  1
270 GL.FACE 1, 2, 3, 4
280 GL.END
290 FLOOR = GL.MESHID
300 GL.TRANSLATE FLOOR, 0, -1.5, 0
310 GL.SCALE FLOOR, 12, 1, 12
320 GL.TEXTURE FLOOR, "checkerboard", 8
330 REM ==================================================
340 REM Load the 3D model onto the stage (turntable centre)
350 REM ==================================================
355 PRINT "Loading model..."
360 GL.LOAD "files/models/Duck.glb"
370 MODEL = GL.MESHID : IF MODEL = FLOOR THEN MODEL = 0
375 IF MODEL = 0 THEN PRINT "Model failed to load."
380 REM Duck.glb already has a 0.01 root scale baked in — 2.5 here = ~0.025 effective
390 GL.SCALE MODEL, 2.5, 2.5, 2.5
400 GL.TRANSLATE MODEL, 0, -1.75, 0
880 REM ==================================================
890 REM Init state
900 REM ==================================================
910 ANG = 0 : FOGON = 1 : MOUSEMODE = 1 : UION = 1
920 LASTMX = 0 : DRAGGING = 0
930 MOUSE ON
940 REM ==================================================
950 REM Main loop
960 REM ==================================================
970 K = INKEY
980 IF K=81 OR K=113 OR K=27 THEN GOTO 4000
990 IF K=70 OR K=102 THEN GOSUB 3000
1000 IF K=76 OR K=108 THEN GOSUB 3100
1010 IF K=77 OR K=109 THEN GOSUB 3200
1015 IF K=72 OR K=104 THEN GOSUB 3300
1020 REM === Mouse orbit ===
1030 IF MOUSEMODE = 0 THEN GOTO 1120
1040 MB = MOUSE(0)
1050 MX = MOUSE(1)
1060 IF MB = -1 AND DRAGGING = 0 THEN DRAGGING = 1 : LASTMX = MX
1070 IF MB = 0 AND DRAGGING = 1 THEN DRAGGING = 0
1080 IF DRAGGING = 1 THEN ORBIT = ORBIT + (MX - LASTMX) * 0.012 : LASTMX = MX
1090 REM Update camera position on orbit circle
1100 GL.CAMERA SIN(ORBIT)*CDIST, CY, -COS(ORBIT)*CDIST
1110 GL.LOOKAT 0, 0, 0
1120 REM === Scene animation: turntable spin ===
1130 GL.CLS 5, 5, 18
1140 GL.ROTATE MODEL, 0, ANG*0.6, 0
1270 GL.DRAWALL
1280 ANG = ANG + 1.3
1290 IF ANG >= 3600 THEN ANG = ANG - 3600
1300 SLEEP 16
1310 GOTO 970
3000 REM === Toggle fog ===
3010 FOGON = 1 - FOGON
3020 IF FOGON = 1 THEN GL.FOG 5,5,18,6,22 : RETURN
3030 GL.FOGOFF
3040 RETURN
3100 REM === Add random point light ===
3110 PR = INT(RND(1)*200)+55
3120 PG = INT(RND(1)*200)+55
3130 PB = INT(RND(1)*200)+55
3140 PX = RND(1)*8-4 : PZ = RND(1)*6-3
3150 GL.POINTLIGHT PX, 2, PZ, PR, PG, PB, 4, 8
3160 RETURN
3200 REM === Toggle mouse orbit mode ===
3210 MOUSEMODE = 1 - MOUSEMODE
3220 IF MOUSEMODE = 1 THEN MOUSE ON : RETURN
3230 MOUSE OFF : DRAGGING = 0
3240 RETURN
3300 REM === Toggle UI visibility ===
3310 UION = 1 - UION
3320 IF UION = 0 THEN UI OFF : RETURN
3330 UI ON : RETURN
4000 GL.FOGOFF
4010 GL.LIGHTSOFF
4015 GL.DISPOSE MODEL
4020 MOUSE OFF : UI ON
4030 COLOUR 3 : CLS
4040 PRINT "GL model viewer ended."
4050 END
