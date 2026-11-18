"""Tiny internal HTTP service for the official Google Ads and Meta SDKs. GET /health; everything else is
POST and requires X-Arcatic-Secret. Credentials arrive per request from the Arcatic worker and are never stored."""
from __future__ import annotations

import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import manage
import sources

ROUTES = {
    "/google-ads/campaign-daily": sources.google_ads,
    "/meta/campaign-daily": sources.meta,
    # Phase 11: research + campaign management (creation is always PAUSED)
    "/google-ads/keyword-ideas": manage.google_keyword_ideas,
    "/google-ads/geo-suggest": manage.google_geo_suggest,
    "/google-ads/campaigns": manage.google_create,
    "/google-ads/campaigns/update": manage.google_update,
    "/meta/search": manage.meta_search,
    "/meta/campaigns": manage.meta_create,
    "/meta/campaigns/update": manage.meta_update,
}
SECRET = os.environ.get("ADS_SYNC_SECRET", "")


class Handler(BaseHTTPRequestHandler):
    server_version = "arcatic-ads-sync"

    def _send(self, code: int, payload: dict):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self):
        if not SECRET or not hmac.compare_digest(self.headers.get("x-arcatic-secret", ""), SECRET):
            return self._send(401, {"error": "unauthorized"})
        fn = ROUTES.get(self.path)
        if not fn:
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("content-length", "0")), 64_000)) or b"{}")
            return self._send(200, fn(body))
        except (KeyError, ValueError) as e:
            return self._send(400, {"error": f"bad request: {e}"})
        except Exception as e:  # SDK errors: auth, permission, quota → surface the message, never credentials
            status = 401 if any(k in str(e).lower() for k in ("auth", "permission", "token")) else 502
            return self._send(status, {"error": type(e).__name__, "message": str(e)[:500]})

    def log_message(self, fmt, *args):  # no request bodies in logs
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8090"))), Handler).serve_forever()
