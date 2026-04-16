0 CLS
1 COLOUR 6,9: ? CENTER$("--=[ ValuHack 1.2 ]=--") : COLOUR 6,1: PRINT ""
2 PRINT CENTER$("Ported to OSAWARE by Jahshaka in 2025")
3 PRINT "" : PRINT ""
4 PRINT TAB$(5);"   MAIN MENU"
5 PRINT ""
6 PRINT TAB$(5);"1) Serialz, Warez, and Crackz"
7 PRINT TAB$(5);"2) Hotmail/Yahoo Account Access"
8 PRINT TAB$(5);"3) AOL Account Access"
9 PRINT TAB$(5);"4) Website Defacement/Hijacking"
10 PRINT ""
15 PRINT TAB$(5);"Selection: ";:INPUT SEL
20 PRINT ""
25 IF SEL>4 THEN GOTO 27 ELSE 26
26 IF SEL<1 THEN GOTO 27 ELSE 30
27 PRINT "Select a number from 1-4." : GOTO 10
30 PRINT "What is your name? ";:INPUT LUSER$
35 IF SEL=1 THEN GOSUB 100
40 IF SEL=2 THEN GOSUB 200
42 IF SEL=3 THEN GOSUB 300
44 IF SEL=4 THEN GOSUB 400
46 IF SEL=0 GOTO 26
50 PRINT LUSER$;" should try a different newsgroup."
51 PRINT ""
52 PRINT "FOAD Scriptkiddiot"
53 PRINT ""
54 PRINT "ngLART end"
55 INPUT done
58 END
100 PRINT "What program do you need? ";:INPUT ITEM$
102 PRINT ""
104 PRINT LUSER$;" wants an illegal copy of ";ITEM$;" but that isn't hacking."
108 RETURN
200 PRINT "What is the account you wish to gain access to? ";:INPUT ITEM$
202 PRINT ""
204 PRINT LUSER$;" wants to break into ";ITEM$;" but that isn't hacking."
208 RETURN
300 PRINT "What is the screenname of the account you wish to gain access to? ";:INPUT ITEM$
302 ITEM$=ITEM$+"@aol.com"
304 PRINT ""
308 PRINT LUSER$;" wants to gain access to ";ITEM$; " but that isn't hacking."
310 RETURN
400 PRINT "What is the website you wish to control? ";:INPUT ITEM$
402 PRINT ""
404 PRINT LUSER$;" wants to take over ";ITEM$;" but that isn't hacking."
