/* ═══════════════════════════════════════════════════════════════════════
   Colormaps for the gradient spectrogram

   Pure module: every entry point takes its inputs as arguments and reads no
   host globals, so the same code serves the VS Code webview, the standalone
   web app and the MATLAB toolbox.

   The perceptual maps are stored as 17 anchor colours sampled at 1/16 steps
   and interpolated to 256 entries at first use. Anchors rather than full
   tables because 5 x 256 x 3 literals would dominate the bundle; 17 anchors
   reproduce these maps to within a couple of 8-bit levels, which is well
   below what is visible in a spectrogram.

   Viridis is the default: perceptually uniform, and legible in both light and
   dark themes. Turbo is offered because people ask for it, and its tooltip
   says it is not perceptually uniform.
   ═══════════════════════════════════════════════════════════════════════ */

var SG_COLORMAP_ANCHORS={
  viridis:[[68,1,84],[72,26,108],[71,47,125],[65,68,135],[57,86,140],[49,104,142],[42,120,142],[35,136,142],[31,152,139],[34,168,132],[53,183,121],[84,197,104],[122,209,81],[165,219,54],[210,226,27],[247,230,38],[253,231,37]],
  magma:[[0,0,4],[10,7,35],[28,16,68],[54,15,104],[81,18,124],[107,28,129],[132,37,129],[158,47,127],[183,55,121],[209,64,109],[230,81,93],[244,106,85],[251,136,97],[254,166,118],[254,196,144],[253,226,175],[252,253,191]],
  inferno:[[0,0,4],[9,6,32],[25,11,62],[49,10,93],[74,12,107],[98,24,108],[120,34,107],[143,44,103],[166,54,96],[188,66,87],[208,81,75],[226,100,60],[240,122,43],[248,149,25],[251,178,21],[246,215,70],[252,255,164]],
  turbo:[[48,18,59],[65,69,171],[70,116,240],[57,162,252],[34,204,214],[28,231,162],[54,246,112],[109,253,62],[160,253,58],[196,240,62],[226,220,55],[248,193,44],[254,160,32],[250,122,22],[237,86,12],[215,55,7],[122,4,3]],
  grey:[[0,0,0],[255,255,255]]
};

var SG_COLORMAP_LABELS={
  viridis:'Viridis',
  magma:'Magma',
  inferno:'Inferno',
  turbo:'Turbo',
  grey:'Greyscale',
  theme:'Theme'
};

var SG_COLORMAP_TOOLTIPS={
  viridis:'Viridis — perceptually uniform (default)',
  magma:'Magma — perceptually uniform',
  inferno:'Inferno — perceptually uniform',
  turbo:'Turbo — high contrast, but NOT perceptually uniform: equal colour steps do not mean equal dB steps',
  grey:'Greyscale',
  theme:'Theme-tinted ramp built from the current colour scheme'
};

var SG_COLORMAP_NAMES=['viridis','magma','inferno','turbo','grey','theme'];

var _sgLutCache={};

/** Build a 256x3 Uint8Array LUT by interpolating evenly spaced anchors. */
function sgBuildLut(anchors){
  var lut=new Uint8Array(256*3),n=anchors.length-1;
  for(var i=0;i<256;i++){
    var position=i/255*n,lo=Math.floor(position),hi=Math.min(n,lo+1),a=position-lo;
    var c0=anchors[lo],c1=anchors[hi],o=i*3;
    lut[o]=Math.round(c0[0]+(c1[0]-c0[0])*a);
    lut[o+1]=Math.round(c0[1]+(c1[1]-c0[1])*a);
    lut[o+2]=Math.round(c0[2]+(c1[2]-c0[2])*a);
  }
  return lut;
}

/** Parse '#rgb' / '#rrggbb' / 'rgb(r,g,b)' to [r,g,b]; grey on failure. */
function sgParseColor(value){
  if(!value)return[128,128,128];
  var text=String(value).trim();
  if(text.charAt(0)==='#'){
    var hex=text.substring(1);
    if(hex.length===3)hex=hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if(hex.length>=6){
      return[parseInt(hex.substring(0,2),16),parseInt(hex.substring(2,4),16),parseInt(hex.substring(4,6),16)];
    }
  }
  var m=text.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if(m)return[+m[1],+m[2],+m[3]];
  return[128,128,128];
}

/**
 * LUT for a named colormap.
 *
 * `theme` is rebuilt on every call from the supplied computed style, because
 * it depends on the active colour scheme; the fixed maps are cached.
 */
function sgColormapLut(name,computedStyle){
  if(name==='theme'){
    var bg=sgParseColor(computedStyle&&computedStyle.getPropertyValue('--trbg'));
    var mid=sgParseColor(computedStyle&&computedStyle.getPropertyValue('--adc'));
    var hot=sgParseColor(computedStyle&&computedStyle.getPropertyValue('--rf'));
    return sgBuildLut([bg,mid,hot]);
  }
  if(_sgLutCache[name])return _sgLutCache[name];
  var anchors=SG_COLORMAP_ANCHORS[name]||SG_COLORMAP_ANCHORS.viridis;
  _sgLutCache[name]=sgBuildLut(anchors);
  return _sgLutCache[name];
}

/** Colour of one normalised value in [0,1], as [r,g,b]. */
function sgLutSample(lut,normalized){
  var index=Math.max(0,Math.min(255,Math.round(normalized*255)))*3;
  return[lut[index],lut[index+1],lut[index+2]];
}

/** `rgb(...)` string for one normalised value — for legends and colorbars. */
function sgLutCss(lut,normalized){
  var c=sgLutSample(lut,normalized);
  return'rgb('+c[0]+','+c[1]+','+c[2]+')';
}
