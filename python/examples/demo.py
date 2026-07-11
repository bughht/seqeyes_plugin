#!/usr/bin/env python3
"""
demo.py — SeqEyes with 3 official pypulseq example sequences.
Run:  python demo.py
Each ``seq.plot()`` opens an interactive viewer in your default browser.
"""

import seqeyes
import numpy as np
import pypulseq as pp

# ── Enable SeqEyes (once per session) ─────────────────────────────────
seqeyes.set(time_disp="ms", grad_disp="kHz/m")
print(f"SeqEyes {seqeyes.__version__} — seq.plot() is now interactive!")


# ══════════════════════════════════════════════════════════════════════════
# 1. GRE  (from pypulseq/examples/scripts/write_gre.py)
# ══════════════════════════════════════════════════════════════════════════
fov_gre = 256e-3; n_x_gre = 64; n_y_gre = 64
flip_gre = 10; slice_thickness = 3e-3; tr_gre = 12e-3; te_gre = 5e-3

system_gre = pp.Opts(max_grad=28, grad_unit='mT/m', max_slew=150, slew_unit='T/m/s',
                      rf_ringdown_time=20e-6, rf_dead_time=100e-6, adc_dead_time=10e-6)
seq_gre = pp.Sequence(system_gre)

rf, gz, _ = pp.make_sinc_pulse(flip_angle=np.deg2rad(flip_gre), duration=3e-3,
                                slice_thickness=slice_thickness, apodization=0.42,
                                time_bw_product=4, system=system_gre, return_gz=True,
                                delay=system_gre.rf_dead_time, use='excitation')

delta_kx = 1 / fov_gre; delta_ky = 1 / fov_gre
gx = pp.make_trapezoid(channel='x', flat_area=n_x_gre * delta_kx, flat_time=3.2e-3, system=system_gre)
adc = pp.make_adc(num_samples=n_x_gre, duration=gx.flat_time, delay=gx.rise_time, system=system_gre)
gx_pre = pp.make_trapezoid(channel='x', area=-gx.area / 2, duration=1e-3, system=system_gre)
gz_reph = pp.make_trapezoid(channel='z', area=-gz.area / 2, duration=1e-3, system=system_gre)
gx_spoil = pp.make_trapezoid(channel='x', area=2 * n_x_gre * delta_kx, system=system_gre)
gz_spoil = pp.make_trapezoid(channel='z', area=4 / slice_thickness, system=system_gre)
phase_areas = (np.arange(n_y_gre) - n_y_gre / 2) * delta_ky

te_delay = te_gre - (pp.calc_duration(gz, rf) - pp.calc_rf_center(rf)[0] - rf.delay) - pp.calc_duration(gx_pre) - pp.calc_duration(gx) / 2 - pp.eps
te_delay = np.ceil(te_delay / seq_gre.grad_raster_time) * seq_gre.grad_raster_time
tr_delay = tr_gre - pp.calc_duration(gz, rf) - pp.calc_duration(gx_pre) - pp.calc_duration(gx) - te_delay
tr_delay = np.ceil(tr_delay / seq_gre.grad_raster_time) * seq_gre.grad_raster_time

rf_phase = 0; rf_inc = 0
for i_phase in range(n_y_gre):
    rf.phase_offset = rf_phase / 180 * np.pi
    adc.phase_offset = rf_phase / 180 * np.pi
    rf_inc = divmod(rf_inc + 117, 360.0)[1]
    rf_phase = divmod(rf_phase + rf_inc, 360.0)[1]
    seq_gre.add_block(rf, gz)
    gy_pre = pp.make_trapezoid(channel='y', area=phase_areas[i_phase], duration=pp.calc_duration(gx_pre), system=system_gre)
    seq_gre.add_block(gx_pre, gy_pre, gz_reph)
    seq_gre.add_block(pp.make_delay(te_delay))
    seq_gre.add_block(gx, adc)
    gy_pre.amplitude = -gy_pre.amplitude
    seq_gre.add_block(pp.make_delay(tr_delay), gx_spoil, gy_pre, gz_spoil)

print("1/3  GRE sequence — opening viewer ...")
seq_gre.plot(time_range=(0, 0.05))  # zoom to first 50 ms


# ══════════════════════════════════════════════════════════════════════════
# 2. EPI  (from pypulseq/examples/scripts/write_epi.py)
# ══════════════════════════════════════════════════════════════════════════
fov_epi = 220e-3; n_x_epi = 64; n_y_epi = 64; n_slices = 3

system_epi = pp.Opts(max_grad=32, grad_unit='mT/m', max_slew=130, slew_unit='T/m/s',
                      rf_ringdown_time=30e-6, rf_dead_time=100e-6)
seq_epi = pp.Sequence(system_epi)

rf_epi, gz_epi, _ = pp.make_sinc_pulse(flip_angle=np.pi / 2, system=system_epi, duration=3e-3,
                                        slice_thickness=slice_thickness, apodization=0.5,
                                        time_bw_product=4, return_gz=True,
                                        delay=system_epi.rf_dead_time, use='excitation')

dkx = 1 / fov_epi; dky = 1 / fov_epi; k_width = n_x_epi * dkx
adc_dwell = 4e-6; adc_duration = n_x_epi * adc_dwell
gx_flat = np.ceil(adc_duration * 1e5) * 1e-5
gx_epi = pp.make_trapezoid(channel='x', system=system_epi, amplitude=k_width / adc_duration, flat_time=gx_flat)
adc_epi = pp.make_adc(num_samples=n_x_epi, duration=adc_duration,
                       delay=gx_epi.rise_time + gx_flat / 2 - (adc_duration - adc_dwell) / 2)
