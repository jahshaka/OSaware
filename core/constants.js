'use strict';

// ---------------------------------------------------------------------------
// OSAWARE constants  (modernised from ngbasic-0.2-constants.js)
// ---------------------------------------------------------------------------

// Command return codes
const CMD_OK      = -1;
const CMD_ESYNTAX = -2;
const CMD_ECONTEXT = -3;   // no canvas available
const CMD_EDATA   = -4;
const CMD_END     = -9;

const MAX_LINES   = 100000;

// ---------------------------------------------------------------------------
// Operator precedence  (higher number = higher precedence, evaluated first)
// ---------------------------------------------------------------------------
const OPER_NONE   = 0;
const OPER_PLUS   = 1;   // lowest precedence
const OPER_MINUS  = 2;
const OPER_MODULO = 3;
const OPER_DIV    = 4;
const OPER_DIVI   = 5;
const OPER_MUL    = 6;
const OPER_POW    = 7;   // highest precedence

// ---------------------------------------------------------------------------
// Variable / assignment type tags
// ---------------------------------------------------------------------------
const ASS_ANY          = -1;  // auto-detect
const ASS_NUMBER       =  0;
const ASS_STRING       =  1;
const ASS_ARRAY_NUMBER =  2;
const ASS_ARRAY_STRING =  3;
const ASS_FUNCTION     =  9;

// ---------------------------------------------------------------------------
// Syscall name constants  — use these instead of magic strings in bus.post/call
// Typos in syscall names silently fail; constants catch them at load time.
// ---------------------------------------------------------------------------

// Terminal
const SYS_PRINT         = 'print';
const SYS_PRINT_CHAR    = 'print.char';
const SYS_CLS           = 'cls';
const SYS_COLOUR        = 'colour';
const SYS_LOCATE        = 'locate';
const SYS_INPUT_START   = 'input.start';

// 2D Graphics
const SYS_GFX_CIRCLE    = 'gfx.circle';
const SYS_GFX_FILLCIRC  = 'gfx.fillcircle';
const SYS_GFX_LINE      = 'gfx.line';
const SYS_GFX_RECT      = 'gfx.rect';
const SYS_GFX_FILLRECT  = 'gfx.fillrect';
const SYS_GFX_PSET      = 'gfx.pset';
const SYS_GFX_PRESET    = 'gfx.preset';
const SYS_GFX_PAINT     = 'gfx.paint';
const SYS_GFX_IMAGE     = 'gfx.image';
const SYS_GFX_LOADIMG   = 'gfx.loadimg';
const SYS_GFX_DISPLAY   = 'gfx.display';
const SYS_GFX_IMGLIST   = 'gfx.imglist';
const SYS_GFX_IMGFREE   = 'gfx.imgfree';
const SYS_GFX_CLS       = 'gfx.cls';
const SYS_GFX_POINT     = 'gfx.point';
const SYS_GFX_POINT2    = 'gfx.point2';
const SYS_GFX_COLOUR    = 'gfx.colour';

// 3D / GL
const SYS_GL_INIT       = 'gl.init';
const SYS_GL_CLS        = 'gl.cls';
const SYS_GL_CAMERA     = 'gl.camera';
const SYS_GL_LOOKAT     = 'gl.lookat';
const SYS_GL_DRAW       = 'gl.draw';
const SYS_GL_DRAWALL    = 'gl.drawall';

// Audio
const SYS_SOUND_PLAY    = 'sound.play';
const SYS_SOUND_WAIT    = 'sound.wait';
const SYS_SOUND_RESUME  = 'sound.resume';
const SYS_WAVE_SET      = 'sound.wave';

// Network
const SYS_NET_OPEN      = 'net.open';
const SYS_NET_SEND      = 'net.send';
const SYS_NET_CLOSE     = 'net.close';
const SYS_NET_STATUS    = 'net.status';
const SYS_NET_RECV      = 'net.recv';

// Input queries
const SYS_INPUT_INKEY   = 'input.inkey';
const SYS_INPUT_MOUSE   = 'input.mouse';
const SYS_INPUT_KEYDOWN = 'input.keydown';
