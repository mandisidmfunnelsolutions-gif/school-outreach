#!/usr/bin/env python3
"""
Multi-source Hiring Signals Enrichment & Universal CSV Ingestion Engine
for the School Decision-Maker Outreach Dispatch Center.

Sources:
  1. First-party school website homepage link discovery + /sitemap.xml + careers/vacancies pages (via curl)
  2. External ATS portals linked from school websites (MyRecruit, Simplify, Workable, BambooHR, etc.)
  3. ISASA Vacancies board index (https://www.isasa.org/vacancies/)
  4. Gemini structured extraction (gemini-3-flash-preview) with deterministic keyword fallback

Usage (CLI enrichment of built-in dataset):
  python3 scripts/enrich_leads.py --limit 50
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_ROOT = BASE_DIR.parent.parent
DATA_DIR = BASE_DIR / "data"
WRITABLE_DATA_DIR = DATA_DIR if os.access(DATA_DIR, os.W_OK) else Path("/tmp/school-outreach-dispatch-data")
LISTS_DIR = WRITABLE_DATA_DIR / "lists"
CACHE_FILE = DATA_DIR / "institution_signals_cache.json"
WRITABLE_CACHE_FILE = WRITABLE_DATA_DIR / "institution_signals_cache.json"
MANIFEST_FILE = LISTS_DIR / "manifest.json"
BUILTIN_JSON = DATA_DIR / "school_decision_makers.json"
BUILTIN_CSV = DATA_DIR / "school_decision_makers.csv"
LEADS_JS = BASE_DIR / "leads-data.js"

# Import shared helpers from build_leads.py when invoked from any cwd
import sys

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_leads import (  # noqa: E402
    ALLOWED_INSTITUTIONAL_ALIASES,
    PERSONAL_OR_ISP_DOMAINS,
    classify_decision_tier,
    classify_institution_type,
    classify_segment,
    clean_range,
    clean_ws,
    extract_school_signals,
    is_popi_safe_contact,
    normalize_linkedin,
    normalize_location,
    normalize_website,
    parse_json_list,
)

GEMINI_MODELS = ["gemini-3-flash-preview", "gemini-flash-latest", "gemini-flash-lite-latest"]

CAREER_PATH_CANDIDATES = [
    "/vacancies",
    "/careers",
    "/employment",
    "/work-with-us",
    "/join-our-team",
    "/Info/Vacancies",
    "/about/vacancies",
    "/about-us/vacancies",
]

IGNORE_EMAIL_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js")


def load_gemini_api_key() -> str:
    env_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if env_key:
        return env_key
    for env_path in [
        BASE_DIR / ".env",
        BASE_DIR / ".env.local",
        WORKSPACE_ROOT / ".env",
        WORKSPACE_ROOT / ".env.local",
        WORKSPACE_ROOT / "Builds" / "freightflow-web" / ".env.local",
        WORKSPACE_ROOT / "Builds" / "bd-command-centre" / ".env.local",
    ]:
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


def curl_fetch(url: str, timeout: int = 8) -> tuple[str, str]:
    """Fetches a URL using system curl to handle TLS intermediate certs and modern WAFs."""
    try:
        res = subprocess.run(
            [
                "curl",
                "-sSL",
                "--max-time",
                str(timeout),
                "-A",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                "-w",
                "\n__FINAL_URL__:%{url_effective}__HTTP_CODE__:%{http_code}",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 3,
        )
        out = res.stdout or ""
        marker = "\n__FINAL_URL__:"
        final_url = url
        code = 0
        if marker in out:
            html, meta = out.rsplit(marker, 1)
            m = re.match(r"^(.*?)__HTTP_CODE__:(\d+)", meta.strip())
            if m:
                final_url = m.group(1) or url
                code = int(m.group(2))
        else:
            html = out
        if code >= 400 or not html:
            return "", final_url
        return html, final_url
    except Exception:
        return "", url


def html_to_text(html: str) -> str:
    if not html:
        return ""
    txt = re.sub(r"<script.*?</script>|<style.*?</style>|<!--.*?-->", " ", html, flags=re.S | re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = txt.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#038;", "&").replace("&#8211;", "-")
    return re.sub(r"\s+", " ", txt).strip()


def extract_domain_emails(html: str, domain: str) -> list[str]:
    if not html or not domain:
        return []
    found = re.findall(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", html)
    clean = []
    seen = set()
    bdom = domain.lower().strip()
    allowed_aliases = ALLOWED_INSTITUTIONAL_ALIASES.get(bdom, set())
    for raw in found:
        em = raw.lower().strip(".")
        if em.endswith(IGNORE_EMAIL_EXTS):
            continue
        edom = em.split("@", 1)[1]
        if edom in PERSONAL_OR_ISP_DOMAINS:
            continue
        if edom == bdom or edom.endswith("." + bdom) or edom in allowed_aliases:
            if em not in seen:
                seen.add(em)
                clean.append(em)
    return clean


def pick_recruitment_email(emails: list[str]) -> str:
    priority = ("vacanc", "career", "recruit", "hr@", "jobs@", "talent@", "staff@", "apply@")
    for p in priority:
        for em in emails:
            if p in em:
                return em
    return ""


KNOWN_ATS_HOSTS = (
    "myrecruit.co.za",
    "simplify.hr",
    "bamboohr.com",
    "workable.com",
    "greenhouse.io",
    "lever.co",
    "pnet.co.za",
    "stellenboschbusiness.ac.za",
)


def discover_career_links(base_url: str, html: str, domain: str) -> list[str]:
    if not html:
        return []
    links = re.findall(r'href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html, re.I | re.S)
    candidates: list[tuple[int, str]] = []
    seen = set()
    bdom = domain.lower().strip().removeprefix("www.")
    for href, label in links:
        href = href.strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:")):
            continue
        if any(href.lower().endswith(ext) for ext in (".css", ".js", ".png", ".jpg", ".svg", ".ico")):
            continue
        full = urllib.parse.urljoin(base_url, href)
        host = urllib.parse.urlparse(full).netloc.lower().removeprefix("www.")
        is_same_or_ats = (
            host == bdom
            or host.endswith("." + bdom)
            or any(ats in host for ats in KNOWN_ATS_HOSTS)
        )
        if not is_same_or_ats:
            continue
        lbl = re.sub(r"<[^>]+>|\s+", " ", label).strip().lower()
        combined = f"{href.lower()} {lbl}"
        if any(bad in combined for bad in ("unemployment", "careers-to-study", "career-advice")):
            continue
        score = 0
        if any(k in combined for k in ("vacanc", "career", "job", "myrecruit", "workable", "bamboohr", "simplify")):
            score = 3
        elif any(k in combined for k in ("join-our-team", "work-with-us", "employment", "recruit")):
            score = 2
        elif any(k in combined for k in ("news", "announcements")):
            score = 1
        if score > 0 and full not in seen:
            seen.add(full)
            candidates.append((score, full))
    candidates.sort(key=lambda x: -x[0])
    return [u for _, u in candidates[:4]]


def deterministic_signal_parse(
    business_name: str,
    domain: str,
    careers_url: str,
    pages_text: str,
    rec_email: str,
    isasa_match: bool,
) -> dict:
    txt_l = pages_text.lower()
    open_roles: list[dict] = []

    role_patterns = [
        r"(?:grade\s+\d+[\w\s/-]{0,25}(?:teacher|educator|locum))",
        r"(?:(?:mathematics|maths|english|science|physical sciences|afrikaans|isizulu|life sciences|accounting|history|geography|it|robotics|foundation phase|intermediate phase|high school|prep|head of department|hod|deputy|principal|intern|teaching assistant|bursar|admissions|administrator)\s+(?:teacher|educator|lecturer|specialist|coordinator|officer|assistant|intern))",
    ]
    seen_titles = set()
    for pat in role_patterns:
        for m in re.findall(pat, pages_text, re.I):
            clean_t = clean_ws(m).title()
            if 8 <= len(clean_t) <= 65 and clean_t.lower() not in seen_titles:
                seen_titles.add(clean_t.lower())
                open_roles.append({
                    "title": clean_t,
                    "department_or_phase": "",
                    "contract_type": "Unspecified",
                    "closing_date": "",
                    "apply_url": careers_url,
                    "source": "School Website",
                })
            if len(open_roles) >= 5:
                break

    urgency_flags = []
    if any(w in txt_l for w in ("immediate start", "immediately", "asap", "urgent")):
        urgency_flags.append("Immediate Start")
    if any(w in txt_l for w in ("locum", "maternity", "relief", "substitute")):
        urgency_flags.append("Relief / Locum")
    if any(w in txt_l for w in ("closing date", "applications close", "deadline")):
        urgency_flags.append("Closing Date Listed")

    expansion_signals = []
    if any(w in txt_l for w in ("new campus", "new grade", "expanding", "new wing", "new building", "opened")):
        expansion_signals.append("Campus / Grade Expansion")
    if any(w in txt_l for w in ("stem lab", "robotics", "digied", "e-learning", "online school")):
        expansion_signals.append("STEM / Digital Growth")

    channel = "unknown"
    if any(k in careers_url.lower() for k in ("myrecruit", "workable", "bamboohr", "simplify", "pnet", "greenhouse")):
        channel = "ats"
    elif rec_email:
        channel = "direct_email"
    elif careers_url:
        channel = "school_portal"
    elif isasa_match:
        channel = "isasa"

    summary = (
        f"Discovered {len(open_roles)} potential role signal(s) on {domain}."
        if open_roles
        else (
            f"Careers portal active at {careers_url}; monitor for termly openings."
            if careers_url
            else f"No public vacancies page detected via automated crawl for {domain}; speculative direct outreach recommended."
        )
    )

    return {
        "open_roles": open_roles,
        "application_channel": channel,
        "public_recruitment_email": rec_email,
        "urgency_flags": urgency_flags,
        "expansion_signals": expansion_signals,
        "leadership_signals": [],
        "signal_summary": summary,
        "extractor": "deterministic",
    }


def gemini_extract_signals(
    business_name: str,
    domain: str,
    careers_url: str,
    pages_text: str,
    rec_email: str,
    isasa_match: bool,
) -> dict | None:
    api_key = load_gemini_api_key()
    if not api_key or len(pages_text.strip()) < 120:
        return None

    system_prompt = (
        "You extract real hiring and expansion signals from crawled South African school / EdTech webpages. "
        "STRICT TRUTH RULE: Only include job vacancies, closing dates, expansion news, or recruitment emails "
        "explicitly evidenced in the provided text. If no active vacancies appear in the text, return open_roles: []. "
        "Ignore cookie banners, navigation menus, and generic 'why work with us' boilerplate.\n"
        "Return valid JSON with exact keys:\n"
        "open_roles (array of up to 6 objects: {title, department_or_phase, contract_type, closing_date, apply_url, source}), "
        "application_channel (one of: direct_email, school_portal, ats, isasa, linkedin_jobs, unknown), "
        "public_recruitment_email (string, empty if none), "
        "urgency_flags (array of short strings e.g. 'Immediate Start', 'Maternity Cover', 'Term 1 2027'), "
        "expansion_signals (array of short strings e.g. 'New Campus Launch', 'New Grades Added'), "
        "leadership_signals (array of short strings e.g. 'New Head Appointed'), "
        "signal_summary (1-2 crisp factual sentences about hiring/growth status at this institution)."
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": json.dumps(
                            {
                                "institution": business_name,
                                "domain": domain,
                                "careers_url": careers_url,
                                "detected_recruitment_email": rec_email,
                                "listed_on_isasa_page": isasa_match,
                                "crawled_text": pages_text[:14000],
                            },
                            ensure_ascii=False,
                        )
                    }
                ],
            }
        ],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 1500,
            "responseMimeType": "application/json",
        },
    }

    for model in GEMINI_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
                parts = ((raw.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
                txt = "".join(p.get("text", "") for p in parts).strip()
                cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", txt, flags=re.DOTALL).strip()
                parsed = json.loads(cleaned)
                if isinstance(parsed, dict) and "open_roles" in parsed:
                    parsed["extractor"] = model
                    return parsed
        except Exception:
            continue
    return None


def compute_hiring_intent_score(signals: dict) -> tuple[int, str]:
    open_roles = signals.get("open_roles") or []
    urgency = signals.get("urgency_flags") or []
    expansion = signals.get("expansion_signals") or []
    leadership = signals.get("leadership_signals") or []
    rec_email = signals.get("public_recruitment_email") or ""
    careers_url = signals.get("careers_url") or ""

    score = 10  # Base score for having a verified institutional decision-maker email (POPIA-valid)
    if len(open_roles) >= 1:
        score += 45
        if len(open_roles) >= 2:
            score += 15
    if urgency:
        score += 15
    if expansion or leadership:
        score += 10
    if rec_email or careers_url:
        score += 5

    score = min(100, score)
    if score >= 65:
        tier = "Hot Hiring"
    elif score >= 30:
        tier = "Warm Growth"
    else:
        tier = "Evergreen"
    return score, tier


def fetch_isasa_snapshot() -> str:
    html, _ = curl_fetch("https://www.isasa.org/vacancies/", timeout=8)
    return html_to_text(html).lower() if html else ""


def enrich_institution(
    business_name: str,
    domain: str,
    website: str,
    isasa_text: str = "",
    use_gemini: bool = True,
) -> dict:
    clean_dom = clean_ws(domain).lower().removeprefix("www.")
    base_url = normalize_website(website or clean_dom)

    homepage_html = ""
    effective_base = base_url
    for candidate_base in [f"https://www.{clean_dom}", f"https://{clean_dom}", base_url]:
        if not candidate_base:
            continue
        html, final_u = curl_fetch(candidate_base, timeout=7)
        if html and len(html) > 300:
            homepage_html = html
            effective_base = final_u
            break

    discovered = discover_career_links(effective_base, homepage_html, clean_dom)
    # Add targeted path guesses only if nothing discovered
    if not discovered and clean_dom:
        for p in CAREER_PATH_CANDIDATES[:4]:
            discovered.append(urllib.parse.urljoin(effective_base, p))

    crawled_chunks = []
    all_emails = extract_domain_emails(homepage_html, clean_dom)
    careers_url = ""
    sources = []

    if homepage_html:
        sources.append("Institution Homepage")
        hp_txt = html_to_text(homepage_html)
        if hp_txt:
            crawled_chunks.append(f"[HOMEPAGE {effective_base}]\n{hp_txt[:3500]}")

    for u in discovered[:3]:
        sub_html, sub_final = curl_fetch(u, timeout=8)
        if not sub_html or len(sub_html) < 200:
            continue
        sub_txt = html_to_text(sub_html)
        if "page not found" in sub_txt[:160].lower() or "404" in sub_txt[:80].lower():
            continue
        if not careers_url and any(k in u.lower() for k in ("vacanc", "career", "job", "join-our-team", "work-with", "recruit", "employ")):
            careers_url = sub_final
            sources.append("Careers / Vacancies Page")
        all_emails.extend(extract_domain_emails(sub_html, clean_dom))
        crawled_chunks.append(f"[PAGE {sub_final}]\n{sub_txt[:5500]}")

    rec_email = pick_recruitment_email(all_emails)
    isasa_match = bool(isasa_text and business_name.lower() in isasa_text)
    if isasa_match:
        sources.append("ISASA Member Portal")

    combined_text = "\n\n".join(crawled_chunks)
    extracted = None
    if use_gemini and combined_text:
        extracted = gemini_extract_signals(business_name, clean_dom, careers_url, combined_text, rec_email, isasa_match)

    if not extracted:
        extracted = deterministic_signal_parse(business_name, clean_dom, careers_url, combined_text, rec_email, isasa_match)

    open_roles = extracted.get("open_roles") or []
    # Keep only dict entries with title
    clean_roles = []
    for r in open_roles[:6]:
        if isinstance(r, dict) and clean_ws(str(r.get("title", ""))):
            clean_roles.append({
                "title": clean_ws(str(r.get("title", ""))),
                "department_or_phase": clean_ws(str(r.get("department_or_phase", ""))),
                "contract_type": clean_ws(str(r.get("contract_type", ""))),
                "closing_date": clean_ws(str(r.get("closing_date", ""))),
                "apply_url": clean_ws(str(r.get("apply_url", ""))) or careers_url or effective_base,
                "source": clean_ws(str(r.get("source", ""))) or "Institution Website",
            })

    final_rec_email = clean_ws(str(extracted.get("public_recruitment_email", ""))) or rec_email
    # Validate recruitment email safety
    if final_rec_email:
        ok, _ = is_popi_safe_contact(final_rec_email, "valid", clean_dom)
        if not ok:
            final_rec_email = ""

    signals = {
        "domain": clean_dom,
        "business_name": business_name,
        "careers_url": careers_url,
        "open_roles": clean_roles,
        "open_roles_count": len(clean_roles),
        "application_channel": extracted.get("application_channel") or ("school_portal" if careers_url else "unknown"),
        "public_recruitment_email": final_rec_email,
        "urgency_flags": list(dict.fromkeys(extracted.get("urgency_flags") or []))[:5],
        "expansion_signals": list(dict.fromkeys(extracted.get("expansion_signals") or []))[:5],
        "leadership_signals": list(dict.fromkeys(extracted.get("leadership_signals") or []))[:5],
        "signal_summary": clean_ws(str(extracted.get("signal_summary", ""))),
        "sources": sources or ["Domain Lookup"],
        "extractor": extracted.get("extractor", "deterministic"),
        "enriched_at": datetime.now(timezone.utc).isoformat(),
    }

    score, tier = compute_hiring_intent_score(signals)
    signals["hiring_intent_score"] = score
    signals["hiring_tier"] = tier
    return signals


def load_cache() -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for path in (CACHE_FILE, WRITABLE_CACHE_FILE):
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    merged.update(data)
            except Exception:
                pass
    return merged


def save_cache(cache: dict[str, dict]) -> None:
    target = CACHE_FILE if os.access(DATA_DIR, os.W_OK) else WRITABLE_CACHE_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")


def attach_signals_to_leads(leads: list[dict], cache: dict[str, dict]) -> list[dict]:
    for lead in leads:
        dom = clean_ws(lead.get("business_domain", "")).lower().removeprefix("www.")
        sig = cache.get(dom)
        if sig:
            lead["hiring_signals"] = {
                "careers_url": sig.get("careers_url", ""),
                "open_roles": sig.get("open_roles", []),
                "open_roles_count": sig.get("open_roles_count", 0),
                "application_channel": sig.get("application_channel", "unknown"),
                "public_recruitment_email": sig.get("public_recruitment_email", ""),
                "urgency_flags": sig.get("urgency_flags", []),
                "expansion_signals": sig.get("expansion_signals", []),
                "leadership_signals": sig.get("leadership_signals", []),
                "signal_summary": sig.get("signal_summary", ""),
                "sources": sig.get("sources", []),
                "enriched_at": sig.get("enriched_at", ""),
            }
            lead["hiring_intent_score"] = sig.get("hiring_intent_score", 10)
            lead["hiring_tier"] = sig.get("hiring_tier", "Evergreen")
        else:
            lead.setdefault("hiring_signals", {
                "careers_url": "",
                "open_roles": [],
                "open_roles_count": 0,
                "application_channel": "unknown",
                "public_recruitment_email": "",
                "urgency_flags": [],
                "expansion_signals": [],
                "leadership_signals": [],
                "signal_summary": "Run Refresh Signals to check live careers page and vacancies.",
                "sources": [],
                "enriched_at": "",
            })
            lead.setdefault("hiring_intent_score", 10)
            lead.setdefault("hiring_tier", "Evergreen")
    return leads


def enrich_domains_for_leads(
    leads: list[dict],
    force: bool = False,
    ttl_days: int = 7,
    max_workers: int = 6,
    use_gemini: bool = True,
) -> dict[str, dict]:
    cache = load_cache()
    now = datetime.now(timezone.utc)
    to_fetch: dict[str, tuple[str, str]] = {}

    for lead in leads:
        dom = clean_ws(lead.get("business_domain", "")).lower().removeprefix("www.")
        if not dom or dom in to_fetch:
            continue
        existing = cache.get(dom)
        if not force and existing and existing.get("enriched_at"):
            try:
                age_days = (now - datetime.fromisoformat(existing["enriched_at"])).total_seconds() / 86400.0
                if age_days < ttl_days:
                    continue
            except Exception:
                pass
        to_fetch[dom] = (lead.get("business_name", dom), lead.get("business_website", dom))

    if to_fetch:
        isasa_text = fetch_isasa_snapshot()
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(enrich_institution, bname, dom, site, isasa_text, use_gemini): dom
                for dom, (bname, site) in to_fetch.items()
            }
            for fut in concurrent.futures.as_completed(futures):
                dom = futures[fut]
                try:
                    cache[dom] = fut.result()
                except Exception as exc:
                    print(f"[warn] enrich failed for {dom}: {exc}")
        save_cache(cache)

    return cache


def write_builtin_bundles(leads: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BUILTIN_JSON.write_text(json.dumps(leads, indent=2, ensure_ascii=False), encoding="utf-8")

    csv_fields = [
        "id", "full_name", "job_title", "decision_tier", "segment",
        "is_school_decision_maker", "institution_type", "business_name",
        "email", "email_status", "linkedin_url", "business_website",
        "city", "province", "employees_range", "hiring_intent_score",
        "hiring_tier", "open_roles_count", "careers_url", "school_signals", "skills",
    ]
    with BUILTIN_CSV.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=csv_fields)
        writer.writeheader()
        for l in leads:
            hs = l.get("hiring_signals") or {}
            row = {k: l.get(k, "") for k in csv_fields}
            row["open_roles_count"] = hs.get("open_roles_count", 0)
            row["careers_url"] = hs.get("careers_url", "")
            row["school_signals"] = "; ".join(l.get("school_signals") or [])
            row["skills"] = "; ".join(l.get("skills") or [])
            writer.writerow(row)

    LEADS_JS.write_text(
        "// Auto-generated by scripts/build_leads.py & scripts/enrich_leads.py\n"
        f"window.SCHOOL_DISPATCH_LEADS = {json.dumps(leads, ensure_ascii=False)};\n",
        encoding="utf-8",
    )


def _pick_col(row: dict, *aliases: str) -> str:
    lower_map = {k.lower().strip(): v for k, v in row.items() if k}
    for alias in aliases:
        if alias.lower() in lower_map and clean_ws(str(lower_map[alias.lower()])):
            return clean_ws(str(lower_map[alias.lower()]))
    return ""


def ingest_csv_text(
    csv_text: str,
    list_name: str,
    enrich_signals: bool = True,
    use_gemini: bool = True,
) -> dict:
    """
    Universal POPIA-safe ingestion & hiring-signal enrichment for ANY new CSV lead list
    (Apollo, Vibe, Apify, or custom CSV).
    """
    reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff")))
    rows = list(reader)
    if not rows:
        raise ValueError("Uploaded CSV contains no data rows")

    seen_keys = set()
    kept: list[dict] = []
    excluded_reasons: dict[str, int] = {}

    for row in rows:
        first_name = _pick_col(row, "prospect_first_name", "first_name", "First Name", "firstName")
        last_name = _pick_col(row, "prospect_last_name", "last_name", "Last Name", "lastName")
        full_name = _pick_col(row, "prospect_full_name", "full_name", "Full Name", "name", "Name")
        if not full_name:
            full_name = clean_ws(f"{first_name} {last_name}")
        if not full_name:
            excluded_reasons["missing_name"] = excluded_reasons.get("missing_name", 0) + 1
            continue
        if not first_name:
            first_name = full_name.split(" ")[0]

        title = _pick_col(row, "prospect_job_title", "job_title", "Job Title", "title", "Title", "role")
        business_name = _pick_col(row, "business_name", "company", "Company", "Company Name", "school", "School", "organization")
        if not business_name:
            excluded_reasons["missing_institution"] = excluded_reasons.get("missing_institution", 0) + 1
            continue

        website = _pick_col(row, "business_website", "website", "Website", "company_website", "Company Website")
        domain = _pick_col(row, "business_domain", "domain", "Domain", "company_domain")
        if not domain and website:
            parsed_u = urllib.parse.urlparse(normalize_website(website))
            domain = parsed_u.netloc.lower().removeprefix("www.")
        email = _pick_col(row, "contact_professions_email", "email", "Email", "work_email", "Work Email").lower()
        if not domain and "@" in email:
            domain = email.split("@", 1)[1]

        email_status = _pick_col(row, "contact_professional_email_status", "email_status", "Email Status").lower()
        # If uploaded CSV has no verification status column, enforce institutional domain match as baseline gate
        effective_status = email_status or "valid"

        popi_ok, reason = is_popi_safe_contact(email, effective_status, domain)
        if not popi_ok:
            key = reason.split(":", 1)[0]
            excluded_reasons[key] = excluded_reasons.get(key, 0) + 1
            continue

        linkedin = normalize_linkedin(_pick_col(row, "prospect_linkedin", "linkedin", "LinkedIn", "linkedin_url", "LinkedIn URL", "Person Linkedin Url"))
        dedupe_key = email or linkedin or f"{full_name.lower()}|{business_name.lower()}"
        if dedupe_key in seen_keys:
            excluded_reasons["duplicate"] = excluded_reasons.get("duplicate", 0) + 1
            continue
        seen_keys.add(dedupe_key)

        desc = _pick_col(row, "business_business_description", "description", "company_description", "business_description")
        naics = _pick_col(row, "business_naics_description", "industry", "Industry", "naics")
        segment = classify_segment(business_name, naics, desc)
        city, region = normalize_location(
            _pick_col(row, "prospect_city", "city", "City"),
            _pick_col(row, "prospect_region_name", "province", "Province", "state", "State"),
            _pick_col(row, "business_city_name", "company_city"),
            desc,
        )

        raw_skills = _pick_col(row, "prospect_skills", "skills", "Skills")
        skills = parse_json_list(raw_skills) if raw_skills.startswith("[") else [clean_ws(s) for s in raw_skills.split(",") if clean_ws(s)]

        raw_exp = _pick_col(row, "prospect_experience", "experience")
        experience = parse_json_list(raw_exp) if raw_exp.startswith("[") else [clean_ws(s) for s in raw_exp.split(";") if clean_ws(s)]

        pid = _pick_col(row, "prospect_id", "id") or hashlib.sha1(dedupe_key.encode("utf-8")).hexdigest()[:24]

        kept.append({
            "id": pid,
            "first_name": first_name,
            "last_name": last_name,
            "full_name": full_name,
            "job_title": title or "Decision Maker",
            "department": _pick_col(row, "prospect_job_department", "department"),
            "seniority": parse_json_list(_pick_col(row, "prospect_job_seniority_level", "seniority")),
            "decision_tier": classify_decision_tier(title),
            "segment": segment,
            "is_school_decision_maker": segment in ("school", "college"),
            "institution_type": classify_institution_type(business_name, segment, desc),
            "business_name": business_name,
            "business_domain": domain,
            "business_website": normalize_website(website or domain),
            "business_description": desc,
            "employees_range": clean_range(_pick_col(row, "business_number_of_employees_range", "employees", "# Employees")),
            "revenue_range": clean_range(_pick_col(row, "business_yearly_revenue_range", "revenue")),
            "naics": naics,
            "city": city,
            "province": region,
            "location": ", ".join([p for p in [city, region] if p]) or "South Africa",
            "email": email,
            "email_status": email_status or "domain-verified",
            "popi_verified": True,
            "linkedin_url": linkedin,
            "skills": skills,
            "experience": experience,
            "school_signals": extract_school_signals(business_name, desc, segment),
        })

    if not kept:
        raise ValueError(f"Zero POPI-safe contacts remained after filtering ({excluded_reasons})")

    if enrich_signals:
        cache = enrich_domains_for_leads(kept, force=False, use_gemini=use_gemini)
    else:
        cache = load_cache()
    attach_signals_to_leads(kept, cache)

    kept.sort(key=lambda x: (-int(x.get("hiring_intent_score", 0)), x["business_name"].lower(), x["full_name"].lower()))

    slug = re.sub(r"[^a-z0-9]+", "-", list_name.lower()).strip("-") or "uploaded-list"
    slug = f"{slug}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    LISTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = LISTS_DIR / f"{slug}.json"
    out_file.write_text(json.dumps(kept, indent=2, ensure_ascii=False), encoding="utf-8")

    manifest = load_lists_manifest()
    meta = {
        "id": slug,
        "name": Path(list_name).stem,
        "count": len(kept),
        "schools_count": sum(1 for l in kept if l["is_school_decision_maker"]),
        "hot_hiring_count": sum(1 for l in kept if l.get("hiring_tier") == "Hot Hiring"),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "file": f"data/lists/{slug}.json",
    }
    manifest = [m for m in manifest if m.get("id") != slug]
    manifest.insert(0, meta)
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")

    return {
        "list": meta,
        "leads": kept,
        "stats": {
            "total_rows": len(rows),
            "kept_popi_safe": len(kept),
            "excluded_count": len(rows) - len(kept),
            "excluded_reasons": excluded_reasons,
            "hot_hiring_count": meta["hot_hiring_count"],
        },
    }


def load_lists_manifest() -> list[dict]:
    if MANIFEST_FILE.exists():
        try:
            data = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Enrich built-in leads with live hiring signals")
    parser.add_argument("--force", action="store_true", help="Re-fetch even if cache TTL is valid")
    parser.add_argument("--no-gemini", action="store_true", help="Use deterministic parser only")
    parser.add_argument("--limit", type=int, default=0, help="Optional max leads slice")
    args = parser.parse_args()

    if not BUILTIN_JSON.exists():
        raise FileNotFoundError(f"Missing {BUILTIN_JSON}. Run build_leads.py first.")

    leads = json.loads(BUILTIN_JSON.read_text(encoding="utf-8"))
    target_slice = leads[: args.limit] if args.limit > 0 else leads
    cache = enrich_domains_for_leads(
        target_slice,
        force=args.force,
        use_gemini=not args.no_gemini,
    )
    attach_signals_to_leads(leads, cache)
    write_builtin_bundles(leads)

    hot = sum(1 for l in leads if l.get("hiring_tier") == "Hot Hiring")
    warm = sum(1 for l in leads if l.get("hiring_tier") == "Warm Growth")
    roles_total = sum((l.get("hiring_signals") or {}).get("open_roles_count", 0) for l in leads)
    print(f"Enriched {len(leads)} leads across {len(cache)} cached institutions:")
    print(f"  - Hot Hiring:  {hot}")
    print(f"  - Warm Growth: {warm}")
    print(f"  - Evergreen:   {len(leads) - hot - warm}")
    print(f"  - Open roles linked: {roles_total}")


if __name__ == "__main__":
    main()
