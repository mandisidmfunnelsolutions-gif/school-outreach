# School Decision-Maker Outreach Dispatch & Context-Aware CV Compiler

A dedicated outreach dispatch center and context-aware CV tailoring workspace built for job seekers targeting South African schools, colleges, and EdTech employers.

## Dataset Coverage (69 POPI-Safe Verified Leads)

Filtered and deduplicated from `Outreach/Lead_Lists/consolidated_sa_edtech_schools_20260603105824.csv` and `Outreach/Lead_Lists/sa_edtech_school_prospects_20260603103843.csv` to protect **Siphosihle Mashinini** under POPIA:

- **Strict POPIA Email Filter Applied:**
  - Excluded all `catch-all` / unverified email addresses (12 contacts)
  - Excluded all personal/consumer ISP email domains (`@global.co.za`, `@gmail.com`, `@hotmail.com`, etc.)
  - Excluded all stale or cross-institution domain mismatches (e.g., `cannonscreek.co.za` under `Elkanah House`, `wyet.org`, `isolve.co.za`, `docx.co.za`, `newleafpeople.com`)
  - Stripped all personal phone numbers from the dataset
  - Added a POPIA opt-out / data-removal line to every Cold Email and 7-Day Nudge draft

- **45 School & College Decision Makers** (Default View):
  - **39 K-12 & Online Schools** across Curro Holdings, SPARK Schools, St David's Marist Inanda, Clifton School, Treverton, Rondebosch Boys' High School, Bishops Diocesan College, Highbury Prep, International School of Cape Town, International School of South Africa, Cornwall Hill College, Elkanah House, Midstream College, Centennial Schools, Woodridge College, BenHale Academy, Cedarwood School RSA, St Martin's School, Koa Academy, and Brainline.
  - **6 Colleges & TVET Institutions** across South West Gauteng TVET College, Stellenbosch Business School Executive Development, Skills Academy, AGRICOLLEGES international, and TechWays.Online.
- **24 EdTech & Training Employers** (1-click toggle tab): WorksheetCloud, Top Dog Education, Thuma Mina Teaching, IDEA, EduFeArn, SpecCon Holdings, Geeks4Learning, Digemy, Beeline, and more.

## Key Features

- **Gemini-Powered CV Upload & Outreach Enhancement:**
  - Upload a **PDF, DOCX, TXT, or MD** CV inside **Candidate & CV Profile** (`/api/parse-cv`) — parsed via Gemini (`gemini-3-flash-preview`) to extract real qualifications, subjects, role track, and factual proof points.
  - Add global **Additional Context** (availability, mobility, coaching) and per-school **Additional Context** angles.
  - Click **Enhance All 4 Channels (Gemini)** (`/api/generate-outreach`) to generate crisp, anti-slop drafts grounded strictly in the uploaded CV and school context, or **Tailor with Gemini** (`/api/generate-cv-tips`) inside the CV Compiler tab.
- **LinkedIn Workspace (Direct Profile Routing & Safe-Rate Cadence):**
  - 1-click **Open [Name]'s LinkedIn** direct profile routing + **LinkedIn People Search** fallback + **Next Uncontacted LinkedIn** queue router.
  - Daily safe-rate cadence tracker (`0 / 20 Connects Today`, `0 / 15 DMs Today`) and per-lead LinkedIn stage pills (`Not Connected`, `Connect Req Sent`, `Connected`, `DM Sent`, `Replied`).
  - Side-by-side **Pre-Connection Note (`<= 300 chars`)** and **Post-Connection DM** with `"Copy Note & Open LinkedIn"` / `"Copy DM & Open LinkedIn"` actions.
  - Displays the recipient's LinkedIn career history and a clickable roster of all POPI-safe decision makers at the same institution.
- **Multi-Channel Outreach Dispatch:**
  - Clean, direct **Cold Email** (with `mailto:` launch and POPIA opt-out notice)
  - **LinkedIn Pre-Connection Note** with live 300-character limit counter
  - **LinkedIn Follow-Up DM** and **7-Day Nudge**
  - Automatic gatekeeper routing tips when messaging a PA/EA or School Administrator
- **Contextually Aware CV Compiler:**
  - **Decision-Maker Lens:** Explains what each persona (Principal/Head, Deputy/Instructional Coach, Business Manager/Bursar, IT Lead, PA/EA Gatekeeper, Executive) scans in 15 seconds, alongside their verified LinkedIn skills.
  - **Institution Context:** Extracts real school signals (`IEB`, `CAPS`, `Cambridge`, `Boarding Campus`, `Online / Blended`, `Remedial / Inclusive`, `Multi-Campus Group`, `TVET / SETA`) and outputs tailored positioning directives.
  - **Live CV Keyword Gap Scanner:** Paste your CV once in **Candidate & CV Profile** to score keyword coverage per school and spot missing high-signal terms.
  - **Ready-to-Paste CV Summary, Bullet Starters, Filename & AI Prompt:** 1-click copy for custom CV summaries or a full AI CV-tailoring prompt pre-loaded with the school's real context.
- **Progress Tracking & Export:** Status pills (`Ready`, `CV Tailored`, `Email Sent`, `LinkedIn Sent`, `Replied`, `Interview`), priority stars, private notes, and filtered CSV export.

## Running Locally

### Option 1: Local Server (with JSON state persistence)
```bash
python3 server.py 3005
```
Open **http://127.0.0.1:3005** in your browser.

### Option 2: Direct Browser Open
Open `index.html` directly in Chrome, Safari, or Edge (all data is bundled in `leads-data.js` and progress persists to `localStorage`).

### Option 3: Deploy to Vercel
1. Connect this standalone repository to Vercel (Framework Preset: **Other**, Root Directory: `./`).
2. Add `GEMINI_API_KEY` in **Project Settings -> Environment Variables** to enable live PDF/DOCX CV parsing, Gemini message enhancement, and CV tailoring.
3. Deploy — static assets (`index.html`, `styles.css`, `app.js`, `leads-data.js`) serve from CDN while `/api/*`, `/leads.json`, and `/leads.csv` route through `api/index.py`.

## Rebuilding & Enriching Data from Source CSVs
```bash
python3 scripts/build_leads.py
python3 scripts/enrich_leads.py
```

Or click **Import CSV** inside the web app to drop any new Apollo / Vibe / Apify / custom CSV — it automatically applies the POPIA email filter, enriches institutions from live careers pages & ISASA, and adds the new list to the workspace switcher.
