/* ═══════════════════════════════════════════════════════════════════════
   Wheel zoom step, shared by the waveform, minimap and k-space wheel handlers
   of both lanes (web/index.html calls these as globals of this bundle).
   ═══════════════════════════════════════════════════════════════════════ */

/* Calibration, to tune by feel.  *_NOTCH is the zoom for one notch of a
   standard mouse wheel (1.2 = 20 % per notch); *_MAX_STEP caps any single
   event, and is the fixed step every event took before zoom followed deltaY. */
var WHEEL_ZOOM_NOTCH=1.2,WHEEL_ZOOM_MAX_STEP=1.3;          // waveform time, amplitude, minimap
var KSPACE_WHEEL_ZOOM_NOTCH=1.2,KSPACE_WHEEL_ZOOM_MAX_STEP=1.25;

/* Pixels per deltaY unit in each deltaMode.  Chrome and Edge report a notch as
   100 px, Firefox in line mode as 3 lines, so a line is a third of a notch.
   A page has no standard size; 800 px is past the clamp at the calibration
   above, so a page event takes the maximum step. */
var WHEEL_NOTCH_PX=100,WHEEL_LINE_PX=100/3,WHEEL_PAGE_PX=800;

/**
 * Zoom factor for one wheel event: above 1 zooms in (deltaY < 0), below 1
 * out, exactly 1 with no vertical delta.  Exponential in the delta, so a
 * trackpad's many small events multiply to the zoom of one event carrying
 * their summed delta, within the per-event clamp [1/maxStep, maxStep].
 */
function wheelZoomFactor(e,notch,maxStep){
  var px=+e.deltaY;
  if(!isFinite(px)||px===0)return 1;
  if(e.deltaMode===1)px*=WHEEL_LINE_PX;else if(e.deltaMode===2)px*=WHEEL_PAGE_PX;
  return Math.max(1/maxStep,Math.min(maxStep,Math.pow(notch,-px/WHEEL_NOTCH_PX)));
}
