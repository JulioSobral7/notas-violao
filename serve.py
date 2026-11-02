#!/usr/bin/env python3
"""Servidor local para testar o app no celular pela rede Wi-Fi.

Os navegadores só liberam o microfone em páginas HTTPS (ou em localhost), então
este servidor gera um certificado autoassinado na primeira execução.

Uso:
    python3 serve.py            # https://<ip-do-computador>:8443
    python3 serve.py --port 9000
    python3 serve.py --http     # http://localhost:8000 (só no próprio computador)
"""

import argparse
import functools
import http.server
import socket
import ssl
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CERT_DIR = ROOT / ".certs"


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # Sem cache durante o desenvolvimento: cada recarga pega o código novo.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def lan_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))  # não envia nada; só escolhe a interface
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def ensure_cert(ip):
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    CERT_DIR.mkdir(exist_ok=True)
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
            "-keyout", str(key), "-out", str(cert), "-subj", "/CN=Notas do Violao (dev)",
            "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int)
    parser.add_argument("--http", action="store_true", help="HTTP simples (o microfone só funciona em localhost)")
    args = parser.parse_args()

    ip = lan_ip()
    port = args.port or (8000 if args.http else 8443)
    handler = functools.partial(Handler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)

    if args.http:
        print(f"\n  Abra no computador: http://localhost:{port}\n")
    else:
        cert, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        # Handshake na thread de cada conexão: um cliente lento não trava o servidor.
        server.socket = ctx.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        print(f"\n  No celular (mesma rede Wi-Fi): https://{ip}:{port}")
        print(f"  No computador:                 https://localhost:{port}")
        print("\n  O navegador vai avisar que o certificado não é confiável:")
        print("  toque em 'Avançado' → 'Continuar para o site'.\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")


if __name__ == "__main__":
    main()
