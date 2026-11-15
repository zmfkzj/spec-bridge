#!/usr/bin/env bash
# Downloads the pinned non-npm tools into tools/ and verifies their published checksums, then
# compiles the Alloy Java bridge. Idempotent. Requires curl, tar, java/javac (JDK 17+).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tools
OASDIFF_VERSION=1.38.0
OASDIFF_SHA256_LINUX_AMD64=613037fd6a1d3362a1b742d6d86c338c0eb5ab3511f4942ce3948e78720ea2da
ALLOY_VERSION=6.2.0
ALLOY_SHA1=f399311928e4e9f5cc8a6c09facc36c6dd4f4b9c

os=$(uname -s | tr '[:upper:]' '[:lower:]'); arch=$(uname -m)
case "$arch" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; esac
if [ ! -x tools/oasdiff ] || ! tools/oasdiff --version | grep -q "$OASDIFF_VERSION"; then
  tgz="oasdiff_${OASDIFF_VERSION}_${os}_${arch}.tar.gz"
  curl -fsSL -o "tools/$tgz" "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/$tgz"
  curl -fsSL -o tools/oasdiff-checksums.txt "https://github.com/oasdiff/oasdiff/releases/download/v${OASDIFF_VERSION}/checksums.txt"
  expected=$(grep " $tgz\$" tools/oasdiff-checksums.txt | cut -d' ' -f1)
  [ "$os-$arch" = linux-amd64 ] && [ "$expected" != "$OASDIFF_SHA256_LINUX_AMD64" ] && { echo "pinned checksum mismatch" >&2; exit 1; }
  echo "$expected  tools/$tgz" | sha256sum -c -
  tar -xzf "tools/$tgz" -C tools oasdiff
  rm -f "tools/$tgz" tools/oasdiff-checksums.txt
fi
if [ ! -f tools/org.alloytools.alloy.dist.jar ] || ! echo "$ALLOY_SHA1  tools/org.alloytools.alloy.dist.jar" | sha1sum -c - >/dev/null 2>&1; then
  curl -fsSL -o tools/org.alloytools.alloy.dist.jar "https://repo1.maven.org/maven2/org/alloytools/org.alloytools.alloy.dist/${ALLOY_VERSION}/org.alloytools.alloy.dist-${ALLOY_VERSION}.jar"
  echo "$ALLOY_SHA1  tools/org.alloytools.alloy.dist.jar" | sha1sum -c -
fi
mkdir -p tools/java-build
javac -cp tools/org.alloytools.alloy.dist.jar -d tools/java-build java/SpecBridgeAlloy.java
tools/oasdiff --version
java -cp tools/org.alloytools.alloy.dist.jar:tools/java-build SpecBridgeAlloy 2>&1 | head -1 || true
echo "tools ready"
