#!/usr/bin/env python3
"""
School Decision-Maker Outreach Dispatch & Context-Aware CV Compiler Server.
Zero-dependency Python HTTP server with:
  - Static UI & JSON/CSV lead endpoints
  - Local persistence for lead states (/api/lead-states) and candidate profile (/api/profile)
  - Gemini API integration (/api/parse-cv, /api/generate-outreach, /api/generate-cv-tips)

Usage:
  python3 server.py 3005
"""

import base64
import io
import json
import mimetypes
import os
import re
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from http.server import BaseHTTPRequestHandler
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
WORKSPACE_ROOT = BASE_DIR.parent.parent
DATA_DIR = BASE_DIR / "data"
WRITABLE_DATA_DIR = DATA_DIR if os.access(DATA_DIR, os.W_OK) else Path("/tmp/school-outreach-dispatch-data")
WRITABLE_DATA_DIR.mkdir(parents=True, exist_ok=True)
JSON_FILE = DATA_DIR / "school_decision_makers.json"
CSV_FILE = DATA_DIR / "school_decision_makers.csv"
STATES_FILE = WRITABLE_DATA_DIR / "lead_states.json"
PROFILE_FILE = WRITABLE_DATA_DIR / "candidate_profile.json"

SCRIPTS_DIR = BASE_DIR / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from enrich_leads import (  # noqa: E402
    LISTS_DIR,
    attach_signals_to_leads,
    enrich_domains_for_leads,
    ingest_csv_text,
    load_cache,
    load_lists_manifest,
    write_builtin_bundles,
)

GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest"]

STATIC_FILES = {
    "/": BASE_DIR / "index.html",
    "/index.html": BASE_DIR / "index.html",
    "/styles.css": BASE_DIR / "styles.css",
    "/app.js": BASE_DIR / "app.js",
    "/leads-data.js": BASE_DIR / "leads-data.js",
}


def load_gemini_api_key() -> str:
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_key:
        return env_key

    candidate_env_files = [
        BASE_DIR / ".env",
        BASE_DIR / ".env.local",
        WORKSPACE_ROOT / ".env",
        WORKSPACE_ROOT / ".env.local",
        WORKSPACE_ROOT / "Builds" / "freightflow-web" / ".env.local",
        WORKSPACE_ROOT / "Builds" / "bd-command-centre" / ".env.local",
    ]
    for env_path in candidate_env_files:
        if not env_path.exists():
            continue
        try:
            for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "GEMINI_API_KEY":
                    val = v.strip().strip("\"'")
                    if val:
                        return val
        except Exception:
            pass
    return ""


def extract_docx_text(raw_bytes: bytes) -> str:
    """Extracts readable text from a .docx archive using stdlib zipfile + XML."""
    parts = []
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
        for name in ["word/document.xml", "word/header1.xml", "word/footer1.xml"]:
            if name not in zf.namelist():
                continue
            xml_bytes = zf.read(name)
            root = ET.fromstring(xml_bytes)
            for p in root.iter():
                if p.tag.endswith("}p"):
                    texts = [t.text for t in p.iter() if t.tag.endswith("}t") and t.text]
                    line = "".join(texts).strip()
                    if line:
                        parts.append(line)
    return "\n".join(parts)


def call_gemini(
    parts: list[dict],
    system_instruction: str,
    temperature: float = 0.35,
    json_mode: bool = True,
) -> dict:
    api_key = load_gemini_api_key()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not configured in environment or workspace .env.local")

    payload: dict = {
        "contents": [{"role": "user", "parts": parts}],
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": 4096,
        },
    }
    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    last_err = None
    for model in GEMINI_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
                candidates = raw.get("candidates") or []
                if not candidates:
                    raise RuntimeError(f"Empty candidates from {model}")
                content_parts = (candidates[0].get("content") or {}).get("parts") or []
                text = "".join(p.get("text", "") for p in content_parts).strip()
                if not text:
                    raise RuntimeError(f"Empty text from {model}")
                if json_mode:
                    # Strip markdown code fences if any model includes them
                    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL).strip()
                    parsed = json.loads(cleaned)
                    return {"data": parsed, "model": model}
                return {"data": text, "model": model}
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="ignore")
            last_err = f"{model} HTTP {exc.code}: {err_body[:240]}"
        except Exception as exc:
            last_err = f"{model}: {exc}"

    raise RuntimeError(f"Gemini request failed ({last_err})")


