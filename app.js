(() => {
  let LEADS = Array.isArray(window.SCHOOL_DISPATCH_LEADS) ? window.SCHOOL_DISPATCH_LEADS : [];

  const STORAGE_KEYS = {
    STATES: "school_dispatch_lead_states_v1",
    PROFILE: "school_dispatch_candidate_profile_v1",
    THEME: "school_dispatch_theme_v1",
    DAILY_LI: "school_dispatch_daily_linkedin_v1",
  };

  const LINKEDIN_STAGE_LABELS = {
    not_connected: "Not Connected",
    connect_sent: "Connect Req Sent",
    connected: "Connected",
    dm_sent: "DM Sent",
    replied: "Replied",
  };

  const TRACK_LABELS = {
    educator: "Educator / Subject Teacher",
    instructional: "Instructional Coach / Curriculum",
    admin_marketing: "Admin, Admissions & Marketing",
    finance_ops: "Operations, Finance & Bursary",
    it_systems: "School IT, LMS & Digital Systems",
    graduate_intern: "Graduate / Intern / Teaching Assistant",
  };

  const STATUS_LABELS = {
    ready: "Ready",
    cv_tailored: "CV Tailored",
    email_sent: "Email Sent",
    linkedin_sent: "LinkedIn Sent",
    replied: "Replied",
    interview: "Interview",
    archived: "Archived",
  };

  const DEFAULT_PROFILE = {
    name: "Siphosihle Mashinini",
    email: "",
    phone: "",
    linkedin: "",
    track: "educator",
    credentials: "",
    additionalContext: "",
    cvFileName: "",
    pitchFacts: [],
    cvText: "",
  };

  const appState = {
    activeListId: "builtin",
    availableLists: [],
    segment: "schools_all",
    search: "",
    province: "all",
    tier: "all",
    institution: "all",
    status: "all",
    hiringFilter: "all",
    sortOrder: "hiring_desc",
    activeLeadId: null,
    activeTab: "dispatch",
    activeChannel: "email",
    geminiConfigured: false,
    leadStates: loadJson(STORAGE_KEYS.STATES, {}),
    profile: { ...DEFAULT_PROFILE, ...loadJson(STORAGE_KEYS.PROFILE, {}) },
    filteredLeads: [],
  };

  // DOM helpers
  const $ = (id) => document.getElementById(id);

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function saveStates() {
    try {
      localStorage.setItem(STORAGE_KEYS.STATES, JSON.stringify(appState.leadStates));
    } catch {
      // ignore storage quota errors
    }
    syncStatesToServer();
  }

  async function syncStatesToServer() {
    if (window.location.protocol === "file:") return;
    try {
      await fetch("/api/lead-states", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(appState.leadStates),
      });
    } catch {
      // static mode fallback silently succeeds
    }
  }

  function renderListSelector() {
    const sel = $("listSelector");
    if (!sel) return;
    sel.innerHTML = "";
    const lists = appState.availableLists.length
      ? appState.availableLists
      : [{ id: "builtin", name: "Built-in POPIA School & EdTech List", count: LEADS.length }];
    lists.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.id;
      const hotText = item.hot_hiring_count ? ` • ${item.hot_hiring_count} Hot` : "";
      opt.textContent = `${item.name} (${item.count}${hotText})`;
      sel.appendChild(opt);
    });
    sel.value = lists.some((l) => l.id === appState.activeListId) ? appState.activeListId : "builtin";
  }

  async function loadLeadList(listId) {
    if (window.location.protocol === "file:") return;
    try {
      const res = await fetch(`/api/lists/${encodeURIComponent(listId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        LEADS = data;
        appState.activeListId = listId;
        appState.activeLeadId = null;
        renderListSelector();
        renderAll();
      }
    } catch {
      // ignore offline
    }
  }

  async function hydrateStatesFromServer() {
    if (window.location.protocol === "file:") return;
    try {
      const [statesRes, profRes, statusRes, listsRes, activeListRes] = await Promise.all([
        fetch("/api/lead-states"),
        fetch("/api/profile"),
        fetch("/api/status"),
        fetch("/api/lists"),
        fetch(`/api/lists/${encodeURIComponent(appState.activeListId)}`),
      ]);
      if (statusRes.ok) {
        const st = await statusRes.json();
        appState.geminiConfigured = Boolean(st && st.gemini_configured);
      }
      if (listsRes.ok) {
        const lData = await listsRes.json();
        if (lData && Array.isArray(lData.lists)) {
          appState.availableLists = lData.lists;
          renderListSelector();
        }
      }
      if (activeListRes.ok) {
        const freshLeads = await activeListRes.json();
        if (Array.isArray(freshLeads) && freshLeads.length > 0) {
          LEADS = freshLeads;
        }
      }
      if (statesRes.ok) {
        const remote = await statesRes.json();
        if (remote && typeof remote === "object" && Object.keys(remote).length > 0) {
          appState.leadStates = { ...remote, ...appState.leadStates };
          localStorage.setItem(STORAGE_KEYS.STATES, JSON.stringify(appState.leadStates));
        }
      }
      if (profRes.ok) {
        const remoteProf = await profRes.json();
        if (remoteProf && typeof remoteProf === "object" && Object.keys(remoteProf).length > 0) {
          if (!appState.profile.cvText && remoteProf.cvText) {
            appState.profile = { ...DEFAULT_PROFILE, ...remoteProf };
            localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(appState.profile));
          }
        }
      }
      renderAll();
    } catch {
      // optional server endpoint
    }
  }

  async function saveProfileToServer() {
    if (window.location.protocol === "file:") return;
    try {
      await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(appState.profile),
      });
    } catch {
      // ignore offline
    }
  }

  function getLeadState(id) {
    if (!appState.leadStates[id]) {
      appState.leadStates[id] = {
        status: "ready",
        linkedinStage: "not_connected",
        starred: false,
        note: "",
        leadContext: "",
        checklist: {},
        customDrafts: {},
        aiDrafts: null,
        aiCvTips: null,
      };
    }
    if (!appState.leadStates[id].linkedinStage) {
      appState.leadStates[id].linkedinStage = "not_connected";
    }
    return appState.leadStates[id];
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function getDailyLinkedinStats() {
    const all = loadJson(STORAGE_KEYS.DAILY_LI, {});
    const today = todayIso();
    const rec = all[today] || { connects: 0, dms: 0 };
    return { connects: Number(rec.connects || 0), dms: Number(rec.dms || 0) };
  }

  function bumpDailyLinkedinStat(field) {
    const all = loadJson(STORAGE_KEYS.DAILY_LI, {});
    const today = todayIso();
    const rec = all[today] || { connects: 0, dms: 0 };
    rec[field] = Number(rec[field] || 0) + 1;
    all[today] = rec;
    try {
      localStorage.setItem(STORAGE_KEYS.DAILY_LI, JSON.stringify(all));
    } catch {
      // ignore
    }
  }

  function initialsOf(name) {
    return (name || "?")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("");
  }

  function showToast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add("hidden"), 2400);
  }

  async function copyText(text, successMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast(successMsg);
    }
  }

  // Segment helper
  function matchesSegment(lead, segment) {
    if (segment === "schools_all") return Boolean(lead.is_school_decision_maker);
    if (segment === "edtech") return lead.segment === "edtech";
    return true;
  }

  // Contextually Aware CV Compiler Engine
  function getDecisionMakerLens(lead) {
    const tier = lead.decision_tier;
    const lenses = {
      "Principal / Head": {
        scanFocus:
          "Heads and Principals scan a CV in 15–20 seconds for three trust signals: verified credentials (SACE / degree / clearance), genuine alignment with the school's ethos and co-curricular life, and low-friction classroom or operational ownership.",
        avoid: "Avoid multi-page dense prose or generic 'hardworking team player' objectives without phase, subject, or school-life specificity.",
      },
      "Deputy / Instructional": {
        scanFocus:
          "Deputy Principals and Instructional Coaches prioritize pedagogical substance: curriculum alignment (IEB/CAPS/Cambridge), formative assessment habits, learner differentiation, and measurable academic lift.",
        avoid: "Avoid listing job duties without teaching methods, assessment tools, or classroom outcomes.",
      },
      "Business / Bursar": {
        scanFocus:
          "Business Managers and Bursars look for commercial rigor, fee/vendor reconciliation accuracy, audit readiness, spreadsheet/ERP fluency, and clear cost-saving or turnaround metrics.",
        avoid: "Avoid vague operational claims; quantify budgets managed, arrears reduced, or process turnaround times.",
      },
      "IT / Digital": {
        scanFocus:
          "School IT Leads evaluate practical stack breadth (Google Workspace / M365 Admin, LMS integration, network/device fleet support) and your ability to support non-technical educators calmly.",
        avoid: "Avoid pure enterprise jargon without showing user-support patience or educational software familiarity.",
      },
      "EA / PA / Admin": {
        scanFocus:
          "PAs and EAs act as the triage gatekeeper for busy Principals and CEOs. They route PDFs within 5 seconds based on how clearly your Role Title, Availability, and Credentials appear at the top of Page 1.",
        avoid: "Never bury your target role or contact details on Page 2; put a crisp header badge and 3-line summary above the fold.",
      },
      "Executive / Founder": {
        scanFocus:
          "School Group Executives and EdTech Founders value ownership, measurable execution speed, digital fluency, and cross-functional reliability over rigid bureaucratic job titles.",
        avoid: "Avoid passive language; lead with initiatives launched, systems improved, or learner/client metrics moved.",
      },
    };
    return lenses[tier] || lenses["Executive / Founder"];
  }

  function buildTargetKeywords(lead, profile) {
    const trackKeywords = {
      educator: [
        "SACE",
        "lesson planning",
        "assessment",
        "classroom management",
        "differentiated instruction",
        "parent communication",
        "co-curricular",
        "pastoral care",
      ],
      instructional: [
        "curriculum design",
        "instructional coaching",
        "teacher mentoring",
        "data analysis",
        "LMS",
        "blended learning",
        "formative assessment",
        "professional development",
      ],
      admin_marketing: [
        "admissions",
        "parent liaison",
        "CRM",
        "event coordination",
        "communications",
        "enrollment",
        "Microsoft Office",
        "stakeholder management",
      ],
      finance_ops: [
        "billing",
        "cash flow",
        "reconciliation",
        "budgeting",
        "procurement",
        "compliance",
        "operations management",
        "Excel",
      ],
      it_systems: [
        "Microsoft 365",
        "Google Workspace",
        "LMS",
        "helpdesk",
        "network administration",
        "device management",
        "cybersecurity",
        "training",
      ],
      graduate_intern: [
        "teaching practice",
        "tutoring",
        "lesson support",
        "extracurricular",
        "classroom support",
        "digital literacy",
        "mentoring",
        "adaptability",
      ],
    };

    const signalKeywords = {
      "IEB Curriculum": ["IEB", "portfolio assessment"],
      "CAPS Curriculum": ["CAPS"],
      "Cambridge / British": ["Cambridge", "IGCSE"],
      "Online / Blended": ["online teaching", "LMS", "blended learning", "digital classroom"],
      "Boarding Campus": ["boarding", "pastoral", "co-curricular", "first aid"],
      "Multi-Campus Group": ["reporting", "standardized", "scalable"],
      "Remedial / Inclusive": ["remedial", "inclusive", "IEP", "learner support", "accommodations"],
      "ISASA Accredited": ["ISASA", "holistic education"],
      "Boys' School": ["sport coaching", "mentorship"],
      "TVET / SETA / NQF": ["TVET", "SETA", "NQF", "assessor", "facilitator"],
      "STEM / Digital Skills": ["digital skills", "STEM", "edtech"],
    };

    const pool = [...(trackKeywords[profile.track] || trackKeywords.educator)];
    (lead.school_signals || []).forEach((sig) => {
      (signalKeywords[sig] || []).forEach((kw) => pool.push(kw));
    });

    // Pull top relevant skills from the decision maker's CSV profile
    (lead.skills || []).slice(0, 6).forEach((sk) => {
      if (sk.length <= 32) pool.push(sk);
    });

    // Deduplicate case-insensitively
    const seen = new Set();
    const deduped = [];
    for (const item of pool) {
      const clean = item.trim();
      if (!clean) continue;
      const lower = clean.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        deduped.push(clean);
      }
    }
    return deduped.slice(0, 14);
  }

  function analyzeCvMatch(lead, profile) {
    const keywords = buildTargetKeywords(lead, profile);
    const corpus = `${profile.cvText || ""} ${profile.credentials || ""}`.trim().toLowerCase();
    if (!corpus) {
      return { hasCv: false, score: null, matched: [], missing: keywords };
    }

    const matched = [];
    const missing = [];
    for (const kw of keywords) {
      const tokens = kw.toLowerCase().split(/[\s/]+/).filter((t) => t.length > 1);
      const exactMatch = corpus.includes(kw.toLowerCase());
      const tokenMatch = tokens.length > 1 && tokens.every((t) => corpus.includes(t));
      if (exactMatch || tokenMatch) {
        matched.push(kw);
      } else {
        missing.push(kw);
      }
    }
    const score = keywords.length ? Math.round((matched.length / keywords.length) * 100) : 0;
    return { hasCv: true, score, matched, missing };
  }

  function buildPositioningDirectives(lead, profile) {
    const directives = [];
    const signals = new Set(lead.school_signals || []);
    const bn = lead.business_name;

    if (signals.has("IEB Curriculum")) {
      directives.push(`Put IEB familiarity (or transferable critical-thinking & portfolio assessment rigor) in your top CV summary for ${bn}.`);
    } else if (signals.has("Cambridge / British")) {
      directives.push(`Highlight Cambridge / international curriculum adaptability (IGCSE/AS/A-Level or inquiry-based assessment) prominently for ${bn}.`);
    } else if (signals.has("CAPS Curriculum")) {
      directives.push(`Reference CAPS alignment, ATP pacing, and termly moderation readiness clearly near the top of Page 1.`);
    }

    if (signals.has("Boarding Campus") || signals.has("ISASA Accredited") || signals.has("Boys' School")) {
      directives.push(`Add a dedicated "Co-Curricular, Sport & Pastoral Contribution" mini-block — independent schools hire the whole community contributor, not just a timetable slot.`);
    }

    if (signals.has("Online / Blended") || lead.segment === "edtech") {
      directives.push(`Surface concrete digital tools (LMS platforms, Microsoft Teams/Google Classroom, async video feedback, or learner analytics) in your experience bullets.`);
    }

    if (signals.has("Remedial / Inclusive")) {
      directives.push(`Emphasize differentiated instruction, IEP/support-plan collaboration, and calm classroom scaffolding for diverse learner needs.`);
    }

    if (signals.has("Multi-Campus Group")) {
      directives.push(`Show openness to multi-campus standards, clean data tracking, and structured communication across a larger private group.`);
    }

    if (signals.has("TVET / SETA / NQF")) {
      directives.push(`Include NQF levels taught/supported, SETA/DHET compliance familiarity, and practical workplace-readiness outcomes.`);
    }

    if (lead.decision_tier === "EA / PA / Admin") {
      directives.push(`Because ${lead.first_name} is a gatekeeper (${lead.job_title}), place a bold Role & Availability Header Line at the very top so they can forward your PDF to the exact HOD or Principal immediately.`);
    } else if (lead.decision_tier === "Business / Bursar") {
      directives.push(`Frame every bullet around operational reliability, compliance accuracy, cost awareness, and parent/vendor service standards.`);
    } else if (lead.decision_tier === "IT / Digital") {
      directives.push(`Pair technical competencies (M365/Google Admin, LMS, hardware troubleshooting) with examples of training or supporting educators smoothly.`);
    }

    if (profile.track === "graduate_intern") {
      directives.push(`Lead with Teaching Practice / Internship hours, mentor feedback, tech readiness, and willingness to assist with relief, sport, and admin from day one.`);
    }

    if (directives.length < 3) {
      directives.push(`Keep the CV to 1–2 crisp pages, lead with a 3-line summary tailored to ${bn}, and include SA compliance items (SACE / Police Clearance / Driver's Licence where applicable).`);
    }

    return directives.slice(0, 4);
  }

  function compileCvGuidance(lead, profile) {
    const lens = getDecisionMakerLens(lead);
    const gap = analyzeCvMatch(lead, profile);
    const directives = buildPositioningDirectives(lead, profile);
    const trackLabel = TRACK_LABELS[profile.track] || TRACK_LABELS.educator;
    const creds = (profile.credentials || "").trim() || "SACE / Relevant Qualification / Digital Fluency";
    const signalsStr = (lead.school_signals || []).join(", ");

    const summaryByTrack = {
      educator: `Dedicated educator (${creds}) seeking to contribute to ${lead.business_name}'s academic excellence and holistic learner community (${signalsStr}). Known for structured lesson delivery, calm classroom leadership, and active involvement in co-curricular and pastoral life.`,
      instructional: `Curriculum & instructional specialist (${creds}) focused on elevating teaching quality, blended learning adoption, and measurable learner progress at ${lead.business_name}. Experienced in coaching educators, translating assessment data into action, and scaling LMS-enabled classrooms.`,
      admin_marketing: `Detail-oriented school administration and admissions coordinator (${creds}) ready to support ${lead.business_name}'s parent experience, enrollment pipeline, and daily office operations with precision, warmth, and CRM/Microsoft 365 fluency.`,
      finance_ops: `Analytical operations and finance professional (${creds}) equipped to strengthen billing accuracy, budget tracking, supplier coordination, and governance compliance within ${lead.business_name}'s business office.`,
      it_systems: `Hands-on educational IT & systems specialist (${creds}) focused on keeping ${lead.business_name}'s classrooms, LMS, and staff devices reliable, secure, and effortless for teachers and learners every day.`,
      graduate_intern: `Proactive graduate and aspiring school professional (${creds}) eager to add immediate capacity at ${lead.business_name} across classroom support, relief cover, co-curriculars, and digital administration while learning from experienced leadership.`,
    };

    const bulletsByTrack = {
      educator: [
        `Designed and delivered CAPS/IEB-aligned lessons with differentiated tasks, improving learner engagement and termly assessment consistency.`,
        `Partnered with parents and pastoral heads on proactive academic check-ins and holistic learner support.`,
        `Led co-curricular / sport / society commitments alongside full classroom load and digital gradebook administration.`,
      ],
      instructional: [
        `Coached educators on blended lesson workflows and formative assessment tracking, lifting instructional consistency across grades.`,
        `Built reusable digital resource banks and LMS templates that reduced weekly teacher prep friction.`,
        `Analyzed termly learner performance data to target early academic interventions with Heads of Department.`,
      ],
      admin_marketing: [
        `Managed parent inquiries, admissions tours, and enrollment documentation with fast turnaround and accurate CRM tracking.`,
        `Coordinated school newsletters, open-day logistics, and leadership calendar workflows across academic and admin teams.`,
        `Streamlined digital forms and parent communication templates to reduce repetitive front-office follow-ups.`,
      ],
      finance_ops: [
        `Reconciled monthly fee accounts, supplier invoices, and departmental budgets with clean audit-ready documentation.`,
        `Improved debtor follow-up workflows and cash-flow reporting visibility for school leadership.`,
        `Maintained vendor contracts, compliance registers, and procurement controls across campus operations.`,
      ],
      it_systems: [
        `Administered Google Workspace / Microsoft 365 accounts, classroom AV, and LMS access for staff and learners.`,
        `Reduced recurring teacher tech disruptions through clear quick-start guides and responsive daily support.`,
        `Managed device inventory, cybersecurity hygiene, and vendor escalations across campus networks.`,
      ],
      graduate_intern: [
        `Supported lead educators with small-group learner remediation, marking administration, and digital classroom setup.`,
        `Assisted with daily relief cover, invigilation, and after-school sport/cultural supervision reliably.`,
        `Digitized lesson materials and tracking sheets to save senior staff preparation time each week.`,
      ],
    };

    const candidateSlug = (profile.name || "Siphosihle_Mashinini").trim().replace(/\s+/g, "_");
    const schoolSlug = lead.business_name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 28);
    const filename = `${candidateSlug}_CV_${schoolSlug}.pdf`;

    const checklistItems = [
      { id: "fold", text: `Put Target Role + ${creds} in the top 25% of Page 1` },
      { id: "signals", text: `Mirror ${lead.business_name} signals (${(lead.school_signals || []).slice(0, 2).join(", ") || "school ethos"})` },
      { id: "skills", text: lead.skills.length ? `Echo relevant decision-maker priorities (${lead.skills.slice(0, 3).join(", ")})` : `Align bullets with ${lead.decision_tier} priorities` },
      { id: "compliance", text: "Include SA compliance block (SACE / Police Clearance / Referees / Driver's Licence)" },
      { id: "filename", text: `Export as clean 1–2 page PDF named ${filename}` },
    ];

    const aiPrompt = [
      `Tailor my CV for a job inquiry to ${lead.full_name} (${lead.job_title}) at ${lead.business_name} (${lead.location}).`,
      ``,
      `Target Role Track: ${trackLabel}`,
      `My Key Credentials: ${creds}`,
      profile.additionalContext ? `Additional Context: ${profile.additionalContext}` : "",
      `Institution Context: ${lead.business_description || lead.institution_type}`,
      `Key School Signals: ${signalsStr}`,
      `Decision-Maker LinkedIn Skills: ${(lead.skills || []).slice(0, 10).join(", ") || "Education leadership"}`,
      gap.missing.length ? `Missing Keywords to Weave In Naturally (only where truthful): ${gap.missing.join(", ")}` : "",
      ``,
      `Instructions:`,
      `1. Rewrite my 3-line Professional Summary specifically for ${lead.business_name} and ${lead.job_title}.`,
      `2. Reorder and sharpen my top 5 experience bullets using concrete outcomes—never invent credentials I don't have.`,
      `3. Keep the layout scannable in 15 seconds on Page 1 for a ${lead.decision_tier}.`,
      ``,
      `My Current CV:`,
      profile.cvText ? profile.cvText : "[Paste your current CV text here]",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      lens,
      gap,
      directives,
      trackLabel,
      summarySnippet: summaryByTrack[profile.track] || summaryByTrack.educator,
      bulletStarters: bulletsByTrack[profile.track] || bulletsByTrack.educator,
      filename,
      checklistItems,
      aiPrompt,
    };
  }

  // De-slopped Outreach Copy Engine (POPIA-compliant 1-to-1 job inquiry templates)
  function compileOutreachDraft(lead, channel, profile, leadContext = "") {
    const senderName = (profile.name || "").trim() || "Siphosihle Mashinini";
    const senderContact = [profile.email, profile.phone].filter(Boolean).join(" | ");
    const creds = (profile.credentials || "").trim();
    const extraNote = (leadContext || profile.additionalContext || "").trim();
    const pitchFact = Array.isArray(profile.pitchFacts) && profile.pitchFacts.length > 0 ? profile.pitchFacts[0] : "";

    const trackRoles = {
      educator: "teaching",
      instructional: "curriculum and instructional coaching",
      admin_marketing: "school administration and admissions",
      finance_ops: "school finance and operations",
      it_systems: "school IT and LMS support",
      graduate_intern: "teaching assistant and relief support",
    };
    const roleLabel = trackRoles[profile.track] || "school support";
    const roleCap = roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1);
    const school = lead.business_name;
    const first = lead.first_name || "there";
    const isGatekeeper = lead.decision_tier === "EA / PA / Admin";
    const popiaOptOut =
      'POPIA: One-to-one career inquiry to your institutional address. Reply "opt out" if you prefer not to receive speculative CVs.';

    const sigBlock = [
      senderName,
      creds || null,
      senderContact || null,
      profile.linkedin || null,
    ]
      .filter(Boolean)
      .join("\n");

    const backgroundSentence = pitchFact
      ? pitchFact.replace(/\.$/, "") + "."
      : creds
      ? `My background covers ${creds}.`
      : `I have hands-on ${roleLabel} experience and can step into permanent, contract, or relief cover.`;

    const extraSentence = extraNote ? ` ${extraNote.replace(/\.$/, "")}.` : "";
    const openRoles = (lead.hiring_signals && Array.isArray(lead.hiring_signals.open_roles)) ? lead.hiring_signals.open_roles : [];
    const topOpenRole = openRoles.length > 0 && openRoles[0].title ? openRoles[0].title : "";

    if (channel === "email") {
      const subject = topOpenRole
        ? `${topOpenRole} / ${roleLabel} at ${school} - ${senderName}`
        : isGatekeeper
        ? `CV for ${roleLabel} openings at ${school} - ${senderName}`
        : `${roleCap} availability at ${school} - ${senderName}`;

      const opener = topOpenRole
        ? isGatekeeper
          ? `I noticed ${school}'s ${topOpenRole} opening and wanted to share my CV. Could you please pass it along to the Principal or relevant HOD?`
          : `I saw ${school}'s listing for ${topOpenRole} and wanted to share my CV directly, alongside my availability for teaching or relief cover.`
        : isGatekeeper
        ? `Could I ask a quick favour? If ${school} has any upcoming ${roleLabel} or relief openings, would you mind passing my CV along to the Principal or relevant HOD?`
        : `I am writing to share my CV with ${school} in case any ${roleLabel} posts or short-notice relief cover open up for the coming term.`;

      const body = [
        `Hi ${first},`,
        ``,
        opener,
        ``,
        `${backgroundSentence}${extraSentence}`,
        ``,
        `My CV is attached. Happy to come in for a quick chat or keep my details on file for future vacancies.`,
        ``,
        `Kind regards,`,
        sigBlock,
        ``,
        popiaOptOut,
      ].join("\n");

      return { subject, body };
    }

    if (channel === "linkedin_connect") {
      const shortCred = creds ? ` (${creds.split(",")[0].trim()})` : "";
      const note = isGatekeeper
        ? `Hi ${first}, I'm applying for ${roleLabel} roles${shortCred} and wanted to connect and share my CV for ${school}'s talent pool.`
        : `Hi ${first}, I'm a ${roleLabel} candidate${shortCred} open to upcoming term or relief roles at ${school}. Would appreciate connecting.`;
      return { subject: "", body: note.slice(0, 295) };
    }

    if (channel === "linkedin_dm") {
      const body = [
        `Hi ${first}, thanks for connecting.`,
        ``,
        `${backgroundSentence}${extraSentence}`,
        ``,
        `Who is best to email my CV to for upcoming ${roleLabel} vacancies or relief cover at ${school}?`,
        ``,
        `Thanks,`,
        senderName,
      ].join("\n");
      return { subject: "", body };
    }

    // 7-day follow-up
    const subject = `Re: ${roleCap} availability at ${school} - ${senderName}`;
    const body = [
      `Hi ${first},`,
      ``,
      `Just bumping my email from last week in case any ${roleLabel} or relief needs came up at ${school}.`,
      ``,
      `I am available for an introductory chat or campus observation day whenever it suits.`,
      ``,
      `Kind regards,`,
      sigBlock,
      ``,
      popiaOptOut,
    ].join("\n");
    return { subject, body };
  }

  // Filter & Sort Rendering
  function populateFilterOptions() {
    const segLeads = LEADS.filter((l) => matchesSegment(l, appState.segment));

    const provinces = [...new Set(segLeads.map((l) => l.province).filter(Boolean))].sort();
    const tiers = [...new Set(segLeads.map((l) => l.decision_tier).filter(Boolean))];
    const insts = [...new Set(segLeads.map((l) => l.institution_type).filter(Boolean))].sort();

    fillSelect($("filterProvince"), "All Provinces", provinces, appState.province);
    fillSelect($("filterTier"), "All Decision Tiers", tiers, appState.tier);
    fillSelect($("filterInstitution"), "All Institution Types", insts, appState.institution);
  }

  function fillSelect(selectEl, defaultLabel, items, currentVal) {
    const existing = currentVal;
    selectEl.innerHTML = `<option value="all">${defaultLabel}</option>`;
    items.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item;
      opt.textContent = item;
      selectEl.appendChild(opt);
    });
    selectEl.value = items.includes(existing) ? existing : "all";
  }

  function applyFilters() {
    const q = appState.search.trim().toLowerCase();
    appState.filteredLeads = LEADS.filter((lead) => {
      if (!matchesSegment(lead, appState.segment)) return false;
      if (appState.province !== "all" && lead.province !== appState.province) return false;
      if (appState.tier !== "all" && lead.decision_tier !== appState.tier) return false;
      if (appState.institution !== "all" && lead.institution_type !== appState.institution) return false;

      const st = getLeadState(lead.id);
      if (appState.status === "starred" && !st.starred) return false;
      if (appState.status !== "all" && appState.status !== "starred" && st.status !== appState.status) return false;

      const hTier = lead.hiring_tier || "Evergreen";
      const rolesCount = (lead.hiring_signals && lead.hiring_signals.open_roles_count) || 0;
      if (appState.hiringFilter === "hot" && hTier !== "Hot Hiring") return false;
      if (appState.hiringFilter === "warm" && hTier !== "Warm Growth") return false;
      if (appState.hiringFilter === "open_roles" && rolesCount === 0) return false;
      if (appState.hiringFilter === "evergreen" && hTier !== "Evergreen") return false;

      if (q) {
        const roleTitles = ((lead.hiring_signals && lead.hiring_signals.open_roles) || []).map((r) => r.title || "");
        const hay = [
          lead.full_name,
          lead.job_title,
          lead.business_name,
          lead.location,
          lead.email,
          lead.institution_type,
          lead.hiring_tier || "",
          ...(lead.school_signals || []),
          ...(lead.skills || []),
          ...roleTitles,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (appState.sortOrder === "hiring_desc") {
      appState.filteredLeads.sort((a, b) => {
        const diff = (b.hiring_intent_score || 0) - (a.hiring_intent_score || 0);
        if (diff !== 0) return diff;
        return a.business_name.localeCompare(b.business_name);
      });
    }

    if (
      appState.filteredLeads.length > 0 &&
      !appState.filteredLeads.some((l) => l.id === appState.activeLeadId)
    ) {
      appState.activeLeadId = appState.filteredLeads[0].id;
    } else if (appState.filteredLeads.length === 0) {
      appState.activeLeadId = null;
    }
  }

  function updateStats() {
    const segLeads = LEADS.filter((l) => matchesSegment(l, appState.segment));
    let cvReady = 0;
    let sent = 0;
    let replies = 0;
    segLeads.forEach((l) => {
      const st = getLeadState(l.id).status;
      if (st === "cv_tailored") cvReady += 1;
      if (st === "email_sent" || st === "linkedin_sent") sent += 1;
      if (st === "replied" || st === "interview") replies += 1;
    });

    $("segCountSchools").textContent = LEADS.filter((l) => l.is_school_decision_maker).length;
    $("segCountEdtech").textContent = LEADS.filter((l) => l.segment === "edtech").length;
    $("segCountAll").textContent = LEADS.length;

    $("statVisible").textContent = appState.filteredLeads.length;
    $("statCvReady").textContent = cvReady;
    $("statSent").textContent = sent;
    $("statReplies").textContent = replies;

    const trackShort = TRACK_LABELS[appState.profile.track] || "Candidate Profile";
    $("profileBtnLabel").textContent = appState.profile.name
      ? `${appState.profile.name.split(" ")[0]} • ${trackShort.split("/")[0].trim()}`
      : `Profile • ${trackShort.split("/")[0].trim()}`;
  }

  function statusBadgeClass(status) {
    if (status === "interview" || status === "replied") return "badge-success";
    if (status === "email_sent" || status === "linkedin_sent" || status === "cv_tailored") return "badge-info";
    return "";
  }

  function renderQueue() {
    const listEl = $("queueList");
    listEl.innerHTML = "";
    $("queueCountLabel").textContent = `Showing ${appState.filteredLeads.length} lead${appState.filteredLeads.length === 1 ? "" : "s"}`;

    if (appState.filteredLeads.length === 0) {
      listEl.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-tertiary); font-size:12.5px;">No leads match your current filters.</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    appState.filteredLeads.forEach((lead) => {
      const st = getLeadState(lead.id);
      const isActive = lead.id === appState.activeLeadId;
      const gap = analyzeCvMatch(lead, appState.profile);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lead-row${isActive ? " active" : ""}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(isActive));

      const statusText = STATUS_LABELS[st.status] || "Ready";
      const starMark = st.starred ? "★ " : "";
      const fitHtml = gap.hasCv
        ? `<span class="badge ${gap.score >= 55 ? "badge-success" : "badge-warning"} tabular">${gap.score}% CV</span>`
        : "";
      const hTier = lead.hiring_tier || "Evergreen";
      const hScore = lead.hiring_intent_score || 10;
      const rolesCnt = (lead.hiring_signals && lead.hiring_signals.open_roles_count) || 0;
      const hiringHtml =
        hTier === "Hot Hiring"
          ? `<span class="badge badge-success tabular">${rolesCnt > 0 ? `${rolesCnt} Role${rolesCnt === 1 ? "" : "s"}` : `Hot ${hScore}`}</span>`
          : hTier === "Warm Growth"
          ? `<span class="badge badge-warning tabular">Warm ${hScore}</span>`
          : "";

      btn.innerHTML = `
        <div class="lead-row-top">
          <div class="lead-identity">
            <div class="avatar">${initialsOf(lead.full_name)}</div>
            <div style="min-width:0;">
              <div class="lead-name">${starMark}${escapeHtml(lead.full_name)}</div>
              <div class="lead-role">${escapeHtml(lead.job_title)}</div>
            </div>
          </div>
          <span class="badge ${statusBadgeClass(st.status)}">${escapeHtml(statusText)}</span>
        </div>
        <div class="lead-row-meta">
          <span class="lead-school">${escapeHtml(lead.business_name)}</span>
          <div style="display:flex; align-items:center; gap:5px; flex-shrink:0;">
            ${hiringHtml}
            ${fitHtml}
            <span>${escapeHtml(lead.province || "SA")}</span>
          </div>
        </div>
      `;

      btn.addEventListener("click", () => {
        appState.activeLeadId = lead.id;
        $("workspaceGrid").classList.add("mobile-detail-open");
        renderQueue();
        renderInspector();
      });

      frag.appendChild(btn);
    });

    listEl.appendChild(frag);
  }

  function renderInspector() {
    const lead = appState.filteredLeads.find((l) => l.id === appState.activeLeadId);
    const railEl = $("contextRail");
    if (!lead) {
      $("inspectorEmpty").classList.remove("hidden");
      $("inspectorLoaded").classList.add("hidden");
      if (railEl) railEl.classList.add("hidden");
      return;
    }

    $("inspectorEmpty").classList.add("hidden");
    $("inspectorLoaded").classList.remove("hidden");
    if (railEl) railEl.classList.remove("hidden");

    const st = getLeadState(lead.id);
    const idx = appState.filteredLeads.findIndex((l) => l.id === lead.id);

    $("detailAvatar").textContent = initialsOf(lead.full_name);
    $("detailName").textContent = lead.full_name;
    $("detailTitle").textContent = `${lead.job_title} — ${lead.business_name}`;
    $("detailTierBadge").textContent = lead.decision_tier;
    $("detailInstBadge").textContent = lead.institution_type;
    $("detailLocation").textContent = lead.location;
    $("detailSize").textContent = lead.employees_range ? `• ${lead.employees_range} staff` : "";
    $("detailPositionLabel").textContent = `Lead ${idx + 1} of ${appState.filteredLeads.length}`;

    $("detailEmail").textContent = lead.email || "No email listed";
    const emailBadge = $("detailEmailStatus");
    emailBadge.textContent = lead.email_status;
    emailBadge.className = `badge ${lead.email_status === "valid" ? "badge-success" : "badge-warning"}`;

    $("detailLinkedinLink").href = lead.linkedin_url || "#";
    $("detailWebsiteLink").href = lead.business_website || "#";
    $("detailDomain").textContent = lead.business_domain || "Website";

    const hs = lead.hiring_signals || {};
    const careersLink = $("detailCareersLink");
    if (hs.careers_url) {
      careersLink.href = hs.careers_url;
      careersLink.classList.remove("hidden");
    } else {
      careersLink.classList.add("hidden");
    }

    const recChip = $("detailRecEmailChip");
    if (hs.public_recruitment_email) {
      $("detailRecEmail").textContent = hs.public_recruitment_email;
      recChip.classList.remove("hidden");
    } else {
      recChip.classList.add("hidden");
    }

    // Hiring Signals Card
    const hTier = lead.hiring_tier || "Evergreen";
    const hScore = lead.hiring_intent_score || 10;
    const sigBadge = $("sigTierBadge");
    sigBadge.textContent = `${hTier} • ${hScore}/100`;
    sigBadge.className = `badge tabular ${
      hTier === "Hot Hiring" ? "badge-success" : hTier === "Warm Growth" ? "badge-warning" : ""
    }`;
    $("sigSourcesLabel").textContent = (hs.sources || []).length ? `Sources: ${hs.sources.join(", ")}` : "";
    $("sigSummaryText").textContent =
      hs.signal_summary || "Click Refresh Signals to scan this institution's live website and vacancies.";

    const flagsCloud = $("sigFlagsCloud");
    flagsCloud.innerHTML = "";
    const allFlags = [
      ...(hs.urgency_flags || []),
      ...(hs.expansion_signals || []),
      ...(hs.leadership_signals || []),
    ];
    if (allFlags.length > 0) {
      allFlags.forEach((flag) => {
        const span = document.createElement("span");
        span.className = "badge badge-info";
        span.textContent = flag;
        flagsCloud.appendChild(span);
      });
      flagsCloud.classList.remove("hidden");
    } else {
      flagsCloud.classList.add("hidden");
    }

    const rolesList = $("sigOpenRolesList");
    rolesList.innerHTML = "";
    const openRoles = Array.isArray(hs.open_roles) ? hs.open_roles : [];
    if (openRoles.length > 0) {
      openRoles.forEach((role) => {
        const row = document.createElement("div");
        row.className = "role-item";
        const metaParts = [role.department_or_phase, role.contract_type, role.closing_date ? `Closes: ${role.closing_date}` : ""]
          .filter(Boolean)
          .join(" • ");
        row.innerHTML = `
          <div>
            <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(role.title)}</div>
            ${metaParts ? `<div style="font-size:11.5px; color:var(--text-secondary);">${escapeHtml(metaParts)}</div>` : ""}
          </div>
          <a href="${escapeHtml(role.apply_url || hs.careers_url || lead.business_website || "#")}" target="_blank" rel="noopener noreferrer" class="btn btn-sm">View Role -></a>
        `;
        rolesList.appendChild(row);
      });
      rolesList.classList.remove("hidden");
    } else {
      rolesList.classList.add("hidden");
    }

    // Star state
    const starBtn = $("btnStarLead");
    const starSvg = $("starIcon");
    if (st.starred) {
      starBtn.classList.add("btn-primary");
      starSvg.setAttribute("fill", "currentColor");
      $("starLabel").textContent = "Starred";
    } else {
      starBtn.classList.remove("btn-primary");
      starSvg.setAttribute("fill", "none");
      $("starLabel").textContent = "Priority";
    }

    // Status pills
    document.querySelectorAll("#statusPills .status-pill").forEach((pill) => {
      pill.classList.toggle("active", pill.dataset.status === st.status);
    });

    // Gatekeeper & POPIA callout
    const gk = $("gatekeeperNotice");
    if (lead.decision_tier === "EA / PA / Admin") {
      gk.textContent = `${lead.first_name} is a ${lead.job_title} (routing gatekeeper). Keep your opener polite, send 1-to-1 (never bulk BCC), and ask for forwarding to the Principal / HOD.`;
      gk.classList.remove("hidden");
    } else {
      gk.classList.add("hidden");
    }

    // Draft composer (Priority: manual edit > Gemini generated > clean deterministic draft)
    $("leadContextInput").value = st.leadContext || "";
    const smartDraft = compileOutreachDraft(lead, appState.activeChannel, appState.profile, st.leadContext || "");
    const savedCustom = st.customDrafts && st.customDrafts[appState.activeChannel];
    const aiDraftMap = st.aiDrafts || null;

    let aiSubject = "";
    let aiBody = "";
    if (aiDraftMap) {
      if (appState.activeChannel === "email") {
        aiSubject = aiDraftMap.email_subject || "";
        aiBody = aiDraftMap.email_body || "";
      } else if (appState.activeChannel === "linkedin_connect") {
        aiBody = aiDraftMap.linkedin_connect || "";
      } else if (appState.activeChannel === "linkedin_dm") {
        aiBody = aiDraftMap.linkedin_dm || "";
      } else if (appState.activeChannel === "followup") {
        aiSubject = aiDraftMap.followup_subject || "";
        aiBody = aiDraftMap.followup_body || "";
      }
    }

    const hasCustom = Boolean(savedCustom && (savedCustom.body !== undefined || savedCustom.subject !== undefined));
    const hasAi = Boolean(aiBody);
    const subjectVal = hasCustom && savedCustom.subject !== undefined
      ? savedCustom.subject
      : hasAi
      ? aiSubject
      : smartDraft.subject;
    const bodyVal = hasCustom && savedCustom.body !== undefined
      ? savedCustom.body
      : hasAi
      ? aiBody
      : smartDraft.body;

    const badge = $("draftSourceBadge");
    if (hasCustom) {
      badge.textContent = "Edited Draft";
      badge.className = "badge badge-info";
    } else if (hasAi) {
      badge.textContent = `Gemini Enhanced (${aiDraftMap.model || "Gemini"})`;
      badge.className = "badge badge-success";
    } else {
      badge.textContent = "Clean Direct Draft";
      badge.className = "badge";
    }

    const showSubject = appState.activeChannel === "email" || appState.activeChannel === "followup";
    $("subjectFieldGroup").classList.toggle("hidden", !showSubject);
    $("draftSubject").value = subjectVal;
    $("draftBody").value = bodyVal;
    updateCharCounter();

    // Update mailto link
    const mailSubject = encodeURIComponent(subjectVal || `Application Inquiry — ${lead.business_name}`);
    const mailBody = encodeURIComponent(bodyVal);
    $("btnMailtoLaunch").href = `mailto:${encodeURIComponent(lead.email)}?subject=${mailSubject}&body=${mailBody}`;

    $("leadNotes").value = st.note || "";

    // CV Compiler Panel
    const cv = compileCvGuidance(lead, appState.profile);
    $("recommendedAttachmentName").textContent = `Attach: ${cv.filename}`;
    $("detailFitPill").textContent = cv.gap.hasCv
      ? `CV Context Match: ${cv.gap.score}%`
      : "Paste CV in Profile for Match %";
    $("detailFitPill").className = `badge tabular ${
      !cv.gap.hasCv ? "badge-info" : cv.gap.score >= 55 ? "badge-success" : "badge-warning"
    }`;

    $("cvLensTier").textContent = lead.decision_tier;
    $("cvLensSummary").textContent = `${cv.lens.scanFocus} ${cv.lens.avoid}`;
    const skillsCloud = $("cvLeadSkillsCloud");
    skillsCloud.innerHTML = "";
    const skillsToShow = lead.skills && lead.skills.length ? lead.skills.slice(0, 12) : ["No public LinkedIn skills listed — lean on Decision Tier lens above"];
    skillsToShow.forEach((sk) => {
      const span = document.createElement("span");
      span.className = "tag-item";
      span.textContent = sk;
      skillsCloud.appendChild(span);
    });

    if ($("railLensTier")) $("railLensTier").textContent = lead.decision_tier;
    if ($("railLensSummary")) $("railLensSummary").textContent = cv.lens.scanFocus;
    const railSkillsCloud = $("railSkillsCloud");
    if (railSkillsCloud) {
      railSkillsCloud.innerHTML = "";
      const railSkills = lead.skills && lead.skills.length ? lead.skills.slice(0, 6) : (lead.school_signals || []).slice(0, 4);
      railSkills.forEach((sk) => {
        const span = document.createElement("span");
        span.className = "tag-item";
        span.textContent = sk;
        railSkillsCloud.appendChild(span);
      });
    }

    $("cvInstType").textContent = lead.institution_type;
    const sigCloud = $("cvSchoolSignals");
    sigCloud.innerHTML = "";
    (lead.school_signals || []).forEach((s) => {
      const span = document.createElement("span");
      span.className = "badge badge-info";
      span.textContent = s;
      sigCloud.appendChild(span);
    });
    $("cvSchoolDescription").textContent =
      lead.business_description || `${lead.business_name} (${lead.institution_type}) in ${lead.location}.`;

    // Gap scanner
    if (!cv.gap.hasCv) {
      $("cvGapScoreBadge").textContent = "Paste CV in Profile to scan";
      $("cvGapScoreBadge").className = "badge badge-info tabular";
      $("cvGapAdvice").textContent =
        "Open Candidate & CV Profile (top right) and paste your CV text to score keyword coverage against this school and decision maker automatically.";
    } else {
      $("cvGapScoreBadge").textContent = `${cv.gap.score}% Context Match (${cv.gap.matched.length}/${cv.gap.matched.length + cv.gap.missing.length})`;
      $("cvGapScoreBadge").className = `badge tabular ${cv.gap.score >= 55 ? "badge-success" : "badge-warning"}`;
      $("cvGapAdvice").textContent =
        cv.gap.missing.length > 0
          ? `Only add missing terms below where genuinely true in your experience—focus on your Page 1 summary and top 3 bullets.`
          : `Strong alignment! Your pasted CV already covers all primary signals for ${lead.business_name}.`;
    }

    const matchedEl = $("cvMatchedTags");
    matchedEl.innerHTML = "";
    if (cv.gap.matched.length === 0) {
      matchedEl.innerHTML = `<span class="tag-item">None detected yet</span>`;
    } else {
      cv.gap.matched.forEach((kw) => {
        const s = document.createElement("span");
        s.className = "tag-item tag-match";
        s.textContent = kw;
        matchedEl.appendChild(s);
      });
    }

    const missingEl = $("cvMissingTags");
    missingEl.innerHTML = "";
    if (cv.gap.missing.length === 0) {
      missingEl.innerHTML = `<span class="tag-item tag-match">All target signals covered</span>`;
    } else {
      cv.gap.missing.forEach((kw) => {
        const s = document.createElement("span");
        s.className = "tag-item tag-miss";
        s.textContent = kw;
        missingEl.appendChild(s);
      });
    }

    $("cvTrackBadge").textContent = cv.trackLabel;
    const dirList = $("cvDirectivesList");
    dirList.innerHTML = "";
    cv.directives.forEach((d) => {
      const li = document.createElement("li");
      li.textContent = d;
      dirList.appendChild(li);
    });

    // Checklist
    const checklistEl = $("cvChecklist");
    checklistEl.innerHTML = "";
    const checksState = st.checklist || {};
    let doneCount = 0;
    cv.checklistItems.forEach((item) => {
      const isDone = Boolean(checksState[item.id]);
      if (isDone) doneCount += 1;
      const lbl = document.createElement("label");
      lbl.className = `check-item${isDone ? " done" : ""}`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isDone;
      cb.addEventListener("change", () => {
        st.checklist = st.checklist || {};
        st.checklist[item.id] = cb.checked;
        const allDone = cv.checklistItems.every((ci) => Boolean(st.checklist[ci.id]));
        if (allDone && st.status === "ready") {
          st.status = "cv_tailored";
        }
        saveStates();
        updateStats();
        renderQueue();
        renderInspector();
      });
      const txt = document.createElement("span");
      txt.textContent = item.text;
      lbl.appendChild(cb);
      lbl.appendChild(txt);
      checklistEl.appendChild(lbl);
    });
    $("cvChecklistProgress").textContent = `${doneCount}/${cv.checklistItems.length}`;
    $("cvFilenameBox").textContent = cv.filename;

    const aiTips = st.aiCvTips || null;
    $("cvSummarySnippet").textContent = (aiTips && aiTips.tailored_summary) || cv.summarySnippet;
    const bulList = $("cvBulletStarters");
    bulList.innerHTML = "";
    const bulletsToRender =
      aiTips && Array.isArray(aiTips.bullet_upgrades) && aiTips.bullet_upgrades.length > 0
        ? aiTips.bullet_upgrades
        : cv.bulletStarters;
    bulletsToRender.forEach((b) => {
      const li = document.createElement("li");
      li.textContent = b;
      bulList.appendChild(li);
    });

    const gapBox = $("cvGeminiGapBox");
    const gapList = $("cvGeminiGapList");
    if (aiTips && Array.isArray(aiTips.gap_actions) && aiTips.gap_actions.length > 0) {
      gapList.innerHTML = "";
      aiTips.gap_actions.forEach((g) => {
        const li = document.createElement("li");
        li.textContent = g;
        gapList.appendChild(li);
      });
      gapBox.classList.remove("hidden");
    } else {
      gapBox.classList.add("hidden");
    }

    renderLinkedinWorkspace(lead, st);
  }

  function resolveChannelDraft(lead, st, channel) {
    const smartDraft = compileOutreachDraft(lead, channel, appState.profile, st.leadContext || "");
    const savedCustom = st.customDrafts && st.customDrafts[channel];
    const aiDraftMap = st.aiDrafts || null;
    let aiBody = "";
    if (aiDraftMap) {
      if (channel === "linkedin_connect") aiBody = aiDraftMap.linkedin_connect || "";
      if (channel === "linkedin_dm") aiBody = aiDraftMap.linkedin_dm || "";
    }
    if (savedCustom && savedCustom.body !== undefined) return savedCustom.body;
    if (aiBody) return aiBody;
    return smartDraft.body;
  }

  function updateLinkedinCharCounters() {
    const connVal = $("liConnectDraft").value || "";
    const connLen = connVal.length;
    const connEl = $("liConnectCharCount");
    connEl.textContent = `${connLen} / 300`;
    connEl.style.color = connLen <= 300 ? "var(--status-success-fg)" : "var(--status-danger-fg)";

    const dmVal = $("liDmDraft").value || "";
    $("liDmCharCount").textContent = `${dmVal.length} chars`;
  }

  function renderLinkedinWorkspace(lead, st) {
    $("liRouteDirectBtn").href = lead.linkedin_url || "#";
    $("liRouteDirectLabel").textContent = `Open ${lead.first_name}'s LinkedIn`;
    const searchQuery = encodeURIComponent(`${lead.full_name} ${lead.business_name}`);
    $("liRouteSearchBtn").href = `https://www.linkedin.com/search/results/all/?keywords=${searchQuery}`;

    const daily = getDailyLinkedinStats();
    const connBadge = $("liDailyConnectBadge");
    connBadge.textContent = `${daily.connects} / 20 Connects Today`;
    connBadge.className = `badge tabular ${daily.connects >= 18 ? "badge-warning" : "badge-info"}`;

    const dmBadge = $("liDailyDmBadge");
    dmBadge.textContent = `${daily.dms} / 15 DMs Today`;
    dmBadge.className = `badge tabular ${daily.dms >= 13 ? "badge-warning" : "badge-info"}`;

    const activeStage = st.linkedinStage || "not_connected";
    document.querySelectorAll("#liStagePills .status-pill").forEach((pill) => {
      pill.classList.toggle("active", pill.dataset.stage === activeStage);
    });

    $("liConnectDraft").value = resolveChannelDraft(lead, st, "linkedin_connect");
    $("liDmDraft").value = resolveChannelDraft(lead, st, "linkedin_dm");
    updateLinkedinCharCounters();

    $("liCareerTierBadge").textContent = lead.decision_tier;
    const expCloud = $("liExperienceCloud");
    expCloud.innerHTML = "";
    const expItems = (lead.experience && lead.experience.length ? lead.experience : [lead.job_title]).slice(0, 8);
    expItems.forEach((role) => {
      const span = document.createElement("span");
      span.className = "tag-item";
      span.textContent = role;
      expCloud.appendChild(span);
    });

    const peers = LEADS.filter((l) => l.business_name === lead.business_name);
    $("liRosterCount").textContent = `${peers.length} contact${peers.length === 1 ? "" : "s"}`;
    const rosterEl = $("liInstitutionRoster");
    rosterEl.innerHTML = "";
    peers.forEach((peer) => {
      const pst = getLeadState(peer.id);
      const isCurrent = peer.id === lead.id;
      const row = document.createElement("div");
      row.className = `li-roster-row${isCurrent ? " current" : ""}`;

      const info = document.createElement("div");
      info.style.minWidth = "0";
      info.innerHTML = `
        <div class="lead-name" style="font-size:12.5px;">${escapeHtml(peer.full_name)}</div>
        <div class="lead-role" style="font-size:11.5px;">${escapeHtml(peer.job_title)}</div>
      `;

      const actions = document.createElement("div");
      actions.className = "topbar-actions";

      const stageBadge = document.createElement("span");
      stageBadge.className = "badge";
      stageBadge.textContent = LINKEDIN_STAGE_LABELS[pst.linkedinStage || "not_connected"] || "Not Connected";
      actions.appendChild(stageBadge);

      if (!isCurrent) {
        const selBtn = document.createElement("button");
        selBtn.type = "button";
        selBtn.className = "btn btn-sm";
        selBtn.textContent = "Switch";
        selBtn.addEventListener("click", () => {
          appState.activeLeadId = peer.id;
          if (!appState.filteredLeads.some((l) => l.id === peer.id)) {
            appState.segment = "all";
            document.querySelectorAll(".segment-btn").forEach((b) => {
              const active = b.dataset.segment === "all";
              b.classList.toggle("active", active);
              b.setAttribute("aria-selected", String(active));
            });
            appState.province = "all";
            appState.tier = "all";
            appState.institution = "all";
            appState.status = "all";
            renderAll();
          } else {
            renderQueue();
            renderInspector();
          }
        });
        actions.appendChild(selBtn);
      }

      const extLink = document.createElement("a");
      extLink.href = peer.linkedin_url || "#";
      extLink.target = "_blank";
      extLink.rel = "noopener noreferrer";
      extLink.className = "btn btn-sm btn-primary";
      extLink.textContent = "LinkedIn ->";
      actions.appendChild(extLink);

      row.appendChild(info);
      row.appendChild(actions);
      rosterEl.appendChild(row);
    });
  }

  function updateCharCounter() {
    const val = $("draftBody").value || "";
    const len = val.length;
    const el = $("charCountLabel");
    if (appState.activeChannel === "linkedin_connect") {
      el.textContent = `${len} / 300 chars (LinkedIn Connect limit)`;
      el.style.color = len <= 300 ? "var(--status-success-fg)" : "var(--status-danger-fg)";
    } else {
      el.textContent = `${len} chars`;
      el.style.color = "var(--text-tertiary)";
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function syncQuickFilterChips() {
    let activeKey = "";
    if (
      appState.hiringFilter === "all" &&
      appState.status === "all" &&
      appState.province === "all" &&
      appState.tier === "all" &&
      appState.institution === "all"
    ) {
      activeKey = "all";
    } else if (appState.hiringFilter === "hot" && appState.status === "all") {
      activeKey = "hot";
    } else if (appState.hiringFilter === "open_roles" && appState.status === "all") {
      activeKey = "open_roles";
    } else if (appState.status === "starred" && appState.hiringFilter === "all") {
      activeKey = "starred";
    } else if (appState.status === "ready" && appState.hiringFilter === "all") {
      activeKey = "ready";
    }
    document.querySelectorAll(".qchip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.qfilter === activeKey);
    });
    const toggleBtn = $("btnToggleFilters");
    if (toggleBtn) {
      const hasAdv =
        appState.province !== "all" ||
        appState.tier !== "all" ||
        appState.institution !== "all" ||
        appState.status !== "all" ||
        appState.hiringFilter !== "all";
      toggleBtn.classList.toggle("btn-primary", hasAdv);
    }
  }

  function renderAll() {
    populateFilterOptions();
    applyFilters();
    syncQuickFilterChips();
    updateStats();
    renderQueue();
    renderInspector();
  }

  // Event Wiring
  function bindEvents() {
    // Segment buttons
    document.querySelectorAll(".segment-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".segment-btn").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        appState.segment = btn.dataset.segment;
        renderAll();
      });
    });

    // Collapsible Advanced Filters Drawer
    const toggleFiltersBtn = $("btnToggleFilters");
    const moreFiltersPanel = $("moreFiltersPanel");
    if (toggleFiltersBtn && moreFiltersPanel) {
      toggleFiltersBtn.addEventListener("click", () => {
        const willShow = moreFiltersPanel.classList.contains("hidden");
        moreFiltersPanel.classList.toggle("hidden", !willShow);
        toggleFiltersBtn.setAttribute("aria-expanded", String(willShow));
      });
    }

    // Quick Filter Chips
    document.querySelectorAll(".qchip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const key = chip.dataset.qfilter;
        appState.hiringFilter = "all";
        appState.status = "all";
        if (key === "all") {
          appState.province = "all";
          appState.tier = "all";
          appState.institution = "all";
          $("filterProvince").value = "all";
          $("filterTier").value = "all";
          $("filterInstitution").value = "all";
        } else if (key === "hot" || key === "open_roles") {
          appState.hiringFilter = key;
        } else if (key === "starred" || key === "ready") {
          appState.status = key;
        }
        $("filterHiring").value = appState.hiringFilter;
        $("filterStatus").value = appState.status;
        applyFilters();
        syncQuickFilterChips();
        updateStats();
        renderQueue();
        renderInspector();
      });
    });

    // Search & Filters
    $("searchInput").addEventListener("input", (e) => {
      appState.search = e.target.value;
      $("btnClearSearch").classList.toggle("hidden", !appState.search);
      applyFilters();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("btnClearSearch").addEventListener("click", () => {
      $("searchInput").value = "";
      appState.search = "";
      $("btnClearSearch").classList.add("hidden");
      applyFilters();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("filterProvince").addEventListener("change", (e) => {
      appState.province = e.target.value;
      applyFilters();
      syncQuickFilterChips();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("filterTier").addEventListener("change", (e) => {
      appState.tier = e.target.value;
      applyFilters();
      syncQuickFilterChips();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("filterInstitution").addEventListener("change", (e) => {
      appState.institution = e.target.value;
      applyFilters();
      syncQuickFilterChips();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("filterStatus").addEventListener("change", (e) => {
      appState.status = e.target.value;
      applyFilters();
      syncQuickFilterChips();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("filterHiring").addEventListener("change", (e) => {
      appState.hiringFilter = e.target.value;
      applyFilters();
      syncQuickFilterChips();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("sortOrder").addEventListener("change", (e) => {
      appState.sortOrder = e.target.value;
      applyFilters();
      updateStats();
      renderQueue();
      renderInspector();
    });

    $("listSelector").addEventListener("change", (e) => {
      loadLeadList(e.target.value);
    });

    $("btnEmptyResetFilters").addEventListener("click", () => {
      appState.search = "";
      $("searchInput").value = "";
      $("btnClearSearch").classList.add("hidden");
      appState.province = "all";
      appState.tier = "all";
      appState.institution = "all";
      appState.status = "all";
      appState.hiringFilter = "all";
      $("filterStatus").value = "all";
      $("filterHiring").value = "all";
      renderAll();
    });

    // Workspace Tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        appState.activeTab = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach((b) => {
          const active = b.dataset.tab === appState.activeTab;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        $("panelDispatch").classList.toggle("hidden", appState.activeTab !== "dispatch");
        $("panelLinkedin").classList.toggle("hidden", appState.activeTab !== "linkedin");
        $("panelCv").classList.toggle("hidden", appState.activeTab !== "cv");
      });
    });

    // LinkedIn Workspace Controls
    document.querySelectorAll("#liStagePills .status-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        if (!appState.activeLeadId) return;
        const st = getLeadState(appState.activeLeadId);
        st.linkedinStage = pill.dataset.stage;
        if (st.linkedinStage === "connect_sent" || st.linkedinStage === "dm_sent") {
          if (st.status === "ready" || st.status === "cv_tailored") st.status = "linkedin_sent";
        } else if (st.linkedinStage === "replied") {
          st.status = "replied";
        }
        saveStates();
        updateStats();
        renderQueue();
        renderInspector();
      });
    });

    $("btnNextPendingLinkedin").addEventListener("click", () => {
      const pool = appState.filteredLeads;
      if (pool.length === 0) return;
      const curIdx = pool.findIndex((l) => l.id === appState.activeLeadId);
      for (let offset = 1; offset <= pool.length; offset += 1) {
        const candidate = pool[(curIdx + offset) % pool.length];
        const cst = getLeadState(candidate.id);
        if ((cst.linkedinStage || "not_connected") === "not_connected") {
          appState.activeLeadId = candidate.id;
          renderQueue();
          renderInspector();
          const row = $("queueList").querySelector(".lead-row.active");
          if (row) row.scrollIntoView({ block: "nearest" });
          showToast(`Routed to ${candidate.full_name}`);
          return;
        }
      }
      showToast("All leads in current view have LinkedIn activity logged");
    });

    $("btnLiGeminiRefresh").addEventListener("click", () => {
      runGeminiOutreachGeneration($("btnLiGeminiRefresh"), $("btnLiGeminiLabel"), "Enhance LinkedIn Copy (Gemini)");
    });

    $("liConnectDraft").addEventListener("input", () => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      st.customDrafts = st.customDrafts || {};
      st.customDrafts.linkedin_connect = { body: $("liConnectDraft").value };
      saveStates();
      updateLinkedinCharCounters();
    });

    $("liDmDraft").addEventListener("input", () => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      st.customDrafts = st.customDrafts || {};
      st.customDrafts.linkedin_dm = { body: $("liDmDraft").value };
      saveStates();
      updateLinkedinCharCounters();
    });

    $("btnLiCopyConnect").addEventListener("click", () => {
      copyText($("liConnectDraft").value, "LinkedIn connection note copied");
    });

    $("btnLiDispatchConnect").addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      copyText($("liConnectDraft").value, `Copied note & opened ${lead.first_name}'s LinkedIn`);
      const st = getLeadState(lead.id);
      if ((st.linkedinStage || "not_connected") === "not_connected") {
        st.linkedinStage = "connect_sent";
        bumpDailyLinkedinStat("connects");
      }
      if (st.status === "ready" || st.status === "cv_tailored") {
        st.status = "linkedin_sent";
      }
      saveStates();
      updateStats();
      renderQueue();
      renderInspector();
      if (lead.linkedin_url) window.open(lead.linkedin_url, "_blank", "noopener,noreferrer");
    });

    $("btnLiCopyDm").addEventListener("click", () => {
      copyText($("liDmDraft").value, "LinkedIn DM copied");
    });

    $("btnLiDispatchDm").addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      copyText($("liDmDraft").value, `Copied DM & opened ${lead.first_name}'s LinkedIn`);
      const st = getLeadState(lead.id);
      if (st.linkedinStage !== "dm_sent" && st.linkedinStage !== "replied") {
        st.linkedinStage = "dm_sent";
        bumpDailyLinkedinStat("dms");
      }
      if (st.status === "ready" || st.status === "cv_tailored") {
        st.status = "linkedin_sent";
      }
      saveStates();
      updateStats();
      renderQueue();
      renderInspector();
      if (lead.linkedin_url) window.open(lead.linkedin_url, "_blank", "noopener,noreferrer");
    });

    // Channel Switcher
    document.querySelectorAll(".channel-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        appState.activeChannel = btn.dataset.channel;
        document.querySelectorAll(".channel-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.channel === appState.activeChannel);
        });
        renderInspector();
      });
    });

    // Status pills
    document.querySelectorAll("#statusPills .status-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        if (!appState.activeLeadId) return;
        const st = getLeadState(appState.activeLeadId);
        st.status = pill.dataset.status;
        saveStates();
        updateStats();
        renderQueue();
        renderInspector();
      });
    });

    // Star & Prev/Next
    $("btnStarLead").addEventListener("click", () => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      st.starred = !st.starred;
      saveStates();
      renderQueue();
      renderInspector();
    });

    $("btnPrevLead").addEventListener("click", () => stepLead(-1));
    $("btnNextLead").addEventListener("click", () => stepLead(1));

    $("btnMobileBack").addEventListener("click", () => {
      $("workspaceGrid").classList.remove("mobile-detail-open");
    });

    // Keyboard shortcuts & Escape handling
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if ($("profileDrawer") && !$("profileDrawer").classList.contains("hidden")) {
          $("profileDrawer").classList.add("hidden");
          return;
        }
        if ($("csvImportDrawer") && !$("csvImportDrawer").classList.contains("hidden")) {
          $("csvImportDrawer").classList.add("hidden");
          return;
        }
        if ($("moreFiltersPanel") && !$("moreFiltersPanel").classList.contains("hidden")) {
          $("moreFiltersPanel").classList.add("hidden");
          if ($("btnToggleFilters")) $("btnToggleFilters").setAttribute("aria-expanded", "false");
          return;
        }
      }

      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/") {
        e.preventDefault();
        $("searchInput").focus();
        $("searchInput").select();
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        stepLead(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        stepLead(-1);
      } else if (e.key === "1") {
        $("tabBtnDispatch").click();
      } else if (e.key === "2") {
        $("tabBtnLinkedin").click();
      } else if (e.key === "3") {
        $("tabBtnCv").click();
      }
    });

    // Draft edits persisted per lead+channel
    const saveDraftEdit = () => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      st.customDrafts = st.customDrafts || {};
      st.customDrafts[appState.activeChannel] = {
        subject: $("draftSubject").value,
        body: $("draftBody").value,
      };
      saveStates();
      updateCharCounter();
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (lead) {
        const mailSubject = encodeURIComponent($("draftSubject").value || `Application Inquiry — ${lead.business_name}`);
        const mailBody = encodeURIComponent($("draftBody").value);
        $("btnMailtoLaunch").href = `mailto:${encodeURIComponent(lead.email)}?subject=${mailSubject}&body=${mailBody}`;
      }
    };

    $("draftSubject").addEventListener("input", saveDraftEdit);
    $("draftBody").addEventListener("input", saveDraftEdit);

    $("btnResetDraft").addEventListener("click", () => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      if (st.customDrafts) delete st.customDrafts[appState.activeChannel];
      st.aiDrafts = null;
      saveStates();
      renderInspector();
      showToast("Reset to clean direct draft");
    });

    $("leadContextInput").addEventListener("input", (e) => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      st.leadContext = e.target.value;
      saveStates();
    });

    $("leadNotes").addEventListener("input", (e) => {
      if (!appState.activeLeadId) return;
      const st = getLeadState(appState.activeLeadId);
      st.note = e.target.value;
      saveStates();
    });

    async function runGeminiOutreachGeneration(btn, lbl, idleLabel) {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      if (window.location.protocol === "file:") {
        showToast("Start local server (python3 server.py 3005) to use Gemini API");
        return;
      }

      btn.disabled = true;
      lbl.textContent = "Generating...";
      const st = getLeadState(lead.id);

      try {
        const res = await fetch("/api/generate-outreach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lead,
            profile: appState.profile,
            lead_context: st.leadContext || "",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Gemini generation failed");
        }
        st.aiDrafts = { ...data.drafts, model: data.model };
        st.customDrafts = {};
        saveStates();
        renderInspector();
        showToast(`Enhanced all 4 channels via ${data.model}`);
      } catch (err) {
        showToast(`Gemini error: ${err.message}`);
      } finally {
        btn.disabled = false;
        lbl.textContent = idleLabel;
      }
    }

    $("btnGeminiDraft").addEventListener("click", () => {
      runGeminiOutreachGeneration($("btnGeminiDraft"), $("btnGeminiDraftLabel"), "Enhance All 4 Channels (Gemini)");
    });

    $("btnGeminiCvTips").addEventListener("click", async () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      if (window.location.protocol === "file:") {
        showToast("Start local server (python3 server.py 3005) to use Gemini API");
        return;
      }

      const btn = $("btnGeminiCvTips");
      const lbl = $("btnGeminiCvLabel");
      btn.disabled = true;
      lbl.textContent = "Tailoring...";
      const st = getLeadState(lead.id);

      try {
        const res = await fetch("/api/generate-cv-tips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lead,
            profile: appState.profile,
            lead_context: st.leadContext || "",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Gemini CV tailoring failed");
        }
        st.aiCvTips = { ...data.tips, model: data.model };
        saveStates();
        renderInspector();
        showToast(`CV tips tailored via ${data.model}`);
      } catch (err) {
        showToast(`Gemini error: ${err.message}`);
      } finally {
        btn.disabled = false;
        lbl.textContent = "Tailor with Gemini";
      }
    });

    // Copy Actions
    $("btnCopyEmail").addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (lead && lead.email) copyText(lead.email, `Copied ${lead.email}`);
    });

    $("btnCopySubject").addEventListener("click", () => {
      copyText($("draftSubject").value, "Email subject copied");
    });

    $("btnCopyMessage").addEventListener("click", () => {
      const text = $("draftBody").value;
      copyText(text, "Message copied & lead marked dispatched");
      if (appState.activeLeadId) {
        const st = getLeadState(appState.activeLeadId);
        if (st.status === "ready" || st.status === "cv_tailored") {
          st.status = appState.activeChannel.startsWith("linkedin") ? "linkedin_sent" : "email_sent";
          saveStates();
          updateStats();
          renderQueue();
          renderInspector();
        }
      }
    });

    $("btnCopyCvSummary").addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      const st = getLeadState(lead.id);
      const cv = compileCvGuidance(lead, appState.profile);
      const summary = (st.aiCvTips && st.aiCvTips.tailored_summary) || cv.summarySnippet;
      const bullets =
        st.aiCvTips && Array.isArray(st.aiCvTips.bullet_upgrades) && st.aiCvTips.bullet_upgrades.length > 0
          ? st.aiCvTips.bullet_upgrades
          : cv.bulletStarters;
      const bundle = [
        `TAILORED CV SUMMARY (${lead.business_name}):`,
        summary,
        ``,
        `SUGGESTED BULLET STARTERS:`,
        ...bullets.map((b) => `• ${b}`),
      ].join("\n");
      copyText(bundle, "Tailored CV summary & bullets copied");
    });

    $("btnCopyAiPrompt").addEventListener("click", () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      const cv = compileCvGuidance(lead, appState.profile);
      copyText(cv.aiPrompt, `AI CV-tailor prompt copied for ${lead.business_name}`);
    });

    // Profile Drawer & CV Upload
    const openDrawer = () => {
      $("profName").value = appState.profile.name || "";
      $("profEmail").value = appState.profile.email || "";
      $("profPhone").value = appState.profile.phone || "";
      $("profLinkedin").value = appState.profile.linkedin || "";
      $("profTrack").value = appState.profile.track || "educator";
      $("profCredentials").value = appState.profile.credentials || "";
      $("profAdditionalContext").value = appState.profile.additionalContext || "";
      $("profCvText").value = appState.profile.cvText || "";
      $("cvUploadStatus").textContent = appState.profile.cvFileName
        ? `Loaded CV: ${appState.profile.cvFileName} (${(appState.profile.pitchFacts || []).length} facts extracted)`
        : "No file uploaded yet — drop a file here or click Choose CV File.";
      $("profileDrawer").classList.remove("hidden");
    };
    const closeDrawer = () => $("profileDrawer").classList.add("hidden");

    async function handleCvFileUpload(file) {
      if (!file) return;
      if (window.location.protocol === "file:") {
        showToast("Open via http://127.0.0.1:3005 to parse PDF/DOCX CVs with Gemini");
        return;
      }

      $("cvUploadBtnLabel").textContent = "Parsing...";
      $("cvUploadStatus").textContent = `Uploading & parsing ${file.name} with Gemini...`;

      try {
        const base64Data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || "");
            const idx = result.indexOf(",");
            resolve(idx >= 0 ? result.slice(idx + 1) : result);
          };
          reader.onerror = () => reject(new Error("Failed to read file"));
          reader.readAsDataURL(file);
        });

        const res = await fetch("/api/parse-cv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mime_type: file.type || "",
            base64_data: base64Data,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "CV parse failed");
        }

        const parsed = data.parsed || {};
        if (parsed.name && !$("profName").value.trim()) $("profName").value = parsed.name;
        if (parsed.email && !$("profEmail").value.trim()) $("profEmail").value = parsed.email;
        if (parsed.phone && !$("profPhone").value.trim()) $("profPhone").value = parsed.phone;
        if (parsed.linkedin && !$("profLinkedin").value.trim()) $("profLinkedin").value = parsed.linkedin;
        if (parsed.suggested_track && TRACK_LABELS[parsed.suggested_track]) {
          $("profTrack").value = parsed.suggested_track;
        }
        if (parsed.credentials_summary) $("profCredentials").value = parsed.credentials_summary;
        if (parsed.cv_text) $("profCvText").value = parsed.cv_text;

        appState.profile.cvFileName = file.name;
        appState.profile.pitchFacts = Array.isArray(parsed.candidate_pitch_facts) ? parsed.candidate_pitch_facts : [];
        $("cvUploadStatus").textContent = `Parsed ${file.name} via ${data.model} (${appState.profile.pitchFacts.length} proof points extracted). Click Save & Apply Profile.`;
        showToast(`Parsed ${file.name} via Gemini`);
      } catch (err) {
        $("cvUploadStatus").textContent = `Parse error: ${err.message}`;
        showToast(`CV parse error: ${err.message}`);
      } finally {
        $("cvUploadBtnLabel").textContent = "Choose CV File";
        $("cvFileInput").value = "";
      }
    }

    $("cvFileInput").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleCvFileUpload(f);
    });

    const uploadZone = $("cvUploadZone");
    uploadZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      uploadZone.classList.add("dragover");
    });
    uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("dragover"));
    uploadZone.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadZone.classList.remove("dragover");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleCvFileUpload(f);
    });

    $("btnQuickUploadLink").addEventListener("click", openDrawer);
    $("btnOpenProfile").addEventListener("click", openDrawer);
    $("btnCloseProfile").addEventListener("click", closeDrawer);
    $("btnCancelProfile").addEventListener("click", closeDrawer);
    $("profileDrawer").addEventListener("click", (e) => {
      if (e.target === $("profileDrawer")) closeDrawer();
    });

    $("btnSaveProfile").addEventListener("click", () => {
      appState.profile = {
        ...appState.profile,
        name: $("profName").value.trim() || "Siphosihle Mashinini",
        email: $("profEmail").value.trim(),
        phone: $("profPhone").value.trim(),
        linkedin: $("profLinkedin").value.trim(),
        track: $("profTrack").value,
        credentials: $("profCredentials").value.trim(),
        additionalContext: $("profAdditionalContext").value.trim(),
        cvText: $("profCvText").value.trim(),
      };
      localStorage.setItem(STORAGE_KEYS.PROFILE, JSON.stringify(appState.profile));
      saveProfileToServer();
      closeDrawer();
      updateStats();
      renderQueue();
      renderInspector();
      showToast("Candidate & CV profile saved");
    });

    // Export CSV
    $("btnExportCsv").addEventListener("click", exportCsv);

    // Copy Public Recruitment Email & Live Refresh Hiring Signals
    $("btnCopyRecEmail").addEventListener("click", () => {
      const em = $("detailRecEmail").textContent;
      if (em) copyText(em, `Copied ${em}`);
    });

    $("btnRefreshSignals").addEventListener("click", async () => {
      const lead = LEADS.find((l) => l.id === appState.activeLeadId);
      if (!lead) return;
      if (window.location.protocol === "file:") {
        showToast("Open via http://127.0.0.1:3005 to refresh live hiring signals");
        return;
      }
      const btn = $("btnRefreshSignals");
      const lbl = $("btnRefreshSignalsLabel");
      btn.disabled = true;
      lbl.textContent = "Scanning...";
      try {
        const res = await fetch("/api/enrich-institution", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lead, list_id: appState.activeListId }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Signal refresh failed");
        }
        const updated = data.lead;
        LEADS.forEach((l) => {
          if (l.business_domain === updated.business_domain) {
            l.hiring_signals = updated.hiring_signals;
            l.hiring_intent_score = updated.hiring_intent_score;
            l.hiring_tier = updated.hiring_tier;
          }
        });
        applyFilters();
        renderQueue();
        renderInspector();
        showToast(`Signals updated (${updated.hiring_tier} • ${updated.hiring_intent_score}/100)`);
      } catch (err) {
        showToast(`Refresh error: ${err.message}`);
      } finally {
        btn.disabled = false;
        lbl.textContent = "Refresh Signals";
      }
    });

    // Import & Enrich New CSV Drawer
    const openCsvDrawer = () => $("csvImportDrawer").classList.remove("hidden");
    const closeCsvDrawer = () => $("csvImportDrawer").classList.add("hidden");

    $("btnOpenImportCsv").addEventListener("click", openCsvDrawer);
    $("btnCloseCsvDrawer").addEventListener("click", closeCsvDrawer);
    $("btnDoneCsvDrawer").addEventListener("click", closeCsvDrawer);
    $("csvImportDrawer").addEventListener("click", (e) => {
      if (e.target === $("csvImportDrawer")) closeCsvDrawer();
    });

    async function handleCsvImport(file) {
      if (!file) return;
      if (window.location.protocol === "file:") {
        showToast("Open via http://127.0.0.1:3005 to import & enrich CSVs");
        return;
      }
      $("csvImportBtnLabel").textContent = "Importing...";
      $("csvImportStatus").textContent = `Filtering ${file.name} for POPIA compliance & enriching institutions...`;
      $("csvImportSummaryBox").classList.add("hidden");

      try {
        const csvText = await file.text();
        const enrichSignals = Boolean($("csvRunEnrichment").checked);
        const res = await fetch("/api/ingest-csv", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            csv_text: csvText,
            enrich_signals: enrichSignals,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "CSV import failed");
        }
        LEADS = data.leads || [];
        appState.activeListId = data.list.id;
        appState.availableLists = [data.list, ...appState.availableLists.filter((l) => l.id !== data.list.id)];
        appState.activeLeadId = null;
        renderListSelector();
        renderAll();

        const s = data.stats;
        $("csvImportStatus").textContent = `Imported ${s.kept_popi_safe} POPI-safe contacts (${s.hot_hiring_count} Hot Hiring).`;
        $("csvImportSummaryText").textContent = `Processed ${s.total_rows} rows -> kept ${s.kept_popi_safe} POPI-safe institutional contacts, excluded ${s.excluded_count} unverified/personal/mismatched rows. Active list switched to "${data.list.name}".`;
        $("csvImportSummaryBox").classList.remove("hidden");
        showToast(`Imported ${s.kept_popi_safe} POPI-safe leads`);
      } catch (err) {
        $("csvImportStatus").textContent = `Import error: ${err.message}`;
        showToast(`Import error: ${err.message}`);
      } finally {
        $("csvImportBtnLabel").textContent = "Choose CSV";
        $("csvFileInput").value = "";
      }
    }

    $("csvFileInput").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleCsvImport(f);
    });

    const csvDropZone = $("csvDropZone");
    csvDropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      csvDropZone.classList.add("dragover");
    });
    csvDropZone.addEventListener("dragleave", () => csvDropZone.classList.remove("dragover"));
    csvDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      csvDropZone.classList.remove("dragover");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleCsvImport(f);
    });

    // Theme Toggle
    $("btnThemeToggle").addEventListener("click", () => {
      const isDark = document.documentElement.getAttribute("data-theme") === "dark";
      const next = isDark ? "light" : "dark";
      setTheme(next);
    });

    // Reset All
    $("btnResetAll").addEventListener("click", () => {
      if (!confirm("Reset all outreach statuses, stars, checklists, and lead notes? Your Candidate Profile will be kept.")) {
        return;
      }
      appState.leadStates = {};
      saveStates();
      updateStats();
      renderQueue();
      renderInspector();
      showToast("Outreach tracking reset");
    });
  }

  function stepLead(delta) {
    if (appState.filteredLeads.length === 0) return;
    const idx = appState.filteredLeads.findIndex((l) => l.id === appState.activeLeadId);
    const nextIdx = idx === -1 ? 0 : (idx + delta + appState.filteredLeads.length) % appState.filteredLeads.length;
    appState.activeLeadId = appState.filteredLeads[nextIdx].id;
    renderQueue();
    renderInspector();
    const activeRow = $("queueList").querySelector(".lead-row.active");
    if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
  }

  function exportCsv() {
    const headers = [
      "Full Name",
      "Job Title",
      "Decision Tier",
      "Institution",
      "Institution Type",
      "Province",
      "City",
      "Email",
      "Email Status",
      "LinkedIn URL",
      "Website",
      "Outreach Status",
      "Priority Starred",
      "Notes",
    ];

    const csvEscape = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
    const rows = [headers.join(",")];

    appState.filteredLeads.forEach((l) => {
      const st = getLeadState(l.id);
      rows.push(
        [
          l.full_name,
          l.job_title,
          l.decision_tier,
          l.business_name,
          l.institution_type,
          l.province,
          l.city,
          l.email,
          l.email_status,
          l.linkedin_url,
          l.business_website,
          STATUS_LABELS[st.status] || st.status,
          st.starred ? "Yes" : "No",
          st.note || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `school_outreach_dispatch_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${appState.filteredLeads.length} leads to CSV`);
  }

  function setTheme(theme) {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
      $("themeIconSun").classList.remove("hidden");
      $("themeIconMoon").classList.add("hidden");
    } else {
      document.documentElement.removeAttribute("data-theme");
      $("themeIconSun").classList.add("hidden");
      $("themeIconMoon").classList.remove("hidden");
    }
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  }

  // Init
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || "light";
  setTheme(savedTheme);
  bindEvents();
  renderAll();
  hydrateStatesFromServer();
})();
