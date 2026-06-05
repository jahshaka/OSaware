10 REM ============================================================
20 REM   TRACKBUILDER  --  spline track viewer (iteration 8)
30 REM   Two splines extruded: SHAPE cross-section + PATH route.
40 REM   Cookie-cutter outline at bottom-right; red path spline;
50 REM   white spheres at each path control point.
60 REM   Keys: M=shape (bracket/horseshoe/halfpipe), T=path+regen,
65 REM         L=topology (loop/fig8/fig8-grounded), V=view,
67 REM         S=smooth, R=ramp (hard/soft, fig8g only),
68 REM         F=floor, N=path (spline+cubes), K=track,
69 REM         Q=quit.
70 REM   Mouse drag = orbit (X) + pitch (Y), wheel = zoom.
80 REM ============================================================
90 CLS : COLOUR 3
100 PI = 4 * ATN(1)
110 RANDOMIZE TIMER
120 GL.INIT
130 LOADIMG "checkerboard", "DEMO/CHECKERBOARD.PNG"
140 GL.PERSPECTIVE 55
150 GL.LIGHT 0.4, 1, -0.6, 0.55
160 GL.AMBIENT 0.18
170 GL.FOG 8, 10, 22, 100, 480
180 GL.PIXELRATIO 1
190 GL.AA 1
200 REM === Floor ===
210 GL.SOLID : GL.COLOUR 255, 255, 255 : GL.SHINE 5 : GL.ALPHA 1.0 : GL.EMISSIVE 0, 0, 0
220 GL.BEGIN
230 GL.VERTEX -1, 0, -1 : GL.VERTEX  1, 0, -1
240 GL.VERTEX  1, 0,  1 : GL.VERTEX -1, 0,  1
250 GL.FACE 1, 2, 3, 4
260 GL.END
270 FLOORID = GL.MESHID
280 GL.TRANSLATE FLOORID, 0, -0.6, 0
290 GL.SCALE FLOORID, 220, 1, 220
300 GL.TEXTURE FLOORID, "checkerboard", 40
310 REM === Parameters ===
320 NCP = 24 : R_BASE = 60 : R_VAR = 28
330 TRACK_W = 10.4 : WALL_H = 3.5 : WALL_T = 1.0 : RT = 0.25 : DEEP = 0.3
340 SHAPE_STYLE = 1 : PATH_STYLE = 1 : VIEW_MODE = 0 : FLOOR_ON = 1 : SMOOTH_ON = 1 : NODES_ON = 1 : PATH_KIND = 0 : RAMP_KIND = 1 : TRACK_ON = 1
350 TRACK_LIFT = 1.0
360 DIM CX(NCP), CZ(NCP), CY_PATH(NCP)
362 DIM HX_IN(NCP), HZ_IN(NCP), HY_IN(NCP)
364 DIM HX_OUT(NCP), HZ_OUT(NCP), HY_OUT(NCP)
370 DIM SX(15), SY(15)
380 DIM NODEID(NCP)
390 FOR I = 0 TO NCP - 1 : NODEID(I) = -1 : CY_PATH(I) = 0 : NEXT I
395 USE_BEZIER = 0
400 NSPT = 0 : TRACKID = -1 : SPLINEID = -1
410 CDIST = 130 : PITCH = 0.52
420 ORBIT = 0 : LASTMX = 0 : LASTMY = 0 : DRAGGING = 0
430 MOUSE ON
440 GOSUB GenPath
450 GOSUB Build : GOTO MainLoop
460 GenPath:
470 IF PATH_KIND = 0 THEN GOSUB GenLoop
480 IF PATH_KIND = 1 THEN GOSUB GenFigure8
485 IF PATH_KIND = 2 THEN GOSUB GenFigure8G
490 RETURN
540 Build:
550 IF TRACKID >= 0 THEN GL.HIDE TRACKID
560 IF SPLINEID >= 0 THEN GL.HIDE SPLINEID
570 FOR I = 0 TO NCP - 1
580    IF NODEID(I) >= 0 THEN GL.HIDE NODEID(I)
590 NEXT I
600 WT = WALL_T : WH = WALL_H : HW = TRACK_W / 2
610 LIFT = TRACK_LIFT
620 IF SHAPE_STYLE = 1 THEN LIFT = TRACK_LIFT + DEEP + 0.6
625 IF SHAPE_STYLE = 2 THEN LIFT = TRACK_LIFT + RT
628 IF PATH_KIND = 1 THEN LIFT = LIFT + 6
630 IF SHAPE_STYLE = 0 THEN GOSUB FillBracket
640 IF SHAPE_STYLE = 1 THEN GOSUB FillHorseshoe
645 IF SHAPE_STYLE = 2 THEN GOSUB FillHalfPipe
650 REM --- Choose render mode for track ---
660 IF VIEW_MODE = 0 THEN GL.SOLID
670 IF VIEW_MODE = 1 THEN GL.UNLIT
680 IF VIEW_MODE = 2 THEN GL.WIRE
690 GL.COLOUR 200, 170, 100 : GL.SHINE 8 : GL.EMISSIVE 0, 0, 0 : GL.ALPHA 1.0
700 GL.SHAPEBEGIN
710 FOR I = 0 TO NSPT - 1
720    GL.SHAPEPT SX(I), SY(I)
730 NEXT I
740 GL.PATHBEGIN
750 FOR I = 0 TO NCP - 1
755    IF USE_BEZIER = 0 THEN GL.PATHPT CX(I), CZ(I), CY_PATH(I)
760    IF USE_BEZIER = 1 THEN GL.PATHBEZPT CX(I), CZ(I), CY_PATH(I), HX_IN(I), HZ_IN(I), HY_IN(I), HX_OUT(I), HZ_OUT(I), HY_OUT(I)
770 NEXT I
780 GL.SMOOTH SMOOTH_ON
785 ES = SHAPE_STYLE : IF ES = 2 THEN ES = 0
790 GL.EXTRUDE ES, PATH_STYLE, 16, 0.6
800 TRACKID = GL.MESHID
810 GL.TRANSLATE TRACKID, 0, LIFT, 0
815 IF TRACK_ON = 0 THEN GL.HIDE TRACKID
820 REM --- Red path spline as a true 3D line primitive ---
830 GL.COLOUR 255, 60, 60 : GL.ALPHA 1.0
840 GL.PATHBEGIN
850 FOR I = 0 TO NCP - 1
855    IF USE_BEZIER = 0 THEN GL.PATHPT CX(I), CZ(I), CY_PATH(I)
860    IF USE_BEZIER = 1 THEN GL.PATHBEZPT CX(I), CZ(I), CY_PATH(I), HX_IN(I), HZ_IN(I), HY_IN(I), HX_OUT(I), HZ_OUT(I), HY_OUT(I)
870 NEXT I
880 GL.SPLINE PATH_STYLE, 24
890 SPLINEID = GL.MESHID
900 GL.TRANSLATE SPLINEID, 0, LIFT + WALL_H + 1.5, 0
910 REM --- White cube nodes at each path control point ---
920 IF VIEW_MODE = 0 THEN GL.SOLID
930 IF VIEW_MODE = 1 THEN GL.UNLIT
940 IF VIEW_MODE = 2 THEN GL.WIRE
950 GL.COLOUR 240, 240, 240 : GL.EMISSIVE 0, 0, 0 : GL.SHINE 10 : GL.ALPHA 1.0
960 FOR I = 0 TO NCP - 1
970    GL.BOX 1.4, 1.4, 1.4
980    NODEID(I) = GL.MESHID
990    GL.TRANSLATE NODEID(I), CX(I), LIFT + WALL_H + 1.5 + CY_PATH(I), CZ(I)
1000 NEXT I
1003 GOSUB ApplyNodes
1005 GOSUB DrawShapeOverlay
1010 RETURN
1020 REM ============================================================
1030 REM   Shape array fill SUBs. Trace order is REVERSED from a
1040 REM   naive CW trace so the polygon ends up CCW in shape
1050 REM   space — gives ExtrudeGeometry consistent outward
1060 REM   normals so triangles don't flip under DoubleSide.
1070 REM ============================================================
1080 FillBracket:
1090 NSPT = 8
1100 SX(0) = 0    : SY(0) = HW + WT
1110 SX(1) = 0-WH : SY(1) = HW + WT
1120 SX(2) = 0-WH : SY(2) = HW
1130 SX(3) = 0-RT : SY(3) = HW
1140 SX(4) = 0-RT : SY(4) = 0 - HW
1150 SX(5) = 0-WH : SY(5) = 0 - HW
1160 SX(6) = 0-WH : SY(6) = 0 - HW - WT
1170 SX(7) = 0    : SY(7) = 0 - HW - WT
1180 RETURN
1190 FillHorseshoe:
1200 NSPT = 9
1210 SX(0) = 0          : SY(0) = HW + WT
1220 SX(1) = 0-WH       : SY(1) = HW + WT
1230 SX(2) = 0-WH       : SY(2) = HW
1240 SX(3) = 0-WH*0.55  : SY(3) = HW*0.55
1250 SX(4) = DEEP       : SY(4) = 0
1260 SX(5) = 0-WH*0.55  : SY(5) = 0 - HW*0.55
1270 SX(6) = 0-WH       : SY(6) = 0 - HW
1280 SX(7) = 0-WH       : SY(7) = 0 - HW - WT
1290 SX(8) = 0          : SY(8) = 0 - HW - WT
1300 RETURN
1310 MainLoop:
1320 K = INKEY
1330 IF K = 81 OR K = 113 OR K = 27 THEN GOTO Quit
1340 NEEDS_BUILD = 0 : NEEDS_MAT = 0
1350 IF K = 77 OR K = 109 THEN SHAPE_STYLE = SHAPE_STYLE + 1
1360 IF SHAPE_STYLE > 2 THEN SHAPE_STYLE = 0
1370 IF K = 77 OR K = 109 THEN NEEDS_BUILD = 1
1380 IF K = 84 OR K = 116 THEN PATH_STYLE = PATH_STYLE + 1
1390 IF PATH_STYLE > 2 THEN PATH_STYLE = 0
1400 IF K = 84 OR K = 116 THEN NEEDS_BUILD = 1
1420 IF K = 86 OR K = 118 THEN VIEW_MODE = VIEW_MODE + 1
1430 IF VIEW_MODE > 2 THEN VIEW_MODE = 0
1440 IF K = 86 OR K = 118 THEN NEEDS_MAT = 1
1450 IF K = 70 OR K = 102 THEN FLOOR_ON = 1 - FLOOR_ON
1460 IF (K = 70 OR K = 102) AND FLOOR_ON = 1 THEN GL.SHOW FLOORID
1470 IF (K = 70 OR K = 102) AND FLOOR_ON = 0 THEN GL.HIDE FLOORID
1480 IF K = 83 OR K = 115 THEN SMOOTH_ON = SMOOTH_ON + 1
1481 IF SMOOTH_ON > 2 THEN SMOOTH_ON = 0
1490 IF K = 83 OR K = 115 THEN NEEDS_BUILD = 1
1491 IF K = 82 OR K = 114 THEN RAMP_KIND = 1 - RAMP_KIND
1492 IF K = 78 OR K = 110 THEN NODES_ON = 1 - NODES_ON
1493 IF K = 82 OR K = 114 THEN GOSUB GenPath
1494 IF K = 78 OR K = 110 THEN GOSUB ApplyNodes
1495 IF K = 82 OR K = 114 THEN NEEDS_BUILD = 1
1496 IF K = 76 OR K = 108 THEN PATH_KIND = PATH_KIND + 1
1497 IF PATH_KIND > 2 THEN PATH_KIND = 0
1498 IF K = 76 OR K = 108 THEN GOSUB GenPath
1499 IF K = 76 OR K = 108 THEN NEEDS_BUILD = 1
1500 IF NEEDS_BUILD = 1 THEN GOSUB Build : NEEDS_MAT = 0
1504 IF K = 75 OR K = 107 THEN TRACK_ON = 1 - TRACK_ON
1506 IF (K = 75 OR K = 107) AND TRACK_ON = 1 AND TRACKID >= 0 THEN GL.SHOW TRACKID
1507 IF (K = 75 OR K = 107) AND TRACK_ON = 0 AND TRACKID >= 0 THEN GL.HIDE TRACKID
1505 IF NEEDS_MAT = 1 THEN GOSUB ApplyMaterials
1510 WD = MOUSE(7)
1520 IF WD > 0 THEN CDIST = CDIST * 0.9
1530 IF WD < 0 THEN CDIST = CDIST * 1.1
1540 IF CDIST < 25 THEN CDIST = 25
1550 IF CDIST > 600 THEN CDIST = 600
1560 MB = MOUSE(0) : MX = MOUSE(1) : MY = MOUSE(2)
1570 IF MB = -1 AND DRAGGING = 0 THEN DRAGGING = 1 : LASTMX = MX : LASTMY = MY
1580 IF MB = 0 AND DRAGGING = 1 THEN DRAGGING = 0
1590 IF DRAGGING = 1 THEN ORBIT = ORBIT + (MX - LASTMX) * 0.012 : LASTMX = MX
1595 IF DRAGGING = 1 THEN PITCH = PITCH + (MY - LASTMY) * 0.012 : LASTMY = MY
1596 IF PITCH < 0.05 THEN PITCH = 0.05
1597 IF PITCH > 1.5  THEN PITCH = 1.5
1598 CDXZ = COS(PITCH) * CDIST : CYP = SIN(PITCH) * CDIST
1600 GL.CAMERA SIN(ORBIT)*CDXZ, CYP, COS(ORBIT)*CDXZ : GL.LOOKAT 0, 0, 0
1610 SH$ = "?"
1620 IF SHAPE_STYLE = 0 THEN SH$ = "bracket  "
1630 IF SHAPE_STYLE = 1 THEN SH$ = "horseshoe"
1635 IF SHAPE_STYLE = 2 THEN SH$ = "halfpipe "
1640 PH$ = "?"
1650 IF PATH_STYLE = 0 THEN PH$ = "lines "
1660 IF PATH_STYLE = 1 THEN PH$ = "spline"
1670 IF PATH_STYLE = 2 THEN PH$ = "curved"
1680 VW$ = "?"
1690 IF VIEW_MODE = 0 THEN VW$ = "rendered "
1700 IF VIEW_MODE = 1 THEN VW$ = "unlit    "
1710 IF VIEW_MODE = 2 THEN VW$ = "wireframe"
1720 FS$ = "off"
1730 IF FLOOR_ON = 1 THEN FS$ = "on "
1740 SM$ = "flat  "
1750 IF SMOOTH_ON = 1 THEN SM$ = "smooth"
1751 IF SMOOTH_ON = 2 THEN SM$ = "inner "
1752 NK$ = "off"
1754 IF NODES_ON = 1 THEN NK$ = "on "
1755 TK$ = "off"
1756 IF TRACK_ON = 1 THEN TK$ = "on "
1755 RM$ = "soft"
1759 IF RAMP_KIND = 1 THEN RM$ = "hard"
1756 LK$ = "loop "
1757 IF PATH_KIND = 1 THEN LK$ = "fig8 "
1758 IF PATH_KIND = 2 THEN LK$ = "fig8g"
1760 LOCATE 1,1 : PRINT "TRACKBUILDER  Shape(M):";SH$;"  Path(T):";PH$;"  Topo(L):";LK$;"  View(V):";VW$;"  Q=quit"
1770 LOCATE 2,1 : PRINT "Smooth(S):";SM$;"  Floor(F):";FS$;"  Path(N):";NK$;"  Track(K):";TK$;"  Ramp(R):";RM$;"  Polys:";GL.POLYS;"  Verts:";GL.VERTS;"     "
1790 GL.CLS 6, 6, 14 : GL.DRAWALL
1800 SLEEP 16 : GOTO MainLoop
1810 DrawShapeOverlay:
1820 MMW = 260 : MMH = 260
1830 MMX = WIDTH - MMW - 10 : MMY = HEIGHT - MMH - 10
1840 FILLRECT MMX, MMY, MMX+MMW, MMY+MMH, 16
1850 RECT MMX, MMY, MMX+MMW, MMY+MMH, 7
1860 CXC = MMX + MMW/2 : CYC = MMY + MMH/2
1870 SCL = 22
1880 IF SHAPE_STYLE >= 1 THEN GOTO DrawSpline
1890 REM --- Bracket: straight lines with explicit closing wrap ---
1900 FOR I = 0 TO NSPT - 1
1910    INX = I + 1 : IF INX >= NSPT THEN INX = 0
1920    X1 = CXC + SY(I)   * SCL
1930    Y1 = CYC + SX(I)   * SCL
1940    X2 = CXC + SY(INX) * SCL
1950    Y2 = CYC + SX(INX) * SCL
1960    LINE X1, Y1, X2, Y2, 3
1970 NEXT I
1980 RETURN
1990 DrawSpline:
2000 REM --- Horseshoe: Catmull-Rom samples through control points ---
2010 STEPS = 12
2020 FOR I = 0 TO NSPT - 1
2030    II0 = I - 1 : IF II0 < 0 THEN II0 = NSPT - 1
2040    II1 = I
2050    II2 = I + 1 : IF II2 >= NSPT THEN II2 = II2 - NSPT
2060    II3 = I + 2 : IF II3 >= NSPT THEN II3 = II3 - NSPT
2070    P0X = SX(II0) : P0Y = SY(II0)
2080    P1X = SX(II1) : P1Y = SY(II1)
2090    P2X = SX(II2) : P2Y = SY(II2)
2100    P3X = SX(II3) : P3Y = SY(II3)
2110    PXP = CXC + P1Y * SCL : PYP = CYC + P1X * SCL
2120    FOR S = 1 TO STEPS
2130       TT = S / STEPS : T2 = TT * TT : T3 = T2 * TT
2140       BXS = 0.5*(2*P1X+(0-P0X+P2X)*TT+(2*P0X-5*P1X+4*P2X-P3X)*T2+(0-P0X+3*P1X-3*P2X+P3X)*T3)
2150       BYS = 0.5*(2*P1Y+(0-P0Y+P2Y)*TT+(2*P0Y-5*P1Y+4*P2Y-P3Y)*T2+(0-P0Y+3*P1Y-3*P2Y+P3Y)*T3)
2160       PXC = CXC + BYS * SCL : PYC = CYC + BXS * SCL
2170       LINE PXP, PYP, PXC, PYC, 3
2180       PXP = PXC : PYP = PYC
2190    NEXT S
2200 NEXT I
2210 RETURN
2220 Quit:
2225 CLS : COLOUR 3 : PRINT "" : GL.PROFILE : COLOUR 7 : PRINT ""
2230 MOUSE OFF : GL.CLOSE
2240 PRINT "TRACKBUILDER exited." : END
2250 ApplyMaterials:
2260 IF VIEW_MODE = 0 THEN GL.SOLID
2270 IF VIEW_MODE = 1 THEN GL.UNLIT
2280 IF VIEW_MODE = 2 THEN GL.WIRE
2290 GL.COLOUR 200, 170, 100 : GL.SHINE 8 : GL.EMISSIVE 0, 0, 0 : GL.ALPHA 1.0
2300 IF TRACKID >= 0 THEN GL.REMATERIAL TRACKID
2310 GL.COLOUR 240, 240, 240 : GL.EMISSIVE 0, 0, 0 : GL.SHINE 10 : GL.ALPHA 1.0
2320 FOR I = 0 TO NCP - 1
2330    IF NODEID(I) >= 0 THEN GL.REMATERIAL NODEID(I)
2340 NEXT I
2350 GL.COLOUR 255, 60, 60 : GL.ALPHA 1.0
2360 IF SPLINEID >= 0 THEN GL.REMATERIAL SPLINEID
2370 RETURN
2380 FillHalfPipe:
2382 REM   Skate-park vert-ramp profile (halfpipe2.png).
2384 REM     square-top decks, short outer rim, short vert,
2386 REM     smooth quarter-arc transition, WIDE flat bottom.
2388 REM   Polygon mode (ES=0) keeps the deck corners sharp;
2390 REM   the 5-point arc reads as smooth at this scale.
2400 COPING_H = HW * 0.5 : VERT_H = 0.3 : TRANS_R = COPING_H - VERT_H
2402 DECK_W = HW * 0.2 : COPING_SY = HW - DECK_W : FLAT_HALF = COPING_SY - TRANS_R : WH_HP = 0.6
2404 AX1 = TRANS_R * 0.3827 : AY1 = TRANS_R * 0.9239
2406 AX2 = TRANS_R * 0.7071 : AY2 = AX2
2408 AX3 = TRANS_R * 0.9239 : AY3 = TRANS_R * 0.3827
2410 NSPT = 20
2415 SX(0)  = RT                          : SY(0)  = HW + WT
2420 SX(1)  = 0 - COPING_H - WH_HP        : SY(1)  = HW + WT
2425 SX(2)  = 0 - COPING_H - WH_HP        : SY(2)  = HW
2430 SX(3)  = 0 - COPING_H                : SY(3)  = HW
2435 SX(4)  = 0 - COPING_H                : SY(4)  = COPING_SY
2440 SX(5)  = 0 - COPING_H + VERT_H       : SY(5)  = COPING_SY
2445 SX(6)  = 0 - COPING_H + VERT_H + AX1 : SY(6)  = COPING_SY - TRANS_R + AY1
2450 SX(7)  = 0 - COPING_H + VERT_H + AX2 : SY(7)  = COPING_SY - TRANS_R + AY2
2455 SX(8)  = 0 - COPING_H + VERT_H + AX3 : SY(8)  = COPING_SY - TRANS_R + AY3
2460 SX(9)  = 0                            : SY(9)  = FLAT_HALF
2465 SX(10) = 0                            : SY(10) = 0 - FLAT_HALF
2470 SX(11) = 0 - COPING_H + VERT_H + AX3 : SY(11) = 0 - COPING_SY + TRANS_R - AY3
2475 SX(12) = 0 - COPING_H + VERT_H + AX2 : SY(12) = 0 - COPING_SY + TRANS_R - AY2
2480 SX(13) = 0 - COPING_H + VERT_H + AX1 : SY(13) = 0 - COPING_SY + TRANS_R - AY1
2485 SX(14) = 0 - COPING_H + VERT_H       : SY(14) = 0 - COPING_SY
2490 SX(15) = 0 - COPING_H                : SY(15) = 0 - COPING_SY
2495 SX(16) = 0 - COPING_H                : SY(16) = 0 - HW
2500 SX(17) = 0 - COPING_H - WH_HP        : SY(17) = 0 - HW
2505 SX(18) = 0 - COPING_H - WH_HP        : SY(18) = 0 - HW - WT
2510 SX(19) = RT                          : SY(19) = 0 - HW - WT
2515 RETURN
2580 ApplyNodes:
2585 REM   NODES_ON now controls BOTH the cube markers AND the
2587 REM   red spline line — they are one "path" feature now.
2590 FOR I = 0 TO NCP - 1
2600    IF NODES_ON = 1 AND NODEID(I) >= 0 THEN GL.SHOW NODEID(I)
2610    IF NODES_ON = 0 AND NODEID(I) >= 0 THEN GL.HIDE NODEID(I)
2620 NEXT I
2625 IF NODES_ON = 1 AND SPLINEID >= 0 THEN GL.SHOW SPLINEID
2627 IF NODES_ON = 0 AND SPLINEID >= 0 THEN GL.HIDE SPLINEID
2630 RETURN
2640 GenLoop:
2650 REM   Closed loop on randomized polar control points.
2655 USE_BEZIER = 0
2660 FOR I = 0 TO NCP - 1
2670    ANG = I * 2 * PI / NCP
2680    R = R_BASE + RND(R_VAR) - R_VAR / 2
2690    CX(I) = COS(ANG) * R
2700    CZ(I) = SIN(ANG) * R
2710    CY_PATH(I) = 0
2720 NEXT I
2730 RETURN
2740 GenFigure8:
2750 REM   Lemniscate of Gerono with randomised amplitudes,
2755 REM   rotation, and per-control-point lateral noise.
2760 REM     x = A*sin(t)         z = B*sin(t)*cos(t)
2762 REM     dx/dt = A*cos(t)     dz/dt = B*cos(2t)
2770 REM   Y = ELEV*cos(t) for over/under crossings.
2775 REM   Per-point Bezier handles use the analytic
2780 REM   tangent so lobe tips flow without Catmull-Rom
2785 REM   cusps. HSCALE = (Delta_t / 6) is the standard
2786 REM   Bezier "third-rule" for chord-aligned handles.
2790 A_AMP = R_BASE * 0.5 + RND(R_BASE * 0.3)
2800 B_AMP = R_BASE * 1.6 + RND(R_BASE * 0.8)
2810 ROT = RND(628) / 100
2820 CO = COS(ROT) : SI = SIN(ROT)
2825 NZ = 0
2830 ELEV = 6
2832 HSCALE = (2 * PI / NCP) / 2
2835 USE_BEZIER = 1
2840 FOR I = 0 TO NCP - 1
2850    T = 0 - PI + I * 2 * PI / NCP
2860    XX = A_AMP * SIN(T)
2870    ZZ = B_AMP * SIN(T) * COS(T)
2872    DXT = A_AMP * COS(T)
2874    DZT = B_AMP * (COS(T) * COS(T) - SIN(T) * SIN(T))
2875    DX = RND(NZ * 2) - NZ : DZ = RND(NZ * 2) - NZ
2876    IF I = 0 OR I = 6 OR I = 12 OR I = 18 THEN DX = 0 : DZ = 0
2880    CX(I) = XX * CO - ZZ * SI + DX
2890    CZ(I) = XX * SI + ZZ * CO + DZ
2900    CY_PATH(I) = ELEV * COS(T)
2902    TX = (DXT * CO - DZT * SI) * HSCALE
2904    TZ = (DXT * SI + DZT * CO) * HSCALE
2906    TY = (0 - ELEV * SIN(T)) * HSCALE
2908    HX_OUT(I) = TX  : HZ_OUT(I) = TZ  : HY_OUT(I) = TY
2909    HX_IN(I)  = 0-TX: HZ_IN(I)  = 0-TZ: HY_IN(I)  = 0-TY
2910 NEXT I
2920 RETURN
2930 GenFigure8G:
2940 REM   Grounded figure-8: loops sit on the floor (CY_PATH=0)
2945 REM   and a TIGHT gaussian bump rises only at the t=0
2950 REM   crossover so one pass arcs steeply up and back down.
2952 REM   Three control points (I=5, 6, 7) sit at the peak so
2954 REM   the spline plateaus over the cross — I=6 is forced to
2956 REM   t=0 (apex) and the neighbours lock the ramp width.
2958 A_AMP = R_BASE * 0.7 + RND(R_BASE * 0.4)
2960 B_AMP = R_BASE * 1.8 + RND(R_BASE * 0.8)
2965 ROT = RND(628) / 100
2970 CO = COS(ROT) : SI = SIN(ROT)
2972 NZ = 0
2975 ELEV = 6 : SIGMA = 0.35
2976 IF RAMP_KIND = 1 THEN SIGMA = 0.25
2977 SIG2 = SIGMA * SIGMA
2978 HSCALE = (2 * PI / NCP) / 2
2979 USE_BEZIER = 1
2980 FOR I = 0 TO NCP - 1
2985    T = 0 - PI + I * 2 * PI / NCP
2993    XX = A_AMP * SIN(T)
2995    ZZ = B_AMP * SIN(T) * COS(T)
2996    DXT = A_AMP * COS(T)
2997    DZT = B_AMP * (COS(T) * COS(T) - SIN(T) * SIN(T))
3000    DX = RND(NZ * 2) - NZ : DZ = RND(NZ * 2) - NZ
3001    IF I = 0 OR I = 6 OR I = 12 OR I = 18 THEN DX = 0 : DZ = 0
3003    IF (RAMP_KIND = 1) AND (I >= 10) AND (I <= 14) THEN DX = 0 : DZ = 0
3005    CX(I) = XX * CO - ZZ * SI + DX
3010    CZ(I) = XX * SI + ZZ * CO + DZ
3015    CY_PATH(I) = ELEV * EXP(0 - T * T / SIG2)
3016    IF (RAMP_KIND = 1) AND (I >= 10) AND (I <= 14) AND (I <> 12) THEN CY_PATH(I) = 0
3017    IF (RAMP_KIND = 1) AND (I = 12) THEN CY_PATH(I) = ELEV
3018    TX = (DXT * CO - DZT * SI) * HSCALE
3019    TZ = (DXT * SI + DZT * CO) * HSCALE
3021    TY = 0
3023    HX_OUT(I) = TX  : HZ_OUT(I) = TZ  : HY_OUT(I) = TY
3024    HX_IN(I)  = 0-TX: HZ_IN(I)  = 0-TZ: HY_IN(I)  = 0-TY
3025 NEXT I
3026 RETURN