ANTI_SLOP_RULES = """
WRITING & ANTI-SLOP RULES (STRICT):
1. Sound like a real, thoughtful South African professional writing a concise 1-to-1 message in 60 seconds.
2. BANNED PHRASES & PATTERNS:
   - Never use: "I hope this email finds you well", "I hope your week is going smoothly", "I trust you are well", "I have been following", "Having followed", "I am writing to express my interest", "delve", "leverage", "synergy", "tapestry", "testament", "game-changer", "dynamic environment", "passionate educator", "hit the ground running", "proven track record", "spearheaded", "fast-paced", "esteemed institution", "aligns well with your approach".
   - Never drop raw UI labels like "teaching / educator" or "online / blended" awkwardly into sentences. Write natural English ("online learning", "boarding", "IEB Maths", "remedial support").
   - Avoid excessive em-dashes. Use short, clear sentences.
3. GROUNDING & HONESTY:
   - ONLY reference qualifications, degrees, subjects, years of experience, SACE status, or skills that actually appear in the candidate's CV text, credentials, or additional context.
   - If a detail is missing from the CV/context, do NOT invent it.
4. FORMAT & LENGTH:
   - Cold email: 85-130 words max (excluding sign-off & POPIA line). Crisp subject line (no clickbait, no ALL CAPS). Treat the CV as attached ("I've attached my CV for reference"), never ask "let me know if I can send my CV" in the email. End with a clean sign-off ("Kind regards,\\n<Candidate Name>" plus any provided email/phone/LinkedIn), followed by a blank line and:
     POPIA: One-to-one career inquiry to your institutional address. Reply "opt out" if you prefer not to receive speculative CVs.
   - LinkedIn Connect Note: STRICTLY <= 275 characters. Direct, warm, zero pitchiness.
   - LinkedIn Follow-Up DM: 45-75 words max. Natural follow-up asking who handles hiring/relief rosters or sharing availability.
   - 7-Day Nudge: 45-70 words max. Polite bump, no guilt-tripping. Include sign-off + the same POPIA line at the bottom.
""".strip()


