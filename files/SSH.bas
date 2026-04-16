0 REM *** SSH — WebSocket SSH Terminal Client ***
1 REM *** Connects via a WebSocket-to-SSH bridge server ***
5 CLS : COLOUR 3
10 PRINT "SSH TERMINAL CLIENT"
20 PRINT "==================="
30 PRINT ""
40 PRINT "This connects to an SSH session via a WebSocket bridge."
50 PRINT "You need a bridge server running, e.g.:"
60 PRINT "  github.com/nicowillis/websockify-ssh"
70 PRINT "  or: npm install -g wssh && wssh --port 5000"
80 PRINT ""
90 PRINT "Bridge URL format: ws://yourserver:5000"
100 PRINT "or secure:         wss://yourserver:443"
110 PRINT ""
120 INPUT "Bridge URL (ws://...): ";WS_URL$
130 IF WS_URL$="" THEN PRINT "Cancelled." : END
140 IF LEFT$(WS_URL$,2)<>"ws" THEN PRINT "URL must start with ws:// or wss://" : GOTO 120
150 PRINT ""
160 INPUT "Host to SSH to: ";SSH_HOST$
170 IF SSH_HOST$="" THEN PRINT "Cancelled." : END
180 INPUT "Username: ";SSH_USER$
190 IF SSH_USER$="" THEN PRINT "Cancelled." : END
200 PRINT ""
210 PRINT "Connecting to bridge: ";WS_URL$
220 WS.OPEN WS_URL$
230 IF WS.STATUS<>2 THEN PRINT "Connection failed. Check bridge URL." : END
240 PRINT "Bridge connected! Sending SSH request..."
250 PRINT ""
260 REM -- Send connection request as JSON
270 REQ$="{""host"":"""+SSH_HOST$+""",""user"":"""+SSH_USER$+"""}"
280 WS.SEND REQ$
290 SLEEP 500
300 REM -- Read any initial response (banner/prompt)
310 MSG$=WS.RECV$
320 IF MSG$<>"" THEN PRINT MSG$;
330 MSG$=WS.RECV$
340 IF MSG$<>"" THEN PRINT MSG$;
350 SLEEP 200
360 MSG$=WS.RECV$
370 IF MSG$<>"" THEN PRINT MSG$;
380 REM -- Check if asking for password
390 PRINT ""
400 PRINT "Enter SSH password (will be sent to bridge):"
410 INPUT PASSWORD$
420 IF PASSWORD$="" THEN GOTO 500
430 WS.SEND PASSWORD$+CHR$(13)
440 SLEEP 800
450 MSG$=WS.RECV$
460 IF MSG$<>"" THEN PRINT MSG$;
470 SLEEP 300
480 MSG$=WS.RECV$
490 IF MSG$<>"" THEN PRINT MSG$;
500 REM ===========================
501 REM INTERACTIVE TERMINAL LOOP
502 REM ===========================
510 PRINT ""
520 PRINT "--- SSH Session Active ---"
530 PRINT "Type commands. Blank line = exit."
540 PRINT ""
600 REM -- Flush any pending output
610 MSG$=WS.RECV$
620 IF MSG$<>"" THEN PRINT MSG$; : GOTO 610
630 REM -- Get user input
640 INPUT "> ";CMD$
650 IF CMD$="" THEN GOTO 900
660 IF UPPER$(CMD$)="EXIT" OR UPPER$(CMD$)="QUIT" THEN GOTO 900
670 REM -- Send command with carriage return
680 WS.SEND CMD$+CHR$(13)
690 SLEEP 300
700 REM -- Read and display response (poll for up to 2 seconds)
710 FOR POLL=1 TO 20
720   MSG$=WS.RECV$
730   IF MSG$<>"" THEN PRINT MSG$; : POLL=0
740   IF POLL>0 THEN SLEEP 100
750 NEXT POLL
760 PRINT ""
770 GOTO 600
900 REM -- Disconnect
910 PRINT ""
920 PRINT "Closing connection..."
930 WS.SEND "exit"+CHR$(13)
940 SLEEP 200
950 WS.CLOSE
960 PRINT "Disconnected."
