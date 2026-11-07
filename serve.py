#!/usr/bin/env python3
"""
Cyberpunk 2077 Local & Cloud Server (Render Compatible)
======================================================
Features:
- Zero external dependencies (Python 3 standard library only).
- Injects mandatory isolation headers for WebAssembly multi-threading & WebGPU:
  * Cross-Origin-Opener-Policy: same-origin
  * Cross-Origin-Embedder-Policy: require-corp
  * Cross-Origin-Resource-Policy: cross-origin
- Full HTTP 206 Partial Content (Range request) support for smooth video & wasm streaming.
- Auto-routing: maps '/game' seamlessly to 'game/index.html'.
- Upstream reverse proxy to Cloudflare R2 worker (cp2077-port.fn-web-worker.workers.dev)
  with Origin/Referer spoofing to bypass CORS restrictions.
- Handles both gated paths (/k/play/...) and direct (/runtime/..., /game/archive/...).
- Production-ready for Render (binds to $PORT).
"""

import http.server
import socketserver
import urllib.request
import urllib.error
import mimetypes
import json
import time
import sys
import os
import re

PORT = int(os.environ.get("PORT", 8080))
HOST = os.environ.get("HOST", "0.0.0.0")
UPSTREAM_WORKER = os.environ.get("UPSTREAM_WORKER", "https://cp2077-port.fn-web-worker.workers.dev").rstrip("/")
ORIGIN_SPOOF = os.environ.get("ORIGIN_SPOOF", "https://cyberpunk2077.lol")
START_TIME = time.time()

# Ensure correct MIME types
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("video/mp4", ".mp4")
mimetypes.add_type("image/jpeg", ".jpg")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("text/html", ".html")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/json", ".json")

