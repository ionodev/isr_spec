#!/usr/bin/env python3
"""Compare the Rust spectrum with jvierine/isr_spec's isr_spectrum.

Usage: compare_isr_spec.py PATH_TO_DIR_WITH_isr_spec.py

Runs both on the same cases (v_los = 0, since isr_spec has no drift) and
prints the largest difference relative to each spectrum's peak, the
difference in total power, and the run times. Writes comparison.png.
"""
import os
import subprocess
import sys
import time
from multiprocessing import Pool

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DUMP = os.path.join(HERE, "..", "target", "release", "examples", "dump")

# name, radar f (Hz), ne, te, ti, m1, m2, frac2, B (T), alpha (deg), f_min, f_max, n,
# and isr_spec's ion integration limit (s; isr_spec's own value is 1e-3).
# At 50 MHz the ion ACF lasts longer than 1e-3 s, so isr_spec is run there
# both as it is and with the ion integral extended to 3e-2 s.
CASES = [
    ("Millstone zenith, O+", 440.2e6, 1e11, 2000.0, 1000.0, 16, 1, 0.0, 50e-6, 72.0, -25e3, 25e3, 200, 1e-3),
    ("isr_spec spec_test mix 80% H+", 430e6, 2e10, 1500.0, 1000.0, 16, 1, 0.8, 25e-6, 45.0, -60e3, 60e3, 200, 1e-3),
    ("224 MHz, O2+, Te=Ti", 224e6, 3e11, 2000.0, 2000.0, 32, 1, 0.0, 51e-6, 90.0, -15e3, 15e3, 200, 1e-3),
    ("50 MHz, O+, Te/Ti=3 (isr_spec as is)", 50e6, 1e12, 3000.0, 1000.0, 16, 1, 0.0, 25e-6, 30.0, -3e3, 3e3, 200, 1e-3),
    ("50 MHz, O+, Te/Ti=3 (ion limit 3e-2 s)", 50e6, 1e12, 3000.0, 1000.0, 16, 1, 0.0, 25e-6, 30.0, -3e3, 3e3, 200, 3e-2),
    ("electron line and plasma lines", 440.2e6, 1e11, 2000.0, 1000.0, 16, 1, 0.0, 50e-6, 72.0, -4e6, 4e6, 400, 1e-3),
]


def run_python(case, isr_spec_dir):
    sys.path.insert(0, isr_spec_dir)
    import isr_spec
    name, f, ne, te, ti, m1, m2, fr2, b, alpha, fmin, fmax, n, ion_inf = case
    # isr_spectrum calls gordoyev for the ions with its default inf
    d = list(isr_spec.gordoyev.__defaults__)
    d[-1] = ion_inf
    isr_spec.gordoyev.__defaults__ = tuple(d)
    fr = [1.0 - fr2, fr2] if fr2 > 0 else [1.0]
    plpar = {"t_i": [ti] * len(fr), "t_e": te, "m_i": [m1, m2][:len(fr)], "n_e": ne, "freq": f,
             "B": b, "alpha": alpha, "ion_fractions": fr}
    freq = np.linspace(fmin, fmax, n)
    t0 = time.time()
    spec = isr_spec.isr_spectrum(2 * np.pi * freq, plpar=plpar, n_points=1e4, ni_points=1e4)
    return freq, np.real(spec), time.time() - t0


def run_rust(case):
    name, f, ne, te, ti, m1, m2, fr2, b, alpha, fmin, fmax, n, ion_inf = case
    args = [str(x) for x in (f, ne, te, ti, m1, m2, fr2, b, alpha, 0.0, fmin, fmax, n)]
    out = subprocess.run([DUMP] + args, capture_output=True, text=True, check=True)
    ms = float(out.stderr.split()[2])
    d = np.genfromtxt(out.stdout.splitlines(), delimiter=",", names=True)
    return d["freq"], d["total"], ms / 1e3


def main():
    isr_spec_dir = os.path.abspath(sys.argv[1])
    with Pool(len(CASES)) as pool:
        py = pool.starmap(run_python, [(c, isr_spec_dir) for c in CASES])
    fig, axes = plt.subplots(len(CASES), 2, figsize=(11, 3.0 * len(CASES)))
    print("%-40s %12s %12s %10s %10s" % ("case", "max|diff|/pk", "power diff", "python s", "rust ms"))
    for i, case in enumerate(CASES):
        fp, sp, tp = py[i]
        fr, sr, tr = run_rust(case)
        assert np.allclose(fp, fr)
        pk = np.nanmax(sp)
        diff = np.nanmax(np.abs(sr - sp)) / pk
        pw = (np.sum(sr) - np.nansum(sp)) / np.nansum(sp)
        print("%-40s %12.2e %11.2e%% %10.1f %10.2f" % (case[0], diff, 100 * pw, tp, tr * 1e3))
        unit, scale = ("kHz", 1e3) if abs(case[11]) < 1e6 else ("MHz", 1e6)
        ax = axes[i, 0]
        ax.semilogy(fp / scale, sp, "k-", lw=3, alpha=0.35, label="isr_spec (Python)")
        ax.semilogy(fr / scale, sr, "C1-", lw=1, label="isr_spec_web (Rust)")
        ax.set_title(case[0], fontsize=10)
        ax.set_xlabel("Doppler frequency (%s)" % unit)
        ax.set_ylabel(r"$S$ (m$^{-3}$ Hz$^{-1}$)")
        ax.legend(fontsize=8)
        ax = axes[i, 1]
        ax.plot(fp / scale, (sr - sp) / pk, "C3-")
        ax.set_xlabel("Doppler frequency (%s)" % unit)
        ax.set_ylabel("(Rust - Python) / peak")
        ax.set_title("max |difference| = %.1e of the peak" % diff, fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(HERE, "comparison.png"), dpi=110)


if __name__ == "__main__":
    main()