class DispatchHandler(BaseHTTPRequestHandler):
    def _send_bytes(self, status: int, content_type: str, data: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, obj: object) -> None:
        self._send_bytes(
            status,
            "application/json; charset=utf-8",
            json.dumps(obj, ensure_ascii=False).encode("utf-8"),
        )

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path

        if path in STATIC_FILES:
            target = STATIC_FILES[path]
            if not target.exists():
                self._send_bytes(404, "text/plain", b"Not found")
                return
            mime, _ = mimetypes.guess_type(str(target))
            self._send_bytes(200, mime or "application/octet-stream", target.read_bytes())
            return

        if path == "/leads.json":
            if JSON_FILE.exists():
                self._send_bytes(200, "application/json; charset=utf-8", JSON_FILE.read_bytes())
            else:
                self._send_json(404, [])
            return

        if path == "/leads.csv":
            if CSV_FILE.exists():
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="school_decision_makers.csv"')
                self.end_headers()
                self.wfile.write(CSV_FILE.read_bytes())
            else:
                self._send_bytes(404, "text/plain", b"CSV not found")
            return

        if path == "/api/status":
            self._send_json(
                200,
                {
                    "ok": True,
                    "gemini_configured": bool(load_gemini_api_key()),
                    "models": GEMINI_MODELS,
                },
            )
            return

        if path == "/api/lead-states":
            if STATES_FILE.exists():
                self._send_bytes(200, "application/json; charset=utf-8", STATES_FILE.read_bytes())
            else:
                self._send_json(200, {})
            return

        if path == "/api/profile":
            if PROFILE_FILE.exists():
                self._send_bytes(200, "application/json; charset=utf-8", PROFILE_FILE.read_bytes())
            else:
                self._send_json(200, {})
            return

        if path == "/api/lists":
            builtin_leads = json.loads(JSON_FILE.read_text(encoding="utf-8")) if JSON_FILE.exists() else []
            builtin_meta = {
                "id": "builtin",
                "name": "Built-in POPIA School & EdTech List",
                "count": len(builtin_leads),
                "schools_count": sum(1 for l in builtin_leads if l.get("is_school_decision_maker")),
                "hot_hiring_count": sum(1 for l in builtin_leads if l.get("hiring_tier") == "Hot Hiring"),
            }
            lists = [builtin_meta] + load_lists_manifest()
            self._send_json(200, {"ok": True, "lists": lists})
            return

        if path.startswith("/api/lists/"):
            list_id = urllib.parse.unquote(path[len("/api/lists/"):]).strip("/")
            if list_id == "builtin":
                if JSON_FILE.exists():
                    self._send_bytes(200, "application/json; charset=utf-8", JSON_FILE.read_bytes())
                else:
                    self._send_json(404, [])
                return
            safe_id = re.sub(r"[^a-zA-Z0-9._-]", "", list_id)
            target = LISTS_DIR / f"{safe_id}.json"
            if target.exists():
                self._send_bytes(200, "application/json; charset=utf-8", target.read_bytes())
            else:
                self._send_json(404, {"ok": False, "error": "List not found"})
            return

        self._send_bytes(404, "text/plain", b"Not found")

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/lead-states":
            try:
                parsed = self._read_json_body()
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                STATES_FILE.write_text(json.dumps(parsed, indent=2, ensure_ascii=False), encoding="utf-8")
                self._send_json(200, {"ok": True})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        if path == "/api/profile":
            try:
                parsed = self._read_json_body()
                DATA_DIR.mkdir(parents=True, exist_ok=True)
                PROFILE_FILE.write_text(json.dumps(parsed, indent=2, ensure_ascii=False), encoding="utf-8")
                self._send_json(200, {"ok": True})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        if path == "/api/parse-cv":
            try:
                body = self._read_json_body()
                filename = str(body.get("filename", "cv.pdf"))
                mime_type = str(body.get("mime_type", "")).lower()
                b64 = str(body.get("base64_data", ""))
                if not b64:
                    raise ValueError("Missing file data")

                raw_bytes = base64.b64decode(b64)
                if len(raw_bytes) > 12 * 1024 * 1024:
                    raise ValueError("File exceeds 12 MB limit")

                ext = Path(filename).suffix.lower()
                system_prompt = (
                    "You are an accurate CV parser for a South African job seeker. "
                    "Extract only truthful facts present in the document. Never invent details. "
                    "Return valid JSON with exact keys: "
                    "cv_text (string, complete clean plain text of the CV), "
                    "name (string), email (string), phone (string), linkedin (string), "
                    "suggested_track (one of: educator, instructional, admin_marketing, finance_ops, it_systems, graduate_intern), "
                    "credentials_summary (string, concise comma-separated list of qualifications, SACE/registrations, subjects/phases, and key tools), "
                    "candidate_pitch_facts (array of 4-6 short factual proof points from the CV written in first person, e.g. 'I hold a BEd...')."
                )

                parts: list[dict] = []
                if ext == ".pdf" or mime_type == "application/pdf":
                    parts.append({"inline_data": {"mime_type": "application/pdf", "data": b64}})
                    parts.append({"text": "Parse this uploaded CV PDF into the requested JSON structure."})
                elif ext == ".docx" or "wordprocessingml" in mime_type:
                    extracted = extract_docx_text(raw_bytes)
                    if not extracted.strip():
                        raise ValueError("Could not extract readable text from .docx file")
                    parts.append({"text": f"Parse this CV text extracted from {filename}:\n\n{extracted}"})
                elif ext in (".txt", ".md") or mime_type.startswith("text/"):
                    extracted = raw_bytes.decode("utf-8", errors="replace")
                    parts.append({"text": f"Parse this CV text from {filename}:\n\n{extracted}"})
                else:
                    raise ValueError("Unsupported file type. Please upload a PDF, DOCX, TXT, or MD file.")

                res = call_gemini(parts, system_prompt, temperature=0.1, json_mode=True)
                self._send_json(200, {"ok": True, "model": res["model"], "parsed": res["data"]})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        if path == "/api/generate-outreach":
            try:
                body = self._read_json_body()
                lead = body.get("lead") or {}
                profile = body.get("profile") or {}
                lead_context = str(body.get("lead_context", "")).strip()

                prompt_payload = {
                    "candidate": {
                        "name": profile.get("name") or "Siphosihle Mashinini",
                        "email": profile.get("email") or "",
                        "phone": profile.get("phone") or "",
                        "linkedin": profile.get("linkedin") or "",
                        "target_track": profile.get("track") or "educator",
                        "credentials": profile.get("credentials") or "",
                        "pitch_facts": profile.get("pitchFacts") or [],
                        "additional_context": profile.get("additionalContext") or "",
                        "cv_text": (profile.get("cvText") or "")[:9000],
                    },
                    "recipient": {
                        "full_name": lead.get("full_name"),
                        "first_name": lead.get("first_name"),
                        "job_title": lead.get("job_title"),
                        "decision_tier": lead.get("decision_tier"),
                        "institution": lead.get("business_name"),
                        "institution_type": lead.get("institution_type"),
                        "location": lead.get("location"),
                        "school_signals": lead.get("school_signals") or [],
                        "hiring_signals": lead.get("hiring_signals") or {},
                        "hiring_intent_score": lead.get("hiring_intent_score"),
                        "hiring_tier": lead.get("hiring_tier"),
                        "recipient_skills": (lead.get("skills") or [])[:10],
                        "institution_description": (lead.get("business_description") or "")[:1200],
                    },
                    "this_lead_specific_angle": lead_context,
                }

                system_prompt = (
                    f"{ANTI_SLOP_RULES}\n\n"
                    "You are drafting 4 personalized job-inquiry outreach messages for Siphosihle (or the named candidate) "
                    "reaching out to a real South African school or education decision maker.\n"
                    "If the recipient is a PA/EA/School Administrator, politely ask them to route the CV to the Principal or relevant HOD.\n"
                    "If recipient.hiring_signals.open_roles lists an active vacancy relevant to the candidate, reference that specific role title (and closing date if given) naturally; otherwise keep it as a concise speculative/relief inquiry.\n"
                    "If the candidate uploaded a CV or additional context, weave 1-2 specific, truthful facts from it naturally "
                    "(e.g., exact subjects, phases, coaching, SACE, tech tools, availability, location).\n"
                    "Return valid JSON with exact keys:\n"
                    "email_subject (string), email_body (string), "
                    "linkedin_connect (string, <= 275 chars), "
                    "linkedin_dm (string), "
                    "followup_subject (string), followup_body (string)."
                )

                res = call_gemini(
                    [{"text": json.dumps(prompt_payload, ensure_ascii=False)}],
                    system_prompt,
                    temperature=0.4,
                    json_mode=True,
                )
                self._send_json(200, {"ok": True, "model": res["model"], "drafts": res["data"]})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        if path == "/api/generate-cv-tips":
            try:
                body = self._read_json_body()
                lead = body.get("lead") or {}
                profile = body.get("profile") or {}
                lead_context = str(body.get("lead_context", "")).strip()

                prompt_payload = {
                    "candidate": {
                        "name": profile.get("name") or "Siphosihle Mashinini",
                        "target_track": profile.get("track") or "educator",
                        "credentials": profile.get("credentials") or "",
                        "additional_context": profile.get("additionalContext") or "",
                        "cv_text": (profile.get("cvText") or "")[:9000],
                    },
                    "recipient": {
                        "full_name": lead.get("full_name"),
                        "job_title": lead.get("job_title"),
                        "decision_tier": lead.get("decision_tier"),
                        "institution": lead.get("business_name"),
                        "institution_type": lead.get("institution_type"),
                        "school_signals": lead.get("school_signals") or [],
                        "hiring_signals": lead.get("hiring_signals") or {},
                        "hiring_intent_score": lead.get("hiring_intent_score"),
                        "recipient_skills": (lead.get("skills") or [])[:12],
                        "institution_description": (lead.get("business_description") or "")[:1200],
                    },
                    "this_lead_specific_angle": lead_context,
                }

                system_prompt = (
                    f"{ANTI_SLOP_RULES}\n\n"
                    "You are a practical South African school-hiring CV advisor. "
                    "Using ONLY facts from the candidate's CV and additional context (never invent credentials or roles), "
                    "tell her exactly how to tailor her CV before emailing this specific decision maker. "
                    "If hiring_signals.open_roles lists an active opening at this school, prioritize tailoring her summary and bullets directly to that role.\n"
                    "Return valid JSON with exact keys:\n"
                    "tailored_summary (string, crisp 2-3 sentence CV summary rewritten for this institution), "
                    "bullet_upgrades (array of 3 strings, rewritten CV bullets grounded in her real CV adapted to this school's needs), "
                    "gap_actions (array of 3 crisp, actionable edits for Page 1 ordering, missing truthful proof points, or compliance items)."
                )

                res = call_gemini(
                    [{"text": json.dumps(prompt_payload, ensure_ascii=False)}],
                    system_prompt,
                    temperature=0.3,
                    json_mode=True,
                )
                self._send_json(200, {"ok": True, "model": res["model"], "tips": res["data"]})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        if path == "/api/ingest-csv":
            try:
                body = self._read_json_body()
                filename = str(body.get("filename", "new_leads.csv"))
                csv_text = str(body.get("csv_text", ""))
                enrich_signals = bool(body.get("enrich_signals", True))
                if not csv_text.strip():
                    raise ValueError("Uploaded CSV is empty")
                result = ingest_csv_text(csv_text, filename, enrich_signals=enrich_signals, use_gemini=True)
                self._send_json(200, {"ok": True, **result})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        if path == "/api/enrich-institution":
            try:
                body = self._read_json_body()
                lead = body.get("lead") or {}
                list_id = str(body.get("list_id", "builtin"))
                if not lead.get("business_domain") and not lead.get("business_website"):
                    raise ValueError("Lead missing domain/website for signal enrichment")

                cache = enrich_domains_for_leads([lead], force=True, use_gemini=True)
                attach_signals_to_leads([lead], cache)

                if list_id == "builtin" and JSON_FILE.exists():
                    all_leads = json.loads(JSON_FILE.read_text(encoding="utf-8"))
                    attach_signals_to_leads(all_leads, cache)
                    if os.access(DATA_DIR, os.W_OK):
                        write_builtin_bundles(all_leads)
                else:
                    safe_id = re.sub(r"[^a-zA-Z0-9._-]", "", list_id)
                    target = LISTS_DIR / f"{safe_id}.json"
                    if target.exists():
                        all_leads = json.loads(target.read_text(encoding="utf-8"))
                        attach_signals_to_leads(all_leads, cache)
                        target.write_text(json.dumps(all_leads, indent=2, ensure_ascii=False), encoding="utf-8")

                self._send_json(200, {"ok": True, "lead": lead})
            except Exception as exc:
                self._send_json(400, {"ok": False, "error": str(exc)})
            return

        self._send_bytes(404, "text/plain", b"Not found")

    def log_message(self, format: str, *args) -> None:
        pass


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


# Top-level exports for Vercel Python runtime
handler = DispatchHandler
app = DispatchHandler
application = DispatchHandler


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3005
    with ReusableTCPServer(("127.0.0.1", port), DispatchHandler) as httpd:
        print(f"School Outreach Dispatch Center running at http://127.0.0.1:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
