"""fEMSA curve fitting.

Kept structurally separate from the annotator: nothing in this package
imports the server or the frontend, and nothing in those imports this.
The extraction half of the workflow produces a CSV; this half consumes
one. Decoupling them means the fitter works equally well on intensities
measured in Fiji or read off the iBright software, and the extraction
side can change without touching any of the statistics.
"""

from gel_annotator.fit.models import (
    FitResult,
    KdSummary,
    fit_model,
    hill,
    hyperbolic,
    quadratic,
    summarize_kd,
)

__all__ = [
    "FitResult",
    "KdSummary",
    "fit_model",
    "hill",
    "hyperbolic",
    "quadratic",
    "summarize_kd",
]
