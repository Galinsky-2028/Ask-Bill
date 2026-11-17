"""Built-in publisher passkeys in real Chromium with a CDP virtual authenticator (user verification on).

Enrols with a one-time invite, reaches the publisher desk with MFA current, signs out, signs back in
with the passkey, proves the invite is single-use, and that a user-verification-less authenticator
is refused. Runs the production auth and admin handler against an in-memory store on http://localhost.
"""
import hashlib
import os
import secrets
import base64
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def invite():
    code = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    return code, hashlib.sha256(code.encode()).hexdigest()


def status(page):
    return page.locator("[data-passkey-status]").inner_text()


def main():
    code, digest = invite()
    server = subprocess.Popen(["node", "tests/browser/passkey_fixture_server.mjs"], cwd=ROOT,
                              env={**os.environ, "NODE_ENV": "test", "ASK_BILL_TEST_INVITE_DIGEST": digest},
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        base = server.stdout.readline().strip()
        assert base.startswith("http://localhost:"), base + server.stderr.read()
        binary = "/usr/bin/chromium" if Path("/usr/bin/chromium").exists() else os.environ.get("ASK_BILL_CHROME")
        options = {"executable_path": binary} if binary else {}
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, **options)
            context = browser.new_context()
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            cdp = context.new_cdp_session(page)
            cdp.send("WebAuthn.enable")
            authenticator = cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
                "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
                "hasUserVerification": True, "isUserVerified": True, "automaticPresenceSimulation": True}})["authenticatorId"]

            page.goto(base + "/admin")
            assert page.get_by_role("button", name="Sign in with a passkey").is_visible()
            page.goto(base + "/admin/enroll")
            page.get_by_label("One-time invite code").fill(code)
            page.get_by_role("button", name="Create passkey").click()
            page.wait_for_url(base + "/admin", timeout=15000)
            assert page.get_by_text("Multi-factor verification is current").is_visible()
            assert page.get_by_role("heading", name="Your source library").is_visible()
            creds = cdp.send("WebAuthn.getCredentials", {"authenticatorId": authenticator})["credentials"]
            assert len(creds) == 1 and creds[0]["isResidentCredential"], creds

            page.get_by_role("button", name="Sign out").click()
            page.wait_for_timeout(1500)
            page.get_by_role("button", name="Sign in with a passkey").wait_for(timeout=10000)
            page.get_by_role("button", name="Sign in with a passkey").click()
            page.wait_for_url("**/admin/auth/passkey**")
            page.get_by_role("button", name="Use my passkey").click()
            page.wait_for_url(base + "/admin", timeout=15000)
            assert page.get_by_role("heading", name="Your source library").is_visible()

            # Single-use invite.
            page.goto(base + "/admin/enroll")
            page.get_by_label("One-time invite code").fill(code)
            page.get_by_role("button", name="Create passkey").click()
            for _ in range(50):
                if "already used" in status(page):
                    break
                page.wait_for_timeout(100)
            assert "already used" in status(page), status(page)

            # An authenticator that cannot verify the user is refused at sign-in.
            cdp.send("WebAuthn.setUserVerified", {"authenticatorId": authenticator, "isUserVerified": False})
            context.clear_cookies()
            page.goto(base + "/admin/auth/passkey?returnTo=/admin")
            page.get_by_role("button", name="Use my passkey").click()
            for _ in range(50):
                if "could not be verified" in status(page) or "cancelled" in status(page):
                    break
                page.wait_for_timeout(100)
            assert page.url.startswith(base + "/admin/auth/passkey"), page.url
            assert page.goto(base + "/admin").status == 401, "no session without user verification"
            assert not errors, errors
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
    print("Passkey enrolment, sign-in, single-use invite and UV enforcement passed in Chromium")


if __name__ == "__main__":
    main()
