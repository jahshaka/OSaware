1 REM *** OSAWARE ENGINE PROFILER ***
2 CLS : COLOUR 3
5 PRINT "OSAWARE ENGINE PROFILER"
6 PRINT "========================"
7 PRINT ""
10 REM --- TEST 1: Integer loop (assignments) ---
11 PRINT "T1: Integer loop (100k iters)..."
12 T=TIMER
13 I=0
14 WHILE I<100000
15   I=I+1
16 WEND
17 T1=TIMER-T
18 PRINT "  Done: ";T1;"ms"
20 REM --- TEST 2: Arithmetic expressions ---
21 PRINT "T2: Arithmetic (50k iters)..."
22 T=TIMER
23 X=0 : Y=1 : Z=2
24 I=0
25 WHILE I<50000
26   X=Y*Y-Z*Z+X
27   Y=2*Y*Z+X
28   Z=X
29   I=I+1
30 WEND
31 T2=TIMER-T
32 PRINT "  Done: ";T2;"ms"
40 REM --- TEST 3: FOR/NEXT loop ---
41 PRINT "T3: FOR/NEXT (100k iters)..."
42 T=TIMER
43 S=0
44 FOR I=1 TO 100000
45   S=S+I
46 NEXT I
47 T3=TIMER-T
48 PRINT "  Done: ";T3;"ms  Sum=";S
50 REM --- TEST 4: String operations ---
51 PRINT "T4: String concat (5k iters)..."
52 T=TIMER
53 A$=""
54 FOR I=1 TO 5000
55   A$=A$+"X"
56 NEXT I
57 T4=TIMER-T
58 PRINT "  Done: ";T4;"ms  Len=";LEN(A$)
60 REM --- TEST 5: PSET pixel drawing ---
61 PRINT "T5: PSET 10k pixels..."
62 T=TIMER
63 DELAY 0
64 FOR I=0 TO 9999
65   PSET I MOD 780, INT(I/780), (I MOD 15)+1
66 NEXT I
67 T5=TIMER-T
68 COLOUR 3 : PRINT "  Done: ";T5;"ms"
70 REM --- TEST 6: Mandelbrot inner loop simulation ---
71 PRINT "T6: Mandel inner loop (20k iters)..."
72 T=TIMER
73 ZR=0 : ZI=0 : CR=0.25 : CI=0.5 : IT=0
74 WHILE IT<20000
75   TMP=ZR*ZR-ZI*ZI+CR
76   ZI=2*ZR*ZI+CI
77   ZR=TMP
78   IT=IT+1
79 WEND
80 T6=TIMER-T
81 PRINT "  Done: ";T6;"ms"
90 REM --- SUMMARY ---
91 PRINT ""
92 COLOUR 2 : PRINT "SUMMARY (lower=faster)"
93 COLOUR 7
94 TTOT=T1+T2+T3+T4+T5+T6
95 PRINT "  T1 int loop:   ";T1;"ms"
96 PRINT "  T2 arithmetic: ";T2;"ms"
97 PRINT "  T3 for/next:   ";T3;"ms"
98 PRINT "  T4 strings:    ";T4;"ms"
99 PRINT "  T5 pset:       ";T5;"ms"
100 PRINT "  T6 mandel:     ";T6;"ms"
101 COLOUR 3 : PRINT "  TOTAL:        ";TTOT;"ms"
