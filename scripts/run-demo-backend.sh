#!/bin/sh
# Invoked by cargo-watch inside the development container.
set -eu

company=${OPENCOMPANY_COMPANY:-marketing_agency}

set -- run -p opencompany-core --bin opencompany
if [ -n "${OPENCOMPANY_FEATURES:-}" ]; then
    set -- "$@" --features "$OPENCOMPANY_FEATURES"
fi

exec cargo "$@" -- serve \
    --company "companies/${company}" \
    --bind "${OPENCOMPANY_BIND:-0.0.0.0:8080}" \
    --home "${OPENCOMPANY_DATA_DIR:-/data}"
