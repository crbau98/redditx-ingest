#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 server for PRISM (deploy/README.md section 1). Run as root from the cloned repo:
#   bash deploy/vps-bootstrap.sh
# Safe to run again: every step checks before it changes anything. It does NOT start PRISM; deploy/.env comes first.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo bash deploy/vps-bootstrap.sh)."; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export DEBIAN_FRONTEND=noninteractive
step() { printf '\n== %s\n' "$*"; }

step "System updates and automatic security updates"
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

step "Swap (2 GB) so a memory spike slows PRISM down instead of killing it"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-prism.conf
sysctl -q --system

step "Docker, with container logs capped by default"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
mkdir -p /etc/docker
if [ ! -s /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" },\n  "live-restore": true\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

step "SSH: keys only"
cat > /etc/ssh/sshd_config.d/10-prism.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh 2>/dev/null || systemctl reload sshd

step "Firewall: only SSH comes in (PRISM itself listens on 127.0.0.1 and is reached through Tailscale)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw --force enable >/dev/null
ufw status verbose | head -12

step "Tailscale"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh

step "Shortcut: 'dc' = docker compose for this stack"
ALIAS="alias dc='docker compose -f $REPO/deploy/docker-compose.yml'"
grep -qF "$ALIAS" /root/.bashrc || echo "$ALIAS" >> /root/.bashrc

cat <<EOF

Done. Next:
  1. tailscale up            (open the link it prints and approve this server)
  2. put deploy/.env in $REPO/deploy/ (chmod 600)
  3. source ~/.bashrc && dc up -d --build
EOF