class CyberpunkHTTPHandler(http.server.SimpleHTTPRequestHandler):
    server_version = "CyberpunkServer/1.1"

    def end_headers(self):
        # Mandatory headers for WebAssembly multi-threading (SharedArrayBuffer) & WebGPU
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type, Authorization, X-Requested-With")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges, ETag")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        clean_path = self.path.split("?")[0]
        if clean_path in ["/__probe", "/log", "/telemetry"]:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                self.rfile.read(content_length)
            self.send_response(204)
            self.end_headers()
            return

        self._proxy_request("POST")

    def _resolve_local_file(self):
        """Map URL path to a local filesystem file if available."""
        path_without_query = self.path.split("?")[0].split("#")[0]

        # Route /game or /game/ directly to game/index.html
        if path_without_query in ["/game", "/game/"]:
            candidate = os.path.join(os.getcwd(), "game", "index.html")
            if os.path.isfile(candidate):
                return candidate

        local_path = self.translate_path(path_without_query)
        if os.path.isfile(local_path):
            return local_path
        if os.path.isdir(local_path):
            idx = os.path.join(local_path, "index.html")
            if os.path.isfile(idx):
                return idx
        return None

    def _handle_health_check(self, method="GET"):
        payload = json.dumps({
            "status": "healthy",
            "service": "cyberpunk2077-web",
            "uptime_seconds": round(time.time() - START_TIME, 2),
            "upstream_worker": UPSTREAM_WORKER,
        }, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)

    def do_GET(self):
        clean_path = self.path.split("?")[0]
        if clean_path in ["/health", "/healthz", "/status", "/ping"]:
            self._handle_health_check(method="GET")
            return

        if clean_path in ["/__probe", "/log", "/telemetry"]:
            self.send_response(204)
            self.end_headers()
            return

        local_file = self._resolve_local_file()
        if local_file:
            self._serve_file(local_file, method="GET")
            return

        # Upstream proxy for runtime assets / game data / wasm
        self._proxy_request("GET")

    def do_HEAD(self):
        clean_path = self.path.split("?")[0]
        if clean_path in ["/health", "/healthz", "/status", "/ping"]:
            self._handle_health_check(method="HEAD")
            return

        if clean_path in ["/__probe", "/log", "/telemetry"]:
            self.send_response(204)
            self.end_headers()
            return

        local_file = self._resolve_local_file()
        if local_file:
            self._serve_file(local_file, method="HEAD")
            return

        self._proxy_request("HEAD")

    def _serve_file(self, filepath, method="GET"):
        """Serve a local file with full HTTP 206 Range (partial content) support."""
        try:
            file_size = os.path.getsize(filepath)
            content_type, _ = mimetypes.guess_type(filepath)
            content_type = content_type or "application/octet-stream"

            range_header = self.headers.get("Range")
            if range_header and range_header.startswith("bytes="):
                range_match = re.match(r"bytes=(\d*)-(\d*)", range_header)
                if range_match:
                    start_str, end_str = range_match.groups()
                    start = int(start_str) if start_str else 0
                    end = int(end_str) if end_str else file_size - 1

                    if start >= file_size or end >= file_size or start > end:
                        self.send_response(416, "Requested Range Not Satisfiable")
                        self.send_header("Content-Range", f"bytes */{file_size}")
                        self.end_headers()
                        return

                    length = end - start + 1
                    self.send_response(206, "Partial Content")
                    self.send_header("Content-Type", content_type)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                    self.send_header("Content-Length", str(length))
                    self.send_header("Accept-Ranges", "bytes")
                    self.end_headers()

                    if method == "GET":
                        with open(filepath, "rb") as f:
                            f.seek(start)
                            remaining = length
                            chunk_size = 64 * 1024
                            while remaining > 0:
                                read_bytes = f.read(min(chunk_size, remaining))
                                if not read_bytes:
                                    break
                                self.wfile.write(read_bytes)
                                remaining -= len(read_bytes)
                    return

            # Standard 200 OK
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(file_size))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()

            if method == "GET":
                with open(filepath, "rb") as f:
                    chunk_size = 64 * 1024
                    while True:
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            self.send_error(500, f"Internal file read error: {e}")

    def _determine_target_url(self):
        """Construct the upstream Cloudflare worker target URL."""
        # Paths that already include the /k/<token> prefix or root endpoints
        if self.path.startswith("/k/") or self.path.startswith("/__launch") or self.path.startswith("/__probe"):
            return f"{UPSTREAM_WORKER}{self.path}"

        # Paths that require the /k/play gate prefix on the worker
        if self.path.startswith("/runtime/") or self.path.startswith("/game/archive/") or \
           self.path.startswith("/game/engine/") or self.path.startswith("/game/r6/") or \
           self.path.startswith("/sdk/"):
            return f"{UPSTREAM_WORKER}/k/play{self.path}"

        # Default fallback
        return f"{UPSTREAM_WORKER}{self.path}"

    def _proxy_request(self, method):
        """Proxy missing assets, wasm bundles, and API calls to upstream Cloudflare worker."""
        target_url = self._determine_target_url()
        user_agent = self.headers.get("User-Agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

        req_headers = {
            "Origin": ORIGIN_SPOOF,
            "Referer": f"{ORIGIN_SPOOF}/",
            "User-Agent": user_agent,
            "Accept": self.headers.get("Accept", "*/*"),
            "Accept-Encoding": "identity",
        }

        for key in ["Range", "If-None-Match", "If-Match", "If-Modified-Since", "Content-Type"]:
            if key in self.headers:
                req_headers[key] = self.headers[key]

        body = None
        if method == "POST":
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                body = self.rfile.read(content_length)

        req = urllib.request.Request(target_url, data=body, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                self.send_response(resp.status)
                for header_key in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control"]:
                    val = resp.headers.get(header_key)
                    if val is not None:
                        self.send_header(header_key, val)
                self.end_headers()

                if method != "HEAD":
                    chunk_size = 128 * 1024
                    while True:
                        chunk = resp.read(chunk_size)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            # If a direct path failed with 401/404, try with /k/play prefix if not already present
            if e.code in [401, 404] and "/k/" not in target_url:
                retry_url = f"{UPSTREAM_WORKER}/k/play{self.path}"
                try:
                    retry_req = urllib.request.Request(retry_url, data=body, headers=req_headers, method=method)
                    with urllib.request.urlopen(retry_req, timeout=60) as resp:
                        self.send_response(resp.status)
                        for header_key in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control"]:
                            val = resp.headers.get(header_key)
                            if val is not None:
                                self.send_header(header_key, val)
                        self.end_headers()
                        if method != "HEAD":
                            chunk_size = 128 * 1024
                            while True:
                                chunk = resp.read(chunk_size)
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                        return
                except Exception:
                    pass

            self.send_response(e.code)
            for header_key in ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"]:
                val = e.headers.get(header_key)
                if val is not None:
                    self.send_header(header_key, val)
            self.end_headers()
            if method != "HEAD":
                err_body = e.read()
                if err_body:
                    self.wfile.write(err_body)
        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            self.send_response(502)
            self.end_headers()
            self.wfile.write(f"Proxy error connecting to {target_url}: {e}".encode("utf-8"))

def main():
    import argparse
    import webbrowser

    parser = argparse.ArgumentParser(description="Cyberpunk 2077 Web Server")
    parser.add_argument("--port", "-p", type=int, default=PORT, help=f"Port to listen on (default: {PORT})")
    parser.add_argument("--host", "-H", default=HOST, help=f"Host interface to bind to (default: {HOST})")
    parser.add_argument("--open", "-o", action="store_true", help="Automatically open browser on launch")
    args = parser.parse_args()

    port = args.port
    host = args.host

    # Change directory to this file's folder
    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((host, port), CyberpunkHTTPHandler) as httpd:
        display_host = "localhost" if host in ["0.0.0.0", "127.0.0.1", ""] else host
        url = f"http://{display_host}:{port}"
        print("==============================================================")
        print(" Cyberpunk 2077 Web Server Running")
        print("==============================================================")
        print(f" > Local URL:       {url}")
        print(f" > Game Launcher:   {url}/game")
        print(f" > Health Check:    {url}/health")
        print(f" > Headers Active:  COOP (same-origin), COEP (require-corp)")
        print(f" > Upstream Worker: {UPSTREAM_WORKER}")
        print(f" > Origin Spoof:    {ORIGIN_SPOOF}")
        print("--------------------------------------------------------------")
        print(" Press Ctrl+C to stop.")
        print("==============================================================")

        if args.open:
            webbrowser.open(url)

        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server cleanly.")

if __name__ == "__main__":
    main()
