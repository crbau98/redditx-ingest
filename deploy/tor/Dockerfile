# Minimal Tor client for PRISM: exposes a SOCKS5 proxy to the compose network only (nothing is published to the host).
FROM alpine:3.20
RUN apk add --no-cache tor
COPY torrc /etc/tor/torrc
USER tor
EXPOSE 9050
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD nc -z 127.0.0.1 9050 || exit 1
CMD ["tor", "-f", "/etc/tor/torrc"]
