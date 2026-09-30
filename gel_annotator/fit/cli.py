"""``femsa-fit`` — fit apparent Kd from fEMSA band intensities.

    femsa-fit gel1_quant.csv gel2_quant.csv gel3_quant.csv
    femsa-fit WT=wt_rep1.csv WT=wt_rep2.csv "-10 shuffle=m10_rep1.csv"

Reads one or more CSVs of band intensities (from this app's Quantify
panel, from Fiji, or from anywhere else — see ``dataset.py`` for the
accepted shapes), fits the exact 1:1 quadratic and the hyperbolic
Langmuir model to each replicate independently, and writes a report, a
parameter table, a per-point table, and a figure.

When the inputs cover more than one DNA fragment — named by the CSV's
``fragment`` column, or on the command line as ``LABEL=file.csv`` — each
fragment is summarised separately and a comparison figure and table of
Kd per fragment are written as well.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from pathlib import Path

from gel_annotator.fit import compare, dataset, models, report


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
            "\n"
            "Comparing fragments: CSVs exported with a Fragment name are grouped\n"
            "automatically. For files without one, prefix the path with a label:\n"
            "  femsa-fit WT=wt1.csv WT=wt2.csv \"-35 shuffle=m35_1.csv\"\n"
            "A comparison figure and table are written whenever two or more\n"
            "fragments are present.\n"
        ),
    )
    p.add_argument("inputs", nargs="+", metavar="CSV",
                   help="Band-intensity CSV file(s), each optionally as LABEL=file.csv "
                        "to name the fragment it measures.")
    p.add_argument("-o", "--outdir", type=Path, default=None,
                   help="Output directory (default: alongside the first input).")
    p.add_argument("--prefix", default=None,
                   help="Output filename stem (default: from the first input, or "
                        "'femsa' when comparing fragments).")
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

    g = p.add_argument_group("comparing fragments")
    g.add_argument("--reference", default=None,
                   help="Fragment the others are compared against (fold change). "
                        "Default: one named WT, else the first given.")
    g.add_argument("--compare-model", choices=["quadratic", "hill", "hyperbolic"],
                   default="quadratic",
                   help="Model whose Kd is compared across fragments. Default: quadratic.")
    g.add_argument("--compare-method", choices=["ratio", "depletion"], default="ratio",
                   help="f_bound estimator used for the comparison. Default: ratio.")
    g.add_argument("--style", choices=["bar", "dot"], default="bar",
                   help="Comparison figure: 'bar' (linear axis from zero) or 'dot' "
                        "(log axis; better when fragments differ by more than ~10x).")
    g.add_argument("--title", default=None, help="Title for the comparison figure.")
    return p


def split_argv(parser: argparse.ArgumentParser, argv: list[str]) -> list[str]:
    """Reorder argv so file arguments that start with '-' survive argparse.

    Promoter-element fragments are conventionally named for the -10 and
    -35 boxes, so "-10_shuffle_rep1_quant.csv" and "-35=m35.csv" are
    exactly the arguments this tool will be given — and argparse reads
    any token with a leading '-' as an unknown option and refuses it.

    Every token that is not one of the parser's own options (or an
    option's value) is treated as an input and moved after a '--', which
    tells argparse that everything following is positional. An unknown
    token spelled with '--' is left alone so argparse still reports it as
    a mistyped option rather than as a missing file.
    """
    flags: set[str] = set()
    takes_value: set[str] = set()
    for action in parser._actions:
        for opt in action.option_strings:
            (flags if action.nargs == 0 else takes_value).add(opt)

    options: list[str] = []
    inputs: list[str] = []
    it = iter(argv)
    for tok in it:
        if tok == "--":
            inputs.extend(it)
            break
        if tok in flags:
            options.append(tok)
        elif tok in takes_value:
            options.append(tok)
            nxt = next(it, None)
            if nxt is not None:
                options.append(nxt)
        elif tok.startswith("--") and tok.split("=", 1)[0] in takes_value:
            options.append(tok)
        elif tok.startswith("--"):
            options.append(tok)            # unknown long option: let argparse complain
        else:
            inputs.append(tok)
    return options + ["--"] + inputs


def parse_inputs(raw: list[str]) -> list[tuple[str | None, Path]]:
    """Split ``LABEL=path`` arguments; a bare existing path has no label.

    An argument that is itself an existing file is always a path, even if
    it contains '=' — only a non-existent argument is split, and only if
    the right-hand side then exists.
    """
    out: list[tuple[str | None, Path]] = []
    for arg in raw:
        path = Path(arg)
        if path.exists():
            out.append((None, path))
            continue
        if "=" in arg:
            label, rest = arg.split("=", 1)
            if Path(rest).exists() and label.strip():
                out.append((label.strip(), Path(rest)))
                continue
        raise FileNotFoundError(arg)
    return out


def _points_csv(path: Path, method_fits: list[report.MethodFits]) -> None:
    cols = ["fragment", "replicate", "lane", "protein_conc_nM", "probe_nM",
            "i_free", "i_bound", "f_ratio", "f_depletion",
            "saturated", "excluded", "exclude_reason"]
    seen: set[tuple[str, str]] = set()
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for mf in method_fits:
            key = (mf.rep.fragment, mf.rep.name)
            if key in seen:
                continue
            seen.add(key)
            for p in mf.rep.points:
                w.writerow([
                    mf.rep.fragment, mf.rep.name, p.lane, p.conc, mf.rep.probe_nm,
                    p.i_free, p.i_bound, p.f_ratio, p.f_depletion,
                    int(p.saturated), int(p.excluded), p.exclude_reason,
                ])


def _params_csv(
    path: Path,
    method_fits: list[report.MethodFits],
    summaries: dict[str, dict[tuple[str, str], models.KdSummary]],
) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["fragment", "scope", "replicate", "method", "model", "n_points",
                    "kd_nM", "kd_ci_lo", "kd_ci_hi", "fmax", "fmax_se",
                    "hill_n", "r_squared", "rss", "converged", "note"])
        for mf in method_fits:
            for model, f in mf.fits.items():
                lo, hi = f.ci95.get("kd", (math.nan, math.nan))
                w.writerow([
                    mf.rep.fragment, "replicate", mf.rep.name, mf.method, model, f.n_points,
                    f.params.get("kd", ""), lo, hi,
                    f.params.get("fmax", ""), f.stderr.get("fmax", ""),
                    f.params.get("n", ""), f.r_squared, f.rss,
                    int(f.converged), f.message,
                ])
        for frag, by_key in summaries.items():
            for (method, model), s in sorted(by_key.items()):
                w.writerow([
                    frag, "summary", f"n={s.n}", method, model, "",
                    s.geometric_mean, s.ci95[0], s.ci95[1],
                    "", "", "", "", "", 1, f"{s.basis}; {s.note}".strip("; "),
                ])


def _summaries(
    mfs: list[report.MethodFits],
    methods: list[str],
    model_names: list[str],
) -> dict[tuple[str, str], models.KdSummary]:
    """Across-replicate Kd summary for every (method, model) of ONE fragment."""
    out: dict[tuple[str, str], models.KdSummary] = {}
    for method in methods:
        for model in model_names:
            group = [mf for mf in mfs if mf.method == method]
            kds = [mf.fits[model].kd for mf in group
                   if model in mf.fits and mf.fits[model].converged]
            single_ci = None
            if len(group) == 1 and model in group[0].fits:
                single_ci = group[0].fits[model].ci95.get("kd")
            s = models.summarize_kd(kds, single_ci)
            if s.n:
                out[(method, model)] = s
    return out


def _save(fig, outdir: Path, name: str, written: list[Path]) -> None:
    for ext in ("png", "svg"):
        path = outdir / f"{name}.{ext}"
        fig.savefig(path, dpi=300 if ext == "png" else None, bbox_inches="tight")
        written.append(path)
    import matplotlib.pyplot as plt
    plt.close(fig)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(split_argv(parser, sys.argv[1:] if argv is None else list(argv)))

    try:
        inputs = parse_inputs(args.inputs)
    except FileNotFoundError as exc:
        print(f"femsa-fit: no such file: {exc}", file=sys.stderr)
        return 2
    paths = [p for _, p in inputs]

    try:
        reps = dataset.load_all(paths, args.probe_nm, fragments=[l for l, _ in inputs])
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
                    label = f"{rep.fragment} {rep.name}".strip()
                    print(f"femsa-fit: {label} [{method}] has only {len(pts)} usable "
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

    # Fragments in the order first given; the comparison reorders so the
    # reference leads, but per-fragment sections follow the user's order.
    fragments: list[str] = []
    for mf in method_fits:
        if mf.rep.fragment not in fragments:
            fragments.append(mf.rep.fragment)
    multi = len(fragments) > 1

    if args.compare_model == "hill" and args.no_hill:
        print("femsa-fit: --compare-model hill needs the Hill fit; drop --no-hill.",
              file=sys.stderr)
        return 2
    if args.compare_method not in methods:
        print(f"femsa-fit: --compare-method {args.compare_method} was not fitted "
              f"(--method {args.method}).", file=sys.stderr)
        return 2

    outdir = args.outdir or paths[0].parent
    outdir.mkdir(parents=True, exist_ok=True)
    if args.prefix:
        stem = args.prefix
    elif multi:
        stem = "femsa"
    else:
        stem = paths[0].stem.replace("_quant", "")

    summaries: dict[str, dict[tuple[str, str], models.KdSummary]] = {}
    sections: list[str] = []
    written: list[Path] = []
    figures: list[tuple[str, list[report.MethodFits], float]] = []

    for frag in fragments:
        mfs = [mf for mf in method_fits if mf.rep.fragment == frag]
        summaries[frag] = _summaries(mfs, methods, model_names)
        probe = mfs[0].rep.probe_nm
        warnings = report.collect_warnings(mfs, summaries[frag], probe)
        label = frag or (compare.UNLABELED if multi else "")
        if multi:
            warnings = [f"[{label}] {w}" for w in warnings]
        sources = list(dict.fromkeys(mf.rep.source for mf in mfs))
        sections.append(report.build_report(
            mfs, summaries[frag], probe, warnings, sources,
            fragment=label, footer=not multi,
        ))
        figures.append((frag, mfs, probe))

    # ── Fragment comparison ──
    comparison_text = ""
    comp_summaries: list[compare.FragmentSummary] = []
    reference = ""
    if multi:
        by_label: dict[str, compare.FragmentSummary] = {}
        for frag in fragments:
            label = frag or compare.UNLABELED
            ests = []
            for mf in method_fits:
                if mf.rep.fragment != frag or mf.method != args.compare_method:
                    continue
                pts = mf.points
                ys = [p.f_ratio if mf.method == "ratio" else p.f_depletion for p in pts]
                ests.append(compare.classify_kd(
                    mf.fits.get(args.compare_model), [p.conc for p in pts], ys,
                    replicate=mf.rep.name,
                ))
            by_label[label] = compare.summarize_fragment(label, ests)

        labels = [f or compare.UNLABELED for f in fragments]
        try:
            reference = compare.pick_reference(labels, args.reference)
        except ValueError as exc:
            print(f"femsa-fit: {exc}", file=sys.stderr)
            return 2
        comp_summaries = [by_label[f] for f in compare.order_fragments(labels, reference)]

        fmax_note = (f"fmax pinned at {args.fmax:g}." if args.fmax is not None
                     else "fmax floated (pin it with --fmax 1.0 if fits rail above 1).")
        comparison_text = compare.comparison_section(
            comp_summaries, reference, args.compare_model, args.compare_method, fmax_note)
        compare.write_comparison_csv(
            outdir / f"{stem}_compare.csv", comp_summaries, reference,
            args.compare_model, args.compare_method)
        written.append(outdir / f"{stem}_compare.csv")

    header = ""
    if multi:
        header = (
            "=" * 74 + "\n"
            + f"fEMSA apparent-Kd fit — {len(fragments)} fragments\n"
            + "=" * 74 + "\n\n"
            + f"Input: {', '.join(p.name for p in paths)}\n\n"
        )
    text = header + comparison_text + "\n".join(sections)
    if multi:
        # The manuscript notes are the same for every fragment; print once.
        text += "\n".join(report.manuscript_notes()) + "\n"

    report_path = outdir / f"{stem}_fit_report.txt"
    report_path.write_text(text, encoding="utf-8")
    _params_csv(outdir / f"{stem}_fit_params.csv", method_fits, summaries)
    _points_csv(outdir / f"{stem}_fit_points.csv", method_fits)
    written = [report_path, outdir / f"{stem}_fit_params.csv",
               outdir / f"{stem}_fit_points.csv"] + written

    if not args.no_plot:
        try:
            for frag, mfs, probe in figures:
                fig = report.make_figure(
                    mfs, summaries[frag], probe,
                    show_depletion=("depletion" in methods),
                    label=(frag or compare.UNLABELED) if multi else "",
                )
                name = f"{stem}_{compare.safe_name(frag)}_fit" if multi else f"{stem}_fit"
                _save(fig, outdir, name, written)
            if multi:
                subtitle = (f"{args.compare_model} fit, {args.compare_method} estimator"
                            + (f", fmax = {args.fmax:g}" if args.fmax is not None else ""))
                fig = compare.make_comparison_figure(
                    comp_summaries, reference, style=args.style,
                    title=args.title, subtitle=subtitle,
                )
                _save(fig, outdir, f"{stem}_compare", written)
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
