"""Write mrzero_like_small.npz: an MRzero-format 3-D phantom for the browser tests.

Same keys, dtypes and layout as MRzero's BrainWeb phantoms (x, y, z C-order
float maps plus FOV in metres), but synthetic: an ellipsoidal "head" of white
matter with a CSF core and a grey-matter shell, small enough to commit.
Run with numpy installed:  python make_mrzero_like.py
"""
import numpy as np

nx, ny, nz = 20, 24, 6
x, y, z = np.meshgrid((np.arange(nx) - nx / 2 + 0.5) / (nx / 2),
                      (np.arange(ny) - ny / 2 + 0.5) / (ny / 2),
                      (np.arange(nz) - nz / 2 + 0.5) / (nz / 2), indexing='ij')
r = np.sqrt(x**2 + y**2 + (0.6 * z)**2)
head, core, shell = r < 0.9, r < 0.35, (r > 0.7) & (r < 0.9)
tissue = np.where(core, 2, np.where(shell, 1, 0))           # 0 WM, 1 GM, 2 CSF
pd = np.where(head, np.choose(tissue, [0.69, 0.8, 1.0]), 0.0)
t1 = np.where(head, np.choose(tissue, [0.83, 1.33, 4.0]), 0.0)
t2 = np.where(head, np.choose(tissue, [0.08, 0.11, 2.0]), 0.0)
t2dash = np.where(head, 0.05, 0.0)
d = np.where(head, np.choose(tissue, [0.7, 0.8, 3.0]), 0.0)  # 1e-9 m^2/s, as MRzero stores it
np.savez_compressed('mrzero_like_small.npz',
                    PD_map=pd.astype(np.float32), T1_map=t1.astype(np.float32), T2_map=t2.astype(np.float32),
                    T2dash_map=t2dash.astype(np.float32), D_map=d.astype(np.float32),
                    FOV=np.array([0.2, 0.24, 0.06]))

# MRzero's load_mat layout: one array [x, y, 5] of PD, T1, T2, B0, B1, saved
# compressed as MATLAB does by default (zlib, miCOMPRESSED).
import scipy.io
mid = nz // 2
stack = np.stack([pd[:, :, mid], t1[:, :, mid], t2[:, :, mid],
                  np.where(head[:, :, mid], 20.0 * x[:, :, mid], 0.0),       # B0 [Hz]
                  np.where(head[:, :, mid], 1.0 - 0.1 * y[:, :, mid] ** 2, 0.0)], axis=-1)  # B1
scipy.io.savemat('mrzero_like_2d.mat', {'cropped_brain': stack.astype(np.float32)}, do_compression=True)

# One NIfTI map per file, named by suffix (PD has none).
import nibabel as nib
affine = np.diag([10.0, 10.0, 10.0, 1.0])                                  # 10 mm voxels
for suffix, values in [('', pd), ('_T1', t1), ('_T2', t2)]:
    nib.save(nib.Nifti1Image(values.astype(np.float32), affine), f'maps{suffix}.nii.gz')
