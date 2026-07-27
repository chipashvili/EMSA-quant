"""``femsa-fit`` — fit apparent Kd from fEMSA band intensities.

    femsa-fit gel1_quant.csv gel2_quant.csv gel3_quant.csv

Reads one or more CSVs of band intensities (from this app's Quantify
panel, from Fiji, or from anywhere else — see ``dataset.py`` for the
accepted shapes), fits the exact 1:1 quadratic and the hyperbolic
Langmuir model to each replicate independently, and writes a report, a
parameter table, a per-point table, and a figure.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

from gel_annotator.fit import dataset, models, report


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="femsa-fit",
        description="Fit apparent Kd from fEMSA titration band intensities.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Each input file may contain several replicates (split on a\n"
            "'replicate' column) or be one replicate per file. Every replicate\n"
            "is fitted independently and the Kd values combined as a geometric\n"
            "mean, which is what the log-normal distribution of Kd calls for.\n"
        ),
    )
    p.add_argument("csv", nargs="+", type=Path, help="Band-intensity CSV file(s).")
    p.add_argument("-o", "--outdir", type=Path, default=None,
                   help="Output directory (default: alongside the first input).")
    p.add_argument("--prefix", default=None,
                   help="Output filename stem (default: from the first input).")
    p.add_argument("--probe-nm", type=float, default=8.0,
                   help="Total probe concentration Dt in nM, used by the quadratic "
                        "model. Overridden per-file by a probe_nm column. Default: 8.")
    p.add_argument("--fmax", type=float, default=None,
                   help="Pin fmax instead of letting it float. Leave unset unless "
                        "there is a specific reason: an fmax that floats well below 1 "
                        "is a useful flag for inactive protein or damaged probe.")
    p.add_argument("--no-hill", action="store_true",
                   help="Skip the Hill fit.")
    p.add_argument("--drop-saturated", action="store_true",
                   help="Exclude points whose ROI was flagged saturated. Worth running "
                        "both ways — the difference tells you how much saturation is "
                        "moving the answer.")
    p.add_argument("--method", choices=["ratio", "depletion", "both"], default="both",
                   help="Which f_bound estimator(s) to fit. Default: both, so the two "
                        "can be compared (their disagreement diagnoses probe loss).")
    p.add_argument("--no-plot", action="store_true", help="Skip figure generation.")
    p.add_argument("--quiet", action="store_true", help="Write files without printing the report.")
    return p


def _points_csv(path: Path, method_fits: list[report.MethodFits]) -> None:
    cols = ["replicate", "lane", "protein_conc_nM", "probe_nM",
            "i_free", "i_bound", "f_ratio", "f_depletion",
            "saturated", "excluded", "exclude_reason"]
    seen: set[str] = set()
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for mf in method_fits:
            if mf.rep.name in seen:
                continue
            seen.add(mf.rep.name)
            for p in mf.rep.points:
                w.writerow([
                    mf.rep.name, p.lane, p.conc, mf.rep.probe_nm,
                    p.i_free, p.i_bound, p.f_ratio, p.f_depletion,
                    int(p.saturated), int(p.excluded), p.exclude_reason,
                ])


def _params_csv(
    path: Path,
    method_fits: list[report.MethodFits],
    summaries: dict[tuple[str, str], models.KdSummary],
) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["scope", "replicate", "method", "model", "n_points",
                    "kd_nM", "kd_ci_lo", "kd_ci_hi", "fmax", "fmax_se",
                    "hill_n", "r_squared", "rss", "converged", "note"])
        for mf in method_fits:
            for model, f in mf.fits.items():
                lo, hi = f.ci95.get("kd", (math.nan, math.nan))
                w.writerow([
                    "replicate", mf.rep.name, mf.method, model, f.n_points,
                    f.params.get("kd", ""), lo, hi,
                    f.params.get("fmax", ""), f.stderr.get("fmax", ""),
                    f.params.get("n", ""), f.r_squared, f.rss,
                    int(f.converged), f.message,
                ])
        for (method, model), s in sorted(summaries.items()):
            w.writerow([
                "summary", f"n={s.n}", method, model, "",
                s.geometric_mean, s.ci95[0], s.ci95[1],
                "", "", "", "", "", 1, f"{s.basis}; {s.note}".strip("; "),
            ])


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    for p in args.csv:
        if not p.exists():
            print(f"femsa-fit: no such file: {p}", file=sys.stderr)
            return 2

    try:
        reps = dataset.load_all(list(args.csv), args.probe_nm)
    except ValueError as exc:
        print(f"femsa-fit: {exc}", file=sys.stderr)
        return 2

    if not reps:
        print("femsa-fit: no replicates found in the input.", file=sys.stderr)
        return 2

    if args.drop_saturated:
        n = 0
        for r in reps:
            for p in r.points:
                if p.saturated and not p.excluded:
                    p.excluded = True
                    p.exclude_reason = "saturated (--drop-saturated)"
                    n += 1
        if not args.quiet:
            print(f"Dropped {n} saturated point(s).")

    methods = ["ratio", "depletion"] if args.method == "both" else [args.method]
    model_names = ["quadratic", "hyperbolic"] + ([] if args.no_hill else ["hill"])

    method_fits: list[report.MethodFits] = []
    for rep in reps:
        for method in methods:
            pts = rep.usable(method)
            if len(pts) < 3:
                if not args.quiet and method == "ratio":
                    print(f"femsa-fit: {rep.name} [{method}] has only {len(pts)} usable "
                          f"point(s); skipping.", file=sys.stderr)
                continue
            xs = [p.conc for p in pts]
            ys = [p.f_ratio if method == "ratio" else p.f_depletion for p in pts]
            fits = {
                m: models.fit_model(xs, ys, m, dt=rep.probe_nm, fmax_fixed=args.fmax)
                for m in model_names
            }
            method_fits.append(report.MethodFits(rep=rep, method=method, points=pts, fits=fits))

    if not method_fits:
        print("femsa-fit: nothing could be fitted. Every replicate had fewer than 3 "
              "usable points — check that the protein-concentration column is filled in.",
              file=sys.stderr)
        return 1

    summaries: dict[tuple[str, str], models.KdSummary] = {}
    for method in methods:
        for model in model_names:
            group = [mf for mf in method_fits if mf.method == method]
            kds = [mf.fits[model].kd for mf in group
                   if model in mf.fits and mf.fits[model].converged]
            single_ci = None
            if len(group) == 1 and model in group[0].fits:
                single_ci = group[0].fits[model].ci95.get("kd")
            s = models.summarize_kd(kds, single_ci)
            if s.n:
                summaries[(method, model)] = s

    probe = reps[0].probe_nm
    warnings = report.collect_warnings(method_fits, summaries, probe)
    text = report.build_report(method_fits, summaries, probe, warnings, list(args.csv))

    outdir = args.outdir or args.csv[0].parent
    outdir.mkdir(parents=True, exist_ok=True)
    stem = args.prefix or args.csv[0].stem.replace("_quant", "")

    report_path = outdir / f"{stem}_fit_report.txt"
    report_path.write_text(text, encoding="utf-8")
    _params_csv(outdir / f"{stem}_fit_params.csv", method_fits, summaries)
    _points_csv(outdir / f"{stem}_fit_points.csv", method_fits)

    written = [report_path, outdir / f"{stem}_fit_params.csv", outdir / f"{stem}_fit_points.csv"]

    if not args.no_plot:
        try:
            fig = report.make_figure(
                method_fits, summaries, probe,
                show_depletion=("depletion" in methods),
            )
            for ext in ("png", "svg"):
                path = outdir / f"{stem}_fit.{ext}"
                fig.savefig(path, dpi=300 if ext == "png" else None, bbox_inches="tight")
                written.append(path)
            import matplotlib.pyplot as plt
            plt.close(fig)
        except Exception as exc:                       # pragma: no cover
            print(f"femsa-fit: figure generation failed ({exc}). "
                  f"Numeric outputs were still written.", file=sys.stderr)

    if not args.quiet:
        print(text)
    print("Wrote:")
    for p in written:
        print(f"  {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
