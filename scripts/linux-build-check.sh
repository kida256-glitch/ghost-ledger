#!/usr/bin/env bash
# Linux production build check (ussd-engine design §11), a stand-in for Vercel's
# build image. Run from the repo root on a machine with Docker:
#   docker run --rm -v "${PWD}:/src:ro" node:24 bash /src/scripts/linux-build-check.sh
# It copies the repo (without node_modules, .next, .git) into the container,
# so nothing on the host changes.
set -euo pipefail
mkdir -p /app
cd /src
tar --exclude=./node_modules --exclude=./.next --exclude=./.git -cf - . | (cd /app && tar xf -)
cd /app
echo "node $(node --version), npm $(npm --version), $(uname -m), glibc $(ldd --version | head -n1 | awk '{print $NF}')"
npm ci --no-audit --no-fund --loglevel=error
npm run build > /tmp/build.log 2>&1 || { tail -n 40 /tmp/build.log; exit 1; }
echo "next build: ok"
npm run ussd:argon2-timing
# If the USSD route exists, the function trace must include the Linux argon2 binary.
trace=.next/server/app/api/ussd/route.js.nft.json
if [ -f "$trace" ]; then
  if grep -q "argon2-linux-x64-gnu" "$trace"; then echo "trace: /api/ussd includes @node-rs/argon2-linux-x64-gnu"; else echo "trace: argon2 binary MISSING from /api/ussd"; exit 1; fi
fi
echo "linux build check: PASS"
