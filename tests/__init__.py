"""Test package. The __init__.py matters: it makes pytest insert the repo
root (rather than tests/) on sys.path, so `from tests.conftest import ...`
resolves the same way whether or not the package is installed editable."""
