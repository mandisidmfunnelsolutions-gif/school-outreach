#!/usr/bin/env python3
"""
Builds and deduplicates the School Decision-Maker & Education Leads dataset
from the workspace CSVs in Outreach/Lead_Lists/.

Outputs:
  - data/school_decision_makers.json
  - data/school_decision_makers.csv
  - leads-data.js (zero-CORS embedded dataset for direct browser/local usage)
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_ROOT = BASE_DIR.parent.parent

SOURCE_CSVS = [
    WORKSPACE_ROOT / "Outreach" / "Lead_Lists" / "consolidated_sa_edtech_schools_20260603105824.csv",
    WORKSPACE_ROOT / "Outreach" / "Lead_Lists" / "sa_edtech_school_prospects_20260603103843.csv",
]

DATA_DIR = BASE_DIR / "data"


def clean_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip())


def parse_json_list(raw: str) -> list[str]:
    text = (raw or "").strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            seen = set()
            out = []
            for item in parsed:
                s = clean_ws(str(item))
                if s and s.lower() not in seen:
                    seen.add(s.lower())
                    out.append(s)
            return out
    except Exception:
        pass
    return []


def normalize_linkedin(raw: str) -> str:
    url = clean_ws(raw)
    if not url:
        return ""
    if not url.startswith("http"):
        url = "https://www." + url.lstrip("/")
    return url


def normalize_website(raw: str) -> str:
    url = clean_ws(raw)
    if not url:
        return ""
    if not url.startswith("http"):
        url = "https://" + url.lstrip("/")
    return url


def normalize_location(city_raw: str, region_raw: str, biz_city_raw: str, desc_raw: str) -> tuple[str, str]:
    city = clean_ws(city_raw).title()
    region = clean_ws(region_raw).title()

    city_map = {
        "City Of Johannesburg": "Johannesburg",
        "City Of Cape Town": "Cape Town",
        "Port Elizabeth": "Gqeberha (PE)",
        "Port Elizabeth And Jeffreys Bay": "Gqeberha / Jeffreys Bay",
    }
    city = city_map.get(city, city)

    if not city and biz_city_raw:
        bc = clean_ws(biz_city_raw).title()
        city = city_map.get(bc, bc)

    desc_l = (desc_raw or "").lower()
    if not region:
        if city in {"Cape Town", "Bellville", "Paarl", "Hermanus", "Stellenbosch"} or "cape town" in desc_l:
            region = "Western Cape"
        elif city in {"Johannesburg", "Pretoria", "Centurion", "Midrand", "Northriding", "Kempton Park"}:
            region = "Gauteng"
        elif city in {"Durban", "Mooi River"} or "kwazulu-natal" in desc_l or "durban" in desc_l:
            region = "KwaZulu-Natal"
        elif "gqeberha" in city.lower() or "port elizabeth" in desc_l or "jeffreys bay" in desc_l:
            region = "Eastern Cape"
        elif "mafikeng" in desc_l or "mahikeng" in desc_l:
            if not city:
                city = "Mahikeng"
            region = "North West"

    if region == "Kwazulu-Natal":
        region = "KwaZulu-Natal"
    if region == "Florida":
        region = "International (US)"

    return city, region


def classify_segment(business_name: str, naics: str, desc: str) -> str:
    bn = business_name.lower()
    naics_l = (naics or "").lower()
    desc_l = (desc or "").lower()

    if any(k in bn for k in [
        "south west gauteng tvet",
        "stellenbosch business school",
        "skills academy",
        "agricolleges",
        "techways.online",
    ]):
        return "college"

    if "elementary and secondary schools" in naics_l or any(k in bn for k in [
        "curro",
        "spark schools",
        "rondebosch",
        "bishops",
        "highbury",
        "koa academy",
        "international school",
        "cornwall hill",
        "st david's",
        "st martin's",
        "clifton school",
        "treverton",
        "elkanah house",
        "royal schools",
        "saheti",
        "midstream college",
        "centennial schools",
        "woodridge",
        "benhale",
        "cedarwood",
        "brainline",
    ]):
        return "school"

    if "school" in bn or "college" in bn or "academy" in bn:
        if "business schools" in naics_l or "elementary" in naics_l or "school" in desc_l[:180]:
            return "school"

    return "edtech"


def has_word(text: str, phrases: list[str]) -> bool:
    for p in phrases:
        if re.search(r"\b" + re.escape(p) + r"\b", text):
            return True
    return False


def classify_decision_tier(title: str) -> str:
    t = title.lower()
    if has_word(t, ["pa to", "personal assistant", "executive assistant", "school administrator"]):
        return "EA / PA / Admin"
    if has_word(t, ["bursar", "business manager", "finance manager"]):
        return "Business / Bursar"
    if has_word(t, ["information technology", "technology officer", "cto", "it manager", "it director"]):
        return "IT / Digital"
    if has_word(t, ["deputy principal", "deputy headmaster", "deputy headmistress", "assistant principal", "instructional coach", "fet deputy principal"]):
        return "Deputy / Instructional"
    if has_word(t, ["principal", "headmaster", "headmistress", "executive head", "head of school", "preparatory principal"]):
        return "Principal / Head"
    return "Executive / Founder"


def classify_institution_type(business_name: str, segment: str, desc: str) -> str:
    bn = business_name.lower()
    desc_l = (desc or "").lower()
    if segment == "edtech":
        if has_word(desc_l, ["npo"]) or "thuma mina" in bn:
            return "Education NPO / Teaching Support"
        if has_word(desc_l, ["software", "cloud", "testing", "sap", "ict", "virtual reality", "product development"]):
            return "EdTech & Tech Training"
        return "E-Learning & Curriculum"
    if segment == "college":
        if "tvet" in bn:
            return "Public TVET College"
        return "College / Skills & Exec Ed"
    if any(k in bn for k in ["curro", "spark", "royal schools", "centennial"]):
        return "Private School Group"
    if any(k in bn for k in ["koa academy", "brainline"]):
        return "Online / Hybrid School"
    if "cedarwood" in bn:
        return "Remedial / Inclusive School"
    if has_word(desc_l, ["boarding"]):
        return "Independent Day & Boarding"
    return "Independent School"


def extract_school_signals(business_name: str, desc: str, segment: str) -> list[str]:
    text = f"{business_name} {desc}".lower()
    signals = []
    checks = [
        ("IEB Curriculum", ["ieb"]),
        ("CAPS Curriculum", ["caps"]),
        ("Cambridge / British", ["cambridge", "british-style"]),
        ("Online / Blended", ["online", "e-learning", "digied", "blended", "pods", "lms", "microlearning"]),
        ("Boarding Campus", ["boarding"]),
        ("Multi-Campus Group", ["campuses", "network of private schools", "curro"]),
        ("Remedial / Inclusive", ["remedial", "assisted learning", "mild to moderate support", "inclusive"]),
        ("ISASA Accredited", ["isasa"]),
        ("Boys' School", ["boys school", "boys' high", "for boys"]),
        ("TVET / SETA / NQF", ["tvet", "dhet", "seta", "nqf", "learnerships"]),
        ("STEM / Digital Skills", ["ict", "digital", "coding", "tech skills", "virtual reality", "augmented reality", "robotics", "tech-abled"]),
    ]
    for label, keywords in checks:
        if has_word(text, keywords):
            signals.append(label)
    if not signals:
        signals.append("Education & Training" if segment == "edtech" else "Independent Education")
    return signals[:5]


def clean_range(raw: str) -> str:
    return clean_ws(raw).strip("[]")


PERSONAL_OR_ISP_DOMAINS = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
    "live.com", "msn.com", "aol.com", "proton.me", "protonmail.com",
    "mweb.co.za", "global.co.za", "telkomsa.net", "iafrica.com", "vodamail.co.za",
}

ALLOWED_INSTITUTIONAL_ALIASES = {
    "cornwall.co.za": {"cornwallhill.org"},
    "sbs-ed.com": {"usb-ed.com"},
}


def is_popi_safe_contact(email: str, email_status: str, business_domain: str) -> tuple[bool, str]:
    """
    Enforces strict POPIA-safe B2B/institutional contact hygiene:
      1. Must have a non-empty, SMTP-'valid' email address (no catch-all / unverified).
      2. Must not be a personal, freemail, or consumer ISP domain.
      3. Must match the institution's verified corporate/school domain (or known official alias)
         to prevent stale or cross-school contact errors.
    """
    em = (email or "").strip().lower()
    if not em or "@" not in em:
        return False, "missing_email"
    if (email_status or "").strip().lower() != "valid":
        return False, f"unverified_status:{email_status}"

    edom = em.split("@", 1)[1]
    if edom in PERSONAL_OR_ISP_DOMAINS:
        return False, f"personal_or_isp_domain:{edom}"

    bdom = (business_domain or "").strip().lower()
    if bdom:
        allowed = ALLOWED_INSTITUTIONAL_ALIASES.get(bdom, set())
        if edom != bdom and not edom.endswith("." + bdom) and edom not in allowed:
            return False, f"domain_mismatch:{edom}!={bdom}"

    return True, "ok"


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    seen: dict[str, dict] = {}
    for csv_path in SOURCE_CSVS:
        if not csv_path.exists():
            raise FileNotFoundError(f"Missing source CSV: {csv_path}")
        with csv_path.open("r", encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                pid = clean_ws(row.get("prospect_id", ""))
                if not pid or pid in seen:
                    continue
                seen[pid] = row

    leads = []
    excluded_count = 0
    for raw in seen.values():
        full_name = clean_ws(raw.get("prospect_full_name", ""))
        first_name = clean_ws(raw.get("prospect_first_name", "")) or full_name.split(" ")[0]
        last_name = clean_ws(raw.get("prospect_last_name", ""))
        title = clean_ws(raw.get("prospect_job_title", ""))
        business_name = clean_ws(raw.get("business_name", ""))
        business_domain = clean_ws(raw.get("business_domain", ""))
        desc = clean_ws(raw.get("business_business_description", ""))
        naics = clean_ws(raw.get("business_naics_description", ""))

        email = clean_ws(raw.get("contact_professions_email", "")).lower()
        email_status = clean_ws(raw.get("contact_professional_email_status", "")).lower() or "unknown"

        popi_ok, popi_reason = is_popi_safe_contact(email, email_status, business_domain)
        if not popi_ok:
            excluded_count += 1
            continue

        segment = classify_segment(business_name, naics, desc)
        city, region = normalize_location(
            raw.get("prospect_city", ""),
            raw.get("prospect_region_name", ""),
            raw.get("business_city_name", ""),
            desc,
        )

        linkedin = normalize_linkedin(raw.get("prospect_linkedin", ""))
        website = normalize_website(raw.get("business_website", ""))
        skills = parse_json_list(raw.get("prospect_skills", ""))
        experience = parse_json_list(raw.get("prospect_experience", ""))
        seniority = parse_json_list(raw.get("prospect_job_seniority_level", ""))

        lead = {
            "id": raw.get("prospect_id", ""),
            "first_name": first_name,
            "last_name": last_name,
            "full_name": full_name,
            "job_title": title,
            "department": clean_ws(raw.get("prospect_job_department", "")),
            "seniority": seniority,
            "decision_tier": classify_decision_tier(title),
            "segment": segment,
            "is_school_decision_maker": segment in ("school", "college"),
            "institution_type": classify_institution_type(business_name, segment, desc),
            "business_name": business_name,
            "business_domain": business_domain,
            "business_website": website,
            "business_description": desc,
            "employees_range": clean_range(raw.get("business_number_of_employees_range", "")),
            "revenue_range": clean_range(raw.get("business_yearly_revenue_range", "")),
            "naics": naics,
            "city": city,
            "province": region,
            "location": ", ".join([p for p in [city, region] if p]) or "South Africa",
            "email": email,
            "email_status": email_status,
            "popi_verified": True,
            "linkedin_url": linkedin,
            "skills": skills,
            "experience": experience,
            "school_signals": extract_school_signals(business_name, desc, segment),
        }
        leads.append(lead)

    # Sort deterministically: School Decision Makers first (K-12 -> College -> EdTech), then Institution, then Tier priority
    tier_order = {
        "Principal / Head": 1,
        "Deputy / Instructional": 2,
        "Business / Bursar": 3,
        "IT / Digital": 4,
        "EA / PA / Admin": 5,
        "Executive / Founder": 6,
    }
    seg_order = {"school": 1, "college": 2, "edtech": 3}
    leads.sort(key=lambda x: (
        seg_order.get(x["segment"], 9),
        tier_order.get(x["decision_tier"], 9),
        x["business_name"].lower(),
        x["full_name"].lower(),
    ))

    # Preserve & attach cached institution hiring signals if present
    cache_path = DATA_DIR / "institution_signals_cache.json"
    if cache_path.exists():
        try:
            from enrich_leads import attach_signals_to_leads, load_cache, write_builtin_bundles
            attach_signals_to_leads(leads, load_cache())
            write_builtin_bundles(leads)
        except Exception:
            pass

    if not (DATA_DIR / "school_decision_makers.json").exists() or not cache_path.exists():
        # Write JSON
        json_out = DATA_DIR / "school_decision_makers.json"
        json_out.write_text(json.dumps(leads, indent=2, ensure_ascii=False), encoding="utf-8")

        # Write CSV
        csv_out = DATA_DIR / "school_decision_makers.csv"
        csv_fields = [
            "id", "full_name", "job_title", "decision_tier", "segment",
            "is_school_decision_maker", "institution_type", "business_name",
            "email", "email_status", "linkedin_url", "business_website",
            "city", "province", "employees_range", "school_signals", "skills",
        ]
        with csv_out.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=csv_fields)
            writer.writeheader()
            for l in leads:
                row = {k: l.get(k, "") for k in csv_fields}
                row["school_signals"] = "; ".join(l["school_signals"])
                row["skills"] = "; ".join(l["skills"])
                writer.writerow(row)

        # Write JS bundle for zero-CORS direct opening
        js_out = BASE_DIR / "leads-data.js"
        js_out.write_text(
            "// Auto-generated by scripts/build_leads.py from Outreach/Lead_Lists/\n"
            f"window.SCHOOL_DISPATCH_LEADS = {json.dumps(leads, ensure_ascii=False)};\n",
            encoding="utf-8",
        )

    school_count = sum(1 for l in leads if l["segment"] == "school")
    college_count = sum(1 for l in leads if l["segment"] == "college")
    edtech_count = sum(1 for l in leads if l["segment"] == "edtech")
    print(f"Generated {len(leads)} POPI-safe unique leads (excluded {excluded_count} unverified/personal/mismatched contacts):")
    print(f"  - K-12 & Online Schools: {school_count}")
    print(f"  - Colleges & TVET:       {college_count}")
    print(f"  - School Decision Makers Total: {school_count + college_count}")
    print(f"  - EdTech & Training Orgs:       {edtech_count}")


if __name__ == "__main__":
    main()