pre_time = 8e-4
gx_pre_epi = pp.make_trapezoid(channel='x', system=system_epi, area=-gx_epi.area / 2, duration=pre_time)
gz_reph_epi = pp.make_trapezoid(channel='z', system=system_epi, area=-gz_epi.area / 2, duration=pre_time)
gy_pre_epi = pp.make_trapezoid(channel='y', system=system_epi, area=-n_y_epi / 2 * dky, duration=pre_time)
gy_blip_dur = np.ceil(2 * np.sqrt(dky / system_epi.max_slew) / 10e-6) * 10e-6
gy_epi = pp.make_trapezoid(channel='y', system=system_epi, area=dky, duration=gy_blip_dur)

for i_slice in range(n_slices):
    rf_epi.freq_offset = gz_epi.amplitude * slice_thickness * (i_slice - (n_slices - 1) / 2)
    seq_epi.add_block(rf_epi, gz_epi)
    seq_epi.add_block(gx_pre_epi, gy_pre_epi, gz_reph_epi)
    for _ in range(n_y_epi):
        seq_epi.add_block(gx_epi, adc_epi)
        seq_epi.add_block(gy_epi)
        gx_epi.amplitude = -gx_epi.amplitude

print("2/3  EPI sequence — opening viewer ...")
seq_epi.plot(show_blocks=True)  # show block boundaries


# ══════════════════════════════════════════════════════════════════════════
# 3. Radial GRE  (from pypulseq/examples/scripts/write_radial_gre.py)
# ══════════════════════════════════════════════════════════════════════════
fov_rad = 260e-3; n_x_rad = 64; flip_rad = 10; n_spokes = 60; n_dummy = 20
tr_rad = 20e-3; te_rad = 8e-3

system_rad = pp.Opts(max_grad=28, grad_unit='mT/m', max_slew=120, slew_unit='T/m/s',
                      rf_ringdown_time=20e-6, rf_dead_time=100e-6, adc_dead_time=10e-6)
seq_rad = pp.Sequence(system_rad)

rf_rad, gz_rad, _ = pp.make_sinc_pulse(apodization=0.5, duration=4e-3,
                                        flip_angle=np.deg2rad(flip_rad),
                                        slice_thickness=slice_thickness, system=system_rad,
                                        time_bw_product=4, return_gz=True,
                                        delay=system_rad.rf_dead_time, use='excitation')

dkx_rad = 1 / fov_rad
gx_rad = pp.make_trapezoid(channel='x', flat_area=n_x_rad * dkx_rad, flat_time=6.4e-3 / 5, system=system_rad)
adc_rad = pp.make_adc(num_samples=n_x_rad, duration=gx_rad.flat_time, delay=gx_rad.rise_time, system=system_rad)
gx_pre_rad = pp.make_trapezoid(channel='x', area=-gx_rad.area / 2 - dkx_rad / 2, duration=2e-3, system=system_rad)
gz_reph_rad = pp.make_trapezoid(channel='z', area=-gz_rad.area / 2, duration=2e-3, system=system_rad)
gx_spoil_rad = pp.make_trapezoid(channel='x', area=0.5 * n_x_rad * dkx_rad, system=system_rad)
gz_spoil_rad = pp.make_trapezoid(channel='z', area=4 / slice_thickness, system=system_rad)

te_delay_rad = te_rad - pp.calc_duration(gx_pre_rad) - gz_rad.fall_time - gz_rad.flat_time / 2 - pp.calc_duration(gx_rad) / 2
te_delay_rad = np.ceil(te_delay_rad / seq_rad.grad_raster_time) * seq_rad.grad_raster_time
tr_delay_rad = tr_rad - pp.calc_duration(gx_pre_rad) - pp.calc_duration(gz_rad) - pp.calc_duration(gx_rad) - te_delay_rad
tr_delay_rad = np.ceil(tr_delay_rad / seq_rad.grad_raster_time) * seq_rad.grad_raster_time

spoke_angle = np.pi / n_spokes
rf_phase = 0; rf_inc = 0
for i_spoke in range(-n_dummy, n_spokes + 1):
    rf_rad.phase_offset = rf_phase / 180 * np.pi
    adc_rad.phase_offset = rf_phase / 180 * np.pi
    rf_inc = divmod(rf_inc + 117, 360.0)[1]
    rf_phase = divmod(rf_inc + rf_phase, 360.0)[1]
    seq_rad.add_block(rf_rad, gz_rad)
    phi = spoke_angle * (i_spoke - 1)
    seq_rad.add_block(*pp.rotate(gx_pre_rad, gz_reph_rad, angle=phi, axis='z'))
    seq_rad.add_block(pp.make_delay(te_delay_rad))
    if i_spoke > 0:
        seq_rad.add_block(*pp.rotate(gx_rad, adc_rad, angle=phi, axis='z'))
    else:
        seq_rad.add_block(*pp.rotate(gx_rad, angle=phi, axis='z'))
    seq_rad.add_block(*pp.rotate(gx_spoil_rad, gz_spoil_rad, pp.make_delay(tr_delay_rad), angle=phi, axis='z'))

print("3/3  Radial GRE sequence — opening viewer ...")
seq_rad.plot(theme="dark")  # overrides 'system' default from set()

print("\nDone! 3 viewer tabs opened.")
