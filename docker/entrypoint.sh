#!/bin/sh
set -e

if [ -n "$POSTGRES_HOST" ]; then
python <<'PY'
import os
import socket
import time

host = os.getenv("POSTGRES_HOST", "db")
port = int(os.getenv("POSTGRES_PORT", "5432"))

for _ in range(60):
    try:
        with socket.create_connection((host, port), timeout=2):
            break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit("Database is not reachable.")
PY
fi

python manage.py migrate --noinput
python manage.py collectstatic --noinput

exec "$@"
