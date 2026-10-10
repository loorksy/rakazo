#!/bin/sh
set -eu
if [ -n "${RAKAZO_RESEARCH_PROXY:-}" ]; then
  mkdir -p "$HOME/.pki/nssdb"
  if [ ! -f "$HOME/.pki/nssdb/cert9.db" ]; then
    certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password
  fi
  certutil -A -d "sql:$HOME/.pki/nssdb" -n "Rakazo Research" -t "C,," -i /etc/rakazo/research-trust/ca.crt
  exec /usr/bin/chromium --proxy-server="$RAKAZO_RESEARCH_PROXY" --proxy-bypass-list="<-loopback>" "$@"
fi
exec /usr/bin/chromium "$@"
