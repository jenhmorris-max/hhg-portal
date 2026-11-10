/* HHG Client Portal — front end (vanilla JS + Supabase) */
(() => {
  "use strict";
  const CFG = window.PORTAL_CONFIG || {};
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.getElementById("app").innerHTML =
      `<div class="auth-wrap"><div class="auth-card"><h2>Portal not configured</h2>
       <p class="muted">Open <code>config.js</code> and paste your Supabase project URL and anon key.</p></div></div>`;
    return;
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  const BUCKET = "org-files";

  // ------------------------------------------------------------ state
  const S = {
    session: null, profile: null,
    orgs: [],            // [{id,name,slug,logo_path,accent,role}]
    org: null,           // current org
    role: null,          // 'super' | 'admin' | 'member'
    logoUrl: null,
    recovery: false,
    viewAs: null,        // super admin previewing as 'admin' | 'member' | null
  };
  const EMP_STATUS = { onboarding: "Onboarding", active: "Active", leave: "On leave", terminated: "Terminated" };
  const TASK_STATUS = { pending: "Pending", in_progress: "In progress", complete: "Complete", na: "N/A" };
  const CATS = {
    handbook: "Handbook", policy: "Policies", job_description: "Job descriptions",
    benefits: "Benefits", form: "Forms", hiring_process: "Hiring process", other: "Other",
  };
  const STAGES = ["applied", "screening", "interview", "offer", "hired", "passed"];
  const STAGE_LABEL = { applied: "Applied", screening: "Screening", interview: "Interview", offer: "Offer", hired: "Hired", passed: "Passed" };
  const JOB_STATUS = { open: "Open", on_hold: "On hold", filled: "Filled", closed: "Closed" };

  // ------------------------------------------------------------ utils
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $("#app");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const fmtDT = (d) => d ? new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const fmtSize = (b) => !b ? "" : b < 1e6 ? Math.round(b / 1e3) + " KB" : (b / 1e6).toFixed(1) + " MB";
  const initials = (n) => (n || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const ext = (name) => (name.split(".").pop() || "").toUpperCase().slice(0, 4);
  const safeName = (n) => n.replace(/[^\w.\-]+/g, "_");
  const effRole = () => (S.role === "super" && S.viewAs) ? S.viewAs : (S.role === "admin" ? "owner" : S.role === "member" ? "employee" : S.role);
  const isAdmin = () => ["super", "owner"].includes(effRole());           // owner-level: users, company settings
  const isStaff = () => ["super", "owner", "staff"].includes(effRole());  // HR data: employees, hiring, tasks, all documents
  const isSuper = () => effRole() === "super";
  const isRealSuper = () => S.role === "super";
  const ROLE = {
    super:    { label: "JHM admin",  short: "JHM",      blurb: "Your HR consultant. Sees and manages every client workspace, replies to requests, and switches modules on or off." },
    owner:    { label: "Owner",      short: "Owner",    blurb: "The company's owner or administrator. Full workspace: documents, employees, hiring, tasks. Invites users and sets company branding." },
    staff:    { label: "Staff",      short: "Staff",    blurb: "Chosen staff with HR access. Works in employees, hiring, tasks and all documents. Cannot manage users or settings." },
    employee: { label: "Employee",   short: "Employee", blurb: "Self-service. Sees their own profile, shared documents like the handbook and benefits, and can ask JHM a question." },
  };
  const mods = () => Object.assign({ documents: true, employees: true, hiring: true, tasks: true, requests: true }, S.org?.modules || {});

  let toastT;
  function toast(msg, err = false) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), err ? 5000 : 2600);
  }
  function fail(e) { console.error(e); toast(e?.message || String(e), true); }
  window.addEventListener("unhandledrejection", (ev) => fail(ev.reason || "Unexpected error"));
  window.addEventListener("error", (ev) => { if (ev.message) toast(ev.message, true); });

  function modal(html, { wide = false } = {}) {
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-bg"><div class="modal${wide ? " wide" : ""}">${html}</div></div>`;
    const close = () => (root.innerHTML = "");
    root.querySelector(".modal-bg").addEventListener("click", (e) => { if (e.target.classList.contains("modal-bg")) close(); });
    root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
    return { el: root.querySelector(".modal"), close };
  }
  function confirmBox(title, body, okLabel = "Delete") {
    return new Promise((res) => {
      const m = modal(`<div class="modal-head"><h3>${esc(title)}</h3><button class="x" data-close>×</button></div>
        <p class="muted">${esc(body)}</p>
        <div class="modal-foot"><button class="btn quiet" data-close>Cancel</button><button class="btn danger" id="ok">${esc(okLabel)}</button></div>`);
      m.el.querySelector("#ok").onclick = () => { m.close(); res(true); };
      m.el.querySelector("[data-close]").addEventListener("click", () => res(false));
    });
  }
  async function busy(btn, fn) {
    const old = btn.textContent; btn.disabled = true; btn.textContent = "Working…";
    try { await fn(); } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = old; }
  }
  async function log(entity_type, entity_id, action, detail = null) {
    if (!S.org) return;
    await sb.from("activity_log").insert({ org_id: S.org.id, actor_id: S.session.user.id, entity_type, entity_id, action, detail });
  }
  async function signedUrl(path, seconds = 120) {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, seconds);
    if (error) throw error; return data.signedUrl;
  }
  async function openFile(path, download = false) {
    try {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 120, download ? { download: true } : undefined);
      if (error) throw error;
      window.open(data.signedUrl, "_blank", "noopener");
    } catch (e) { fail(e); }
  }
  async function uploadFile(file, area) {
    const path = `${S.org.id}/${area}/${crypto.randomUUID()}-${safeName(file.name)}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) throw error;
    return path;
  }

  // ------------------------------------------------------------ auth screens
  function renderAuth(mode = "signin", msg = "") {
    const brand = `<div class="auth-brand"><div class="boot-mark">HH</div><div><b>${esc(CFG.PORTAL_NAME)}</b><small>The Hope Harvest Group · JHM Consulting</small></div></div>`;
    let body = "";
    if (mode === "signin") body = `
      <h2>Sign in</h2>
      <form id="f"><label>Email</label><input type="email" name="email" required autocomplete="username" />
      <label>Password</label><input type="password" name="password" required autocomplete="current-password" />
      <button class="btn block">Sign in</button></form>
      <div class="auth-links"><a href="#" data-mode="forgot">Forgot password?</a><a href="#" data-mode="signup">Create account</a></div>`;
    if (mode === "signup") body = `
      <h2>Create your account</h2>
      <p class="muted small">Use the email address your HR consultant invited. Access is granted automatically once you confirm it.</p>
      <form id="f"><label>Full name</label><input type="text" name="full_name" required autocomplete="name" />
      <label>Email</label><input type="email" name="email" required autocomplete="username" />
      <label>Password <span class="muted">(10+ characters)</span></label><input type="password" name="password" minlength="10" required autocomplete="new-password" />
      <button class="btn block">Create account</button></form>
      <div class="auth-links"><a href="#" data-mode="signin">Back to sign in</a></div>`;
    if (mode === "forgot") body = `
      <h2>Reset password</h2>
      <form id="f"><label>Email</label><input type="email" name="email" required />
      <button class="btn block">Send reset link</button></form>
      <div class="auth-links"><a href="#" data-mode="signin">Back to sign in</a></div>`;
    if (mode === "recovery") body = `
      <h2>Choose a new password</h2>
      <form id="f"><label>New password</label><input type="password" name="password" minlength="10" required autocomplete="new-password" />
      <button class="btn block">Update password</button></form>`;
    app.innerHTML = `<div class="auth-wrap"><div class="auth-card">${brand}${body}<div id="msg">${msg}</div></div></div>`;

    app.querySelectorAll("[data-mode]").forEach((a) => a.onclick = (e) => { e.preventDefault(); renderAuth(a.dataset.mode); });
    const f = $("#f"), msgEl = $("#msg");
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      const btn = f.querySelector("button");
      const old = btn.textContent; btn.disabled = true; btn.textContent = "Working…";
      msgEl.innerHTML = "";
      try {
        if (mode === "signin") {
          const { error } = await sb.auth.signInWithPassword({ email: d.email.trim(), password: d.password });
          if (error) throw error;
        } else if (mode === "signup") {
          const { data, error } = await sb.auth.signUp({ email: d.email.trim(), password: d.password,
            options: { data: { full_name: d.full_name.trim() }, emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) msgEl.innerHTML = `<div class="notice">Check your email to confirm your account, then sign in.</div>`;
        } else if (mode === "forgot") {
          const { error } = await sb.auth.resetPasswordForEmail(d.email.trim(), { redirectTo: location.origin + location.pathname });
          if (error) throw error;
          msgEl.innerHTML = `<div class="notice">If that address has an account, a reset link is on its way.</div>`;
        } else if (mode === "recovery") {
          const { error } = await sb.auth.updateUser({ password: d.password });
          if (error) throw error;
          S.recovery = false; toast("Password updated"); await boot();
        }
      } catch (err) {
        msgEl.innerHTML = `<div class="error">${esc(err.message || "Something went wrong")}</div>`;
      } finally { btn.disabled = false; btn.textContent = old; }
    };
  }

  // ------------------------------------------------------------ load context
  async function loadContext() {
    const uid = S.session.user.id;
    const { data: prof, error } = await sb.from("profiles").select("*").eq("id", uid).single();
    if (error) throw error;
    S.profile = prof;
    let orgs = [];
    if (prof.is_super_admin) {
      const { data } = await sb.from("organizations").select("*").order("name");
      orgs = (data || []).map((o) => ({ ...o, role: "super" }));
    } else {
      const { data } = await sb.from("memberships").select("role, organizations(*)").eq("user_id", uid);
      orgs = (data || []).filter((m) => m.organizations).map((m) => ({ ...m.organizations, role: m.role }));
      orgs.sort((a, b) => a.name.localeCompare(b.name));
    }
    S.orgs = orgs;
    let saved = null; try { saved = localStorage.getItem("hhg.org"); } catch {}
    S.org = orgs.find((o) => o.id === saved) || orgs[0] || null;
    S.role = S.org ? S.org.role : (prof.is_super_admin ? "super" : null);
    S.logoUrl = null;
    if (S.org?.logo_path) { try { S.logoUrl = await signedUrl(S.org.logo_path, 3600); } catch {} }
  }
  async function switchOrg(id) {
    S.org = S.orgs.find((o) => o.id === id) || null;
    S.role = S.org ? S.org.role : (S.profile.is_super_admin ? "super" : null);
    try { localStorage.setItem("hhg.org", id); } catch {}
    S.logoUrl = null;
    if (S.org?.logo_path) { try { S.logoUrl = await signedUrl(S.org.logo_path, 3600); } catch {} }
    location.hash = "#home"; render();
  }

  // ------------------------------------------------------------ shell
  function navItems() {
    if (!S.org) return isRealSuper() ? [{ h: "#admin", t: "Clients", i: "✦" }, { h: "#requests", t: "Requests", i: "✉" }, { h: "#settings", t: "Settings", i: "⚙" }] : [];
    const M = mods(); const items = [{ h: "#home", t: "Home", i: "⌂" }];
    if (!isStaff() && M.employees) items.push({ h: "#me", t: "My profile", i: "☺" });
    if (M.documents) items.push({ h: "#docs", t: "Documents", i: "▤" });
    if (M.employees) items.push({ h: "#org", t: "Org chart", i: "⌥" });
    if (isStaff()) { if (M.employees) items.push({ h: "#employees", t: "Employees", i: "☰" }); if (M.hiring) items.push({ h: "#hiring", t: "Hiring", i: "◫" }); if (M.tasks && M.employees) items.push({ h: "#tasks", t: "Tasks", i: "☑" }); }
    if (isAdmin()) items.push({ h: "#people", t: "People", i: "◉" });
    if (M.requests) items.push({ h: "#requests", t: "Ask JHM", i: "✉" });
    items.push({ h: "#settings", t: "Settings", i: "⚙" });
    return items;
  }
  function roleLabel(r) { return (ROLE[r === "admin" ? "owner" : r === "member" ? "employee" : r] || ROLE.employee).label; }
  function renderShell(inner) {
    const route = (location.hash || "#home").split("/")[0];
    const nav = navItems();
    const inWorkspace = !!S.org;
    const accent = (inWorkspace && S.org.accent) || "#23305a";
    document.documentElement.style.setProperty("--accent", accent);   // used for the client's monogram / identity only
    const logo = inWorkspace && S.logoUrl ? `<img class="logo wide" src="${S.logoUrl}" alt="" />` : `<div class="logo">${esc(initials(inWorkspace ? S.org.name : "HH"))}</div>`;
    const orgSwitch = S.orgs.length > 1 && inWorkspace ? `<div class="org-switch"><select id="orgsel">${S.orgs.map((o) => `<option value="${o.id}" ${o.id === S.org?.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></div>` : "";
    const viewAs = isRealSuper() && inWorkspace ? `<div class="viewas"><span class="small muted">View as</span><select id="viewas">
        <option value="" ${!S.viewAs ? "selected" : ""}>JHM admin</option><option value="owner" ${S.viewAs === "owner" ? "selected" : ""}>Owner</option><option value="staff" ${S.viewAs === "staff" ? "selected" : ""}>Staff</option><option value="employee" ${S.viewAs === "employee" ? "selected" : ""}>Employee</option></select></div>` : "";
    const sideTop = inWorkspace
      ? `<div class="ws-card">${isRealSuper() ? `<a href="#admin" class="ws-back">← All clients</a>` : ""}${S.logoUrl ? `<div class="ws-logo"><img src="${S.logoUrl}" alt="${esc(S.org.name)} logo" /></div>` : `<div class="ws-mono">${esc(initials(S.org.name))}</div><div class="ws-name">${esc(S.org.name)}</div>`}<div class="ws-sub"><span class="rolebadge" title="${esc(ROLE[effRole()]?.blurb || "")}">${isRealSuper() && S.viewAs ? "Viewing as " + roleLabel(S.viewAs) : roleLabel(effRole())}</span></div></div>`
      : `<div class="ws-card hq"><div class="ws-mono">HH</div><div class="ws-name">JHM Consulting</div><div class="ws-sub"><span class="rolebadge">JHM admin</span></div></div>`;
    let collapsed = false; try { collapsed = localStorage.getItem("hhg.side") === "1"; } catch {}
    app.innerHTML = `
      <div class="shell ${inWorkspace ? "in-ws" : "hq"} ${collapsed ? "collapsed" : ""}">
        <header class="topbar">
          <button class="navtoggle" id="navtoggle" title="${collapsed ? "Expand" : "Collapse"} sidebar" aria-label="Toggle sidebar">☰</button>
          <div class="brand">${logo}<div><div class="name">${esc(inWorkspace ? S.org.name : CFG.PORTAL_NAME)}</div>${inWorkspace ? "" : `<div class="sub">The Hope Harvest Group · JHM Consulting</div>`}</div></div>
          ${inWorkspace ? `<button class="searchbar" id="opensearch"><span>⌕</span><span class="ph">Search people, jobs, tasks, documents…</span><kbd>⌘K</kbd></button>` : ""}
          <div class="spacer"></div>${viewAs}${orgSwitch}
          <div class="avatar" id="avatar" title="${esc(S.profile.email)}">${esc(initials(S.profile.full_name || S.profile.email))}</div>
          <div class="menu hidden" id="menu"><div class="who"><b>${esc(S.profile.full_name || "")}</b><br><span class="muted">${esc(S.profile.email)}</span></div>
            <button data-go="#settings">Settings</button><button id="signout">Sign out</button></div>
        </header>
        <div class="layout">
          <nav class="sidenav">${sideTop}${nav.map((n) => `<a href="${n.h}" class="${route === n.h ? "active" : ""}" title="${n.t}"><i>${n.i}</i><span class="lbl">${n.t}</span></a>`).join("")}
            <button class="collapse" id="collapse" title="${collapsed ? "Expand" : "Collapse"} sidebar">${collapsed ? "»" : "«"}<span class="lbl"> Collapse</span></button></nav>
          <main class="main" id="main">${inner}</main>
        </div>
        <nav class="tabbar">${(isRealSuper() && inWorkspace ? [{ h: "#admin", t: "Clients", i: "✦" }] : []).concat(nav).map((n) => `<a href="${n.h}" class="${route === n.h ? "active" : ""}"><span>${n.i}</span>${n.t}</a>`).join("")}</nav>
      </div>`;
    const menu = $("#menu");
    $("#avatar").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
    document.addEventListener("click", () => menu.classList.add("hidden"), { once: true });
    $("#signout").onclick = () => sb.auth.signOut();
    menu.querySelector("[data-go]").onclick = () => { location.hash = "#settings"; };
    const os = $("#opensearch"); if (os) os.onclick = () => openSearch();
    const toggleSide = () => { try { localStorage.setItem("hhg.side", collapsed ? "0" : "1"); } catch {} render(); };
    $("#collapse").onclick = toggleSide; $("#navtoggle").onclick = toggleSide;
    const sel = $("#orgsel"); if (sel) sel.onchange = () => switchOrg(sel.value);
    const va = $("#viewas"); if (va) va.onchange = () => { S.viewAs = va.value || null; const ok = navItems().some((n) => n.h === route); if (!ok) location.hash = "#home"; else render(); };
  }

  // ------------------------------------------------------------ router
  async function render() {
    if (S.recovery) return renderAuth("recovery");
    if (!S.session) return renderAuth();
    if (!S.org && !isSuper()) {
      return renderShell(`<div class="empty"><h3>No access yet</h3><p>Your account isn't attached to a client workspace.<br>Ask your HR consultant to invite <b>${esc(S.profile.email)}</b>.</p>
        </div>`);
    }
    let [route, arg] = (location.hash || "#home").slice(1).split("/");
    if (route === "account") route = "settings";
    if ((route === "admin" || (route === "requests" && !S.org)) && isRealSuper()) { S.org = null; S.viewAs = null; try { localStorage.removeItem("hhg.org"); } catch {} }
    if (!S.org && !["requests", "settings"].includes(route)) route = "admin";   // super admin outside any workspace
    let html = "";
    const token = (render.seq = (render.seq || 0) + 1);
    try {
      const M = mods();
      if (route === "hiring" && isStaff() && M.hiring) html = arg ? await viewJobOrder(arg) : await viewHiring();
      else if (route === "employees" && isStaff() && M.employees) html = arg ? await viewEmployee(arg) : await viewEmployees();
      else if (route === "me" && M.employees) html = await viewMyProfile();
      else if (route === "org" && M.employees) html = await viewOrgChart();
      else if (route === "people" && isAdmin()) html = await viewPeople();
      else if (route === "admin" && isRealSuper()) html = await viewAdmin();
      else if (route === "requests" && (!S.org || M.requests)) html = await viewRequests();
      else if (route === "tasks" && isStaff() && M.tasks) html = await viewTasks();
      else if (route === "settings") html = await viewSettings(arg);
      else if (route === "home") html = await viewHome();
      else if (M.documents || !S.org) html = await viewDocs();
      else html = await viewHome();
    } catch (e) { fail(e); html = `<div class="empty"><h3>This page couldn't load</h3><p class="small">${esc(e?.message || e)}</p></div>`; }
    if (token !== render.seq) return;   // a newer render superseded this one
    renderShell(html);
    const hook = window.__afterRender; window.__afterRender = null; if (hook) hook();
  }
  window.addEventListener("hashchange", render);

  // ------------------------------------------------------------ DOCUMENTS
  let docFilter = "all", docSearch = "";
  async function viewDocs() {
    const { data: docs, error } = await sb.from("documents").select("*").eq("org_id", S.org.id).order("category").order("title");
    if (error) throw error;
    const counts = {}; docs.forEach((d) => (counts[d.category] = (counts[d.category] || 0) + 1));
    const shown = docs.filter((d) => (docFilter === "all" || d.category === docFilter) && (!docSearch || (d.title + " " + (d.description || "")).toLowerCase().includes(docSearch.toLowerCase())));
    window.__afterRender = () => {
      $("#main").querySelectorAll(".chip").forEach((c) => c.onclick = () => { docFilter = c.dataset.c; render(); });
      const s = $("#docsearch"); if (s) { s.oninput = () => { docSearch = s.value; renderDocList(docs); }; }
      wireDocRows();
      const up = $("#upload"); if (up) up.onclick = () => docModal();
    };
    function wireDocRows() {
      $("#main").querySelectorAll("[data-open]").forEach((b) => b.onclick = () => { openFile(b.dataset.open); log("document", b.dataset.id, "viewed"); });
      $("#main").querySelectorAll("[data-dl]").forEach((b) => b.onclick = () => openFile(b.dataset.dl, true));
      $("#main").querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => docModal(docs.find((d) => d.id === b.dataset.edit)));
      $("#main").querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
        const d = docs.find((x) => x.id === b.dataset.del);
        if (!(await confirmBox("Delete document?", `"${d.title}" will be removed for everyone in ${S.org.name}.`))) return;
        try {
          await sb.storage.from(BUCKET).remove([d.file_path]);
          const { error } = await sb.from("documents").delete().eq("id", d.id); if (error) throw error;
          await log("document", d.id, "deleted", { title: d.title }); toast("Deleted"); render();
        } catch (e) { fail(e); }
      });
    }
    function renderDocList(all) {
      const list = all.filter((d) => (docFilter === "all" || d.category === docFilter) && (!docSearch || (d.title + " " + (d.description || "")).toLowerCase().includes(docSearch.toLowerCase())));
      $("#doclist").innerHTML = docRows(list); wireDocRows();
    }
    const docRows = (list) => list.length ? list.map((d) => `
      <div class="row"><div class="icon">${esc(ext(d.file_name))}</div>
        <div class="grow"><div class="title">${esc(d.title)}</div>
          <div class="meta"><span>${CATS[d.category]}</span>${d.version_label ? `<span>${esc(d.version_label)}</span>` : ""}<span>Updated ${fmtDate(d.updated_at)}</span><span>${fmtSize(d.size_bytes)}</span>
          ${isStaff() ? `<span class="pill ${d.staff_visible ? "on" : ""}">${d.staff_visible ? "Shared with employees" : "HR only"}</span>` : ""}</div>
          ${d.description ? `<div class="small muted">${esc(d.description)}</div>` : ""}</div>
        <div class="actions"><button class="btn sm ghost" data-open="${d.file_path}" data-id="${d.id}">Open</button><button class="btn sm quiet" data-dl="${d.file_path}">Download</button>
          ${isStaff() ? `<button class="btn sm quiet" data-edit="${d.id}">Edit</button><button class="btn sm danger" data-del="${d.id}">Delete</button>` : ""}</div></div>`).join("")
      : `<div class="empty"><h3>No documents here yet</h3><p>${isStaff() ? "Upload a handbook, policy, job description or benefits handout to get started." : "Your HR consultant hasn't shared anything in this category yet."}</p></div>`;

    return `
      <div class="page-head"><div><h1>Documents</h1><p>${isStaff() ? "Handbook, policies, forms and benefits — shared with the team or kept HR-only." : "Your company's HR documents, shared by JHM Consulting."}</p></div>
        ${isStaff() ? `<button class="btn" id="upload">＋ Upload document</button>` : ""}</div>
      <div class="filters"><button class="chip ${docFilter === "all" ? "active" : ""}" data-c="all">All (${docs.length})</button>
        ${Object.keys(CATS).filter((c) => counts[c]).map((c) => `<button class="chip ${docFilter === c ? "active" : ""}" data-c="${c}">${CATS[c]} (${counts[c]})</button>`).join("")}</div>
      <div class="filters"><input class="search" id="docsearch" type="text" placeholder="Search documents…" value="${esc(docSearch)}" /></div>
      <div class="list" id="doclist">${docRows(shown)}</div>`;
  }

  function docModal(doc = null) {
    const m = modal(`
      <div class="modal-head"><h3>${doc ? "Edit document" : "Upload document"}</h3><button class="x" data-close>×</button></div>
      <form id="f">
        <label>Title</label><input type="text" name="title" required value="${esc(doc?.title || "")}" placeholder="e.g. Employee Handbook" />
        <div class="two"><div><label>Category</label><select name="category">${Object.entries(CATS).map(([k, v]) => `<option value="${k}" ${doc?.category === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label>Version label</label><input type="text" name="version_label" value="${esc(doc?.version_label || "")}" placeholder="v2 — Nov 2026" /></div></div>
        <label>Description <span class="muted">(optional)</span></label><textarea name="description" placeholder="What this is and when to use it">${esc(doc?.description || "")}</textarea>
        <label>${doc ? "Replace file (optional)" : "File"}</label><input type="file" name="file" ${doc ? "" : "required"} accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.csv" />
        <label class="check"><input type="checkbox" name="staff_visible" ${doc?.staff_visible ? "checked" : ""} /> Share with employees (self-service) — leave off for HR-only items</label>
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${doc ? "Save changes" : "Upload"}</button></div>
      </form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      const file = f.file.files[0];
      const rec = { title: d.title.trim(), category: d.category, version_label: d.version_label.trim() || null, description: d.description.trim() || null, staff_visible: !!d.staff_visible };
      if (file) {
        rec.file_path = await uploadFile(file, "documents"); rec.file_name = file.name; rec.mime_type = file.type; rec.size_bytes = file.size;
      }
      if (doc) {
        const { error } = await sb.from("documents").update(rec).eq("id", doc.id); if (error) throw error;
        if (file && doc.file_path !== rec.file_path) await sb.storage.from(BUCKET).remove([doc.file_path]);
        await log("document", doc.id, "updated", { title: rec.title });
      } else {
        const { data, error } = await sb.from("documents").insert({ ...rec, org_id: S.org.id, uploaded_by: S.session.user.id }).select().single(); if (error) throw error;
        await log("document", data.id, "created", { title: rec.title });
      }
      m.close(); toast(doc ? "Saved" : "Uploaded"); render();
    }); };
  }

  // ------------------------------------------------------------ HIRING
  let jobFilter = "open";
  async function viewHiring() {
    const { data: jobs, error } = await sb.from("job_orders").select("*, candidates(stage)").eq("org_id", S.org.id).order("created_at", { ascending: false });
    if (error) throw error;
    const shown = jobs.filter((j) => jobFilter === "all" || (jobFilter === "open" ? (j.status === "open" || j.status === "on_hold") : j.status === jobFilter));
    window.__afterRender = () => {
      $("#main").querySelectorAll(".chip").forEach((c) => c.onclick = () => { jobFilter = c.dataset.c; render(); });
      const b = $("#newjob"); if (b) b.onclick = () => jobModal();
    };
    return `
      <div class="page-head"><div><h1>Hiring</h1><p>Open orders and the candidates moving through them.</p></div><button class="btn" id="newjob">＋ New job order</button></div>
      <div class="filters"><button class="chip ${jobFilter === "open" ? "active" : ""}" data-c="open">Active</button><button class="chip ${jobFilter === "filled" ? "active" : ""}" data-c="filled">Filled</button><button class="chip ${jobFilter === "closed" ? "active" : ""}" data-c="closed">Closed</button><button class="chip ${jobFilter === "all" ? "active" : ""}" data-c="all">All</button></div>
      <div class="list">${shown.length ? shown.map((j) => {
        const active = j.candidates.filter((c) => !["hired", "passed"].includes(c.stage)).length;
        return `<a class="row" href="#hiring/${j.id}" style="text-decoration:none;color:inherit"><div class="icon">${esc(initials(j.title))}</div>
          <div class="grow"><div class="title">${esc(j.title)}</div><div class="meta">${j.department ? `<span>${esc(j.department)}</span>` : ""}${j.location ? `<span>${esc(j.location)}</span>` : ""}${j.employment_type ? `<span>${esc(j.employment_type)}</span>` : ""}<span>Opened ${fmtDate(j.opened_at)}</span></div></div>
          <div class="actions"><span class="pill">${j.candidates.length} candidate${j.candidates.length === 1 ? "" : "s"} · ${active} active</span><span class="pill ${j.status === "open" ? "on" : j.status === "on_hold" ? "warn" : ""}">${JOB_STATUS[j.status]}</span></div></a>`; }).join("")
        : `<div class="empty"><h3>No job orders</h3><p>Create one when a client has a position to fill. Resumes and interview notes live inside each order.</p></div>`}</div>`;
  }

  async function jobModal(job = null) {
    const { data: procDocs } = await sb.from("documents").select("id,title").eq("org_id", S.org.id).in("category", ["hiring_process", "job_description"]).order("title");
    const m = modal(`
      <div class="modal-head"><h3>${job ? "Edit job order" : "New job order"}</h3><button class="x" data-close>×</button></div>
      <form id="f">
        <label>Position title</label><input type="text" name="title" required value="${esc(job?.title || "")}" />
        <div class="two"><div><label>Department</label><input type="text" name="department" value="${esc(job?.department || "")}" /></div>
        <div><label>Location</label><input type="text" name="location" value="${esc(job?.location || "")}" placeholder="Tampa, FL / Remote" /></div></div>
        <div class="two"><div><label>Employment type</label><select name="employment_type">${["Full-time", "Part-time", "Contract", "Temp-to-hire", "Internship"].map((t) => `<option ${job?.employment_type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div><label>Status</label><select name="status">${Object.entries(JOB_STATUS).map(([k, v]) => `<option value="${k}" ${job?.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
        <label>Opened</label><input type="date" name="opened_at" value="${job?.opened_at || new Date().toISOString().slice(0, 10)}" />
        <label>Interview process / job description document</label><select name="process_doc_id"><option value="">— none —</option>${(procDocs || []).map((d) => `<option value="${d.id}" ${job?.process_doc_id === d.id ? "selected" : ""}>${esc(d.title)}</option>`).join("")}</select>
        <label>Notes</label><textarea name="description" placeholder="Pay range, must-haves, interview panel, timeline…">${esc(job?.description || "")}</textarea>
        <label>Attach a document <span class="muted">(full job description, interview guide — optional, more can be added later)</span></label><input type="file" name="attachment" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt" />
        <div class="modal-foot">${job ? `<button type="button" class="btn danger" id="del">Delete</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${job ? "Save" : "Create"}</button></div>
      </form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      const rec = { title: d.title.trim(), department: d.department.trim() || null, location: d.location.trim() || null, employment_type: d.employment_type, status: d.status, opened_at: d.opened_at || null, process_doc_id: d.process_doc_id || null, description: d.description.trim() || null };
      let jobId = job?.id;
      if (job) { const { error } = await sb.from("job_orders").update(rec).eq("id", job.id); if (error) throw error; await log("job_order", job.id, "updated", { title: rec.title, status: rec.status }); }
      else { const { data, error } = await sb.from("job_orders").insert({ ...rec, org_id: S.org.id, created_by: S.session.user.id }).select().single(); if (error) throw error; jobId = data.id; await log("job_order", data.id, "created", { title: rec.title }); }
      const att = f.attachment.files[0];
      if (att) await addJobFile(jobId, att, att.name.replace(/\.[^.]+$/, ""));
      if (!job) location.hash = "#hiring/" + jobId;
      m.close(); toast("Saved"); render();
    }); };
    const del = m.el.querySelector("#del");
    if (del) del.onclick = async () => {
      if (!(await confirmBox("Delete job order?", "All candidates, resumes and notes in this order will be deleted too."))) return;
      try {
        const [{ data: cands }, { data: jfiles }] = await Promise.all([sb.from("candidates").select("resume_path").eq("job_order_id", job.id), sb.from("job_order_files").select("file_path").eq("job_order_id", job.id)]);
        const paths = [...(cands || []).map((c) => c.resume_path), ...(jfiles || []).map((x) => x.file_path)].filter(Boolean); if (paths.length) await sb.storage.from(BUCKET).remove(paths);
        const { error } = await sb.from("job_orders").delete().eq("id", job.id); if (error) throw error;
        await log("job_order", job.id, "deleted", { title: job.title }); m.close(); location.hash = "#hiring";
      } catch (e) { fail(e); }
    };
  }

  async function addJobFile(jobId, file, title) {
    const path = await uploadFile(file, "jobs/" + jobId);
    const { error } = await sb.from("job_order_files").insert({ org_id: S.org.id, job_order_id: jobId, title: title || file.name, file_path: path, file_name: file.name, size_bytes: file.size, uploaded_by: S.session.user.id }); if (error) throw error;
    await log("job_order", jobId, "attachment_added", { file: title || file.name });
  }
  function jobFileModal(job) {
    const m = modal(`<div class="modal-head"><h3>Attach document to ${esc(job.title)}</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate><label>Title</label><input type="text" name="title" placeholder="e.g. Full job description, Interview guide" />
        <label>File *</label><input type="file" name="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt" />
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Upload</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const file = f.file.files[0]; if (!file) throw new Error("Choose a file.");
      await addJobFile(job.id, file, f.title.value.trim() || file.name.replace(/\.[^.]+$/, ""));
      m.close(); toast("Attached"); render();
    }); };
  }
  async function viewJobOrder(id) {
    const jr = await Promise.all([
      sb.from("job_orders").select("*, process_doc:process_doc_id(id,title,file_path)").eq("id", id).single(),
      sb.from("candidates").select("*").eq("job_order_id", id).order("created_at"),
      sb.from("activity_log").select("*, actor:actor_id(full_name)").eq("org_id", S.org.id).in("entity_type", ["job_order", "candidate"]).order("created_at", { ascending: false }).limit(60),
      sb.from("job_order_files").select("*").eq("job_order_id", id).order("created_at"),
    ]);
    const badj = jr.find((r) => r.error); if (badj) throw new Error(badj.error.message);
    const job = jr[0].data, cands = jr[1].data || [], acts = jr[2].data || [], jfiles = jr[3].data || [];
    const candIds = new Set(cands.map((c) => c.id));
    const activity = (acts || []).filter((a) => a.entity_id === id || candIds.has(a.entity_id) || a.detail?.job_order_id === id).slice(0, 25);

    const candCard = (c) => `<div class="cand" draggable="true" data-c="${c.id}"><div class="n">${esc(c.full_name)}</div><div class="s">${[c.source, fmtDate(c.created_at)].filter(Boolean).join(" · ")}${c.resume_path ? " · 📄" : ""}</div></div>`;
    window.__afterRender = () => {
      $("#editjob").onclick = () => jobModal(job);
      $("#addcand").onclick = () => candModal(job);
      const pd = $("#procdoc"); if (pd) pd.onclick = () => openFile(job.process_doc.file_path);
      $("#addjobfile").onclick = () => jobFileModal(job);
      $("#main").querySelectorAll("[data-jopen]").forEach((b) => b.onclick = () => openFile(b.dataset.jopen));
      $("#main").querySelectorAll("[data-jdl]").forEach((b) => b.onclick = () => openFile(b.dataset.jdl, true));
      $("#main").querySelectorAll("[data-jdel]").forEach((b) => b.onclick = async () => {
        const fl = (jfiles || []).find((x) => x.id === b.dataset.jdel);
        if (!(await confirmBox("Delete attachment?", fl.title))) return;
        try { await sb.storage.from(BUCKET).remove([fl.file_path]); const { error } = await sb.from("job_order_files").delete().eq("id", fl.id); if (error) throw error; await log("job_order", job.id, "attachment_removed", { title: job.title, file: fl.title }); render(); } catch (err) { fail(err); }
      });
      $("#main").querySelectorAll(".cand").forEach((el) => {
        el.onclick = () => candDetail(cands.find((c) => c.id === el.dataset.c), job);
        el.ondragstart = (e) => { e.dataTransfer.setData("text/plain", el.dataset.c); el.classList.add("drag"); };
        el.ondragend = () => el.classList.remove("drag");
      });
      $("#main").querySelectorAll(".col").forEach((col) => {
        col.ondragover = (e) => { e.preventDefault(); col.classList.add("over"); };
        col.ondragleave = () => col.classList.remove("over");
        col.ondrop = async (e) => { e.preventDefault(); col.classList.remove("over"); const cid = e.dataTransfer.getData("text/plain"); const c = cands.find((x) => x.id === cid); if (c && c.stage !== col.dataset.stage) await setStage(c, col.dataset.stage, job); };
      });
    };
    return `
      <div class="page-head"><div><a href="#hiring" class="small">← All job orders</a><h1>${esc(job.title)}</h1>
        <p>${[job.department, job.location, job.employment_type, "Opened " + fmtDate(job.opened_at)].filter(Boolean).map(esc).join(" · ")} · <span class="pill ${job.status === "open" ? "on" : ""}">${JOB_STATUS[job.status]}</span></p></div>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">${job.process_doc ? `<button class="btn quiet" id="procdoc">📄 ${esc(job.process_doc.title)}</button>` : ""}<button class="btn quiet" id="editjob">Edit order</button><button class="btn" id="addcand">＋ Add candidate</button></div></div>
      <div class="two" style="margin-bottom:16px;align-items:start">
        <div class="card">${job.description ? `<h3 style="font-size:15px;margin-bottom:6px">Notes</h3><div style="white-space:pre-wrap">${esc(job.description)}</div>` : `<span class="muted small">No notes on this order. Use Edit order to add pay range, must-haves, timeline.</span>`}</div>
        <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3 style="font-size:15px">Attachments</h3><button class="btn sm quiet" id="addjobfile">＋ Upload</button></div>
          ${(jfiles || []).length ? jfiles.map((fl) => `<div class="sub-row"><div><b>${esc(fl.title)}</b><div class="small muted">${esc(fl.file_name)} · ${fmtSize(fl.size_bytes)} · ${fmtDate(fl.created_at)}</div></div>
            <div style="display:flex;gap:6px"><button class="btn sm ghost" data-jopen="${fl.file_path}">Open</button><button class="btn sm quiet" data-jdl="${fl.file_path}">Download</button><button class="btn sm danger" data-jdel="${fl.id}">Delete</button></div></div>`).join("")
          : `<p class="small muted" style="margin:8px 0 0">Full job description, interview guide, scorecard, offer template…</p>`}</div>
      </div>
      <div class="board">${STAGES.map((s) => { const list = cands.filter((c) => c.stage === s); return `<div class="col" data-stage="${s}"><h4>${STAGE_LABEL[s]}<span>${list.length}</span></h4>${list.map(candCard).join("")}</div>`; }).join("")}</div>
      <p class="small muted" style="margin-top:8px">Drag a candidate between columns, or open them to change stage, add notes and view the resume.</p>
      <h3 style="margin:22px 0 8px">Activity</h3>
      <div class="card">${activity.length ? activity.map((a) => `<div class="act"><time>${fmtDT(a.created_at)}</time><b>${esc(a.actor?.full_name || "Someone")}</b> ${esc(actText(a))}</div>`).join("") : `<span class="muted small">Nothing yet.</span>`}</div>`;
  }
  function actText(a) {
    const d = a.detail || {};
    if (a.entity_type === "candidate") {
      if (a.action === "stage_changed") return `moved ${d.name} to ${STAGE_LABEL[d.to] || d.to}`;
      if (a.action === "created") return `added candidate ${d.name}`;
      if (a.action === "note") return `left a note on ${d.name}`;
      if (a.action === "deleted") return `removed candidate ${d.name}`;
      return `${a.action} ${d.name || ""}`;
    }
    if (a.action === "attachment_added") return `attached "${d.file}" to the job order`;
    if (a.action === "attachment_removed") return `removed attachment "${d.file}"`;
    return `${a.action.replace("_", " ")} job order ${d.title ? `"${d.title}"` : ""}`;
  }
  async function setStage(c, stage, job) {
    try {
      const { error } = await sb.from("candidates").update({ stage }).eq("id", c.id); if (error) throw error;
      await log("candidate", c.id, "stage_changed", { name: c.full_name, from: c.stage, to: stage, job_order_id: job.id });
      toast(`${c.full_name} → ${STAGE_LABEL[stage]}`); render();
    } catch (e) { fail(e); }
  }
  function candModal(job, c = null) {
    const m = modal(`
      <div class="modal-head"><h3>${c ? "Edit candidate" : "Add candidate"}</h3><button class="x" data-close>×</button></div>
      <form id="f"><label>Full name</label><input type="text" name="full_name" required value="${esc(c?.full_name || "")}" />
        <div class="two"><div><label>Email</label><input type="email" name="email" value="${esc(c?.email || "")}" /></div><div><label>Phone</label><input type="tel" name="phone" value="${esc(c?.phone || "")}" /></div></div>
        <div class="two"><div><label>Source</label><input type="text" name="source" value="${esc(c?.source || "")}" placeholder="Indeed, referral…" /></div>
        <div><label>Stage</label><select name="stage">${STAGES.map((s) => `<option value="${s}" ${(c?.stage || "applied") === s ? "selected" : ""}>${STAGE_LABEL[s]}</option>`).join("")}</select></div></div>
        <label>Resume ${c?.resume_path ? `<span class="muted">(replace — current: ${esc(c.resume_name)})</span>` : ""}</label><input type="file" name="resume" accept=".pdf,.doc,.docx,.txt,.rtf" />
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${c ? "Save" : "Add"}</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); const file = f.resume.files[0];
      const rec = { full_name: d.full_name.trim(), email: d.email.trim() || null, phone: d.phone.trim() || null, source: d.source.trim() || null, stage: d.stage };
      if (file) { rec.resume_path = await uploadFile(file, "resumes"); rec.resume_name = file.name; }
      if (c) {
        const { error } = await sb.from("candidates").update(rec).eq("id", c.id); if (error) throw error;
        if (file && c.resume_path) await sb.storage.from(BUCKET).remove([c.resume_path]);
        if (rec.stage !== c.stage) await log("candidate", c.id, "stage_changed", { name: rec.full_name, from: c.stage, to: rec.stage, job_order_id: job.id });
      } else {
        const { data, error } = await sb.from("candidates").insert({ ...rec, org_id: S.org.id, job_order_id: job.id, created_by: S.session.user.id }).select().single(); if (error) throw error;
        await log("candidate", data.id, "created", { name: rec.full_name, job_order_id: job.id });
      }
      m.close(); toast("Saved"); render();
    }); };
  }
  async function candDetail(c, job) {
    const { data: notes } = await sb.from("candidate_notes").select("*, author:author_id(full_name)").eq("candidate_id", c.id).order("created_at", { ascending: false });
    const m = modal(`
      <div class="modal-head"><h3>${esc(c.full_name)}</h3><button class="x" data-close>×</button></div>
      <div class="meta small muted" style="display:flex;gap:10px;flex-wrap:wrap">${[c.email, c.phone, c.source ? "via " + c.source : "", "Added " + fmtDate(c.created_at)].filter(Boolean).map(esc).join(" · ")}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0;align-items:center">
        <select id="stage">${STAGES.map((s) => `<option value="${s}" ${c.stage === s ? "selected" : ""}>${STAGE_LABEL[s]}</option>`).join("")}</select>
        ${c.resume_path ? `<button class="btn quiet sm" id="resume">📄 View resume</button>` : `<span class="pill">No resume</span>`}
        <button class="btn quiet sm" id="edit">Edit</button><button class="btn danger sm" id="del">Remove</button></div>
      <h3 style="font-size:15px">Notes</h3>
      <form id="nf" style="margin-top:6px"><textarea name="body" placeholder="Phone screen summary, interview feedback, next step…" required></textarea>
        <div style="text-align:right;margin-top:6px"><button class="btn sm" id="addnote">Add note</button></div></form>
      <div id="notes">${(notes || []).map(noteHtml).join("") || `<p class="muted small">No notes yet.</p>`}</div>`, { wide: true });
    function noteHtml(n) { return `<div class="note"><div style="white-space:pre-wrap">${esc(n.body)}</div><div class="by">${esc(n.author?.full_name || "Someone")} · ${fmtDT(n.created_at)}</div></div>`; }
    m.el.querySelector("#stage").onchange = async (e) => { m.close(); await setStage(c, e.target.value, job); };
    const r = m.el.querySelector("#resume"); if (r) r.onclick = () => openFile(c.resume_path);
    m.el.querySelector("#edit").onclick = () => { m.close(); candModal(job, c); };
    m.el.querySelector("#del").onclick = async () => {
      if (!(await confirmBox("Remove candidate?", `${c.full_name} and their resume and notes will be deleted.`))) return;
      try { if (c.resume_path) await sb.storage.from(BUCKET).remove([c.resume_path]);
        const { error } = await sb.from("candidates").delete().eq("id", c.id); if (error) throw error;
        await log("candidate", c.id, "deleted", { name: c.full_name, job_order_id: job.id }); m.close(); render(); } catch (e) { fail(e); }
    };
    const nf = m.el.querySelector("#nf");
    nf.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#addnote"), async () => {
      const body = nf.body.value.trim(); if (!body) return;
      const { data, error } = await sb.from("candidate_notes").insert({ org_id: S.org.id, candidate_id: c.id, author_id: S.session.user.id, body }).select("*, author:author_id(full_name)").single(); if (error) throw error;
      await log("candidate", c.id, "note", { name: c.full_name, job_order_id: job.id });
      nf.body.value = ""; const box = m.el.querySelector("#notes"); if (box.querySelector("p")) box.innerHTML = ""; box.insertAdjacentHTML("afterbegin", noteHtml(data));
    }); };
  }

  // ------------------------------------------------------------ EMPLOYEES (HRIS)
  let empFilter = "current", empSearch = "";
  const empName = (e) => `${e.preferred_name || e.first_name} ${e.last_name}`;
  async function viewEmployees() {
    const { data: emps, error } = await sb.from("employees").select("*, employee_tasks(status)").eq("org_id", S.org.id).order("last_name").order("first_name");
    if (error) throw error;
    const list = emps.filter((e) => (empFilter === "all" || (empFilter === "current" ? e.status !== "terminated" : e.status === empFilter))
      && (!empSearch || `${e.first_name} ${e.last_name} ${e.preferred_name || ""} ${e.job_title || ""} ${e.department || ""}`.toLowerCase().includes(empSearch.toLowerCase())));
    const counts = { current: emps.filter((e) => e.status !== "terminated").length, onboarding: 0, active: 0, leave: 0, terminated: 0 };
    emps.forEach((e) => counts[e.status]++);
    window.__afterRender = () => {
      $("#newemp").onclick = () => employeeModal();
      $("#main").querySelectorAll(".chip").forEach((c) => c.onclick = () => { empFilter = c.dataset.c; render(); });
      const s = $("#empsearch"); if (s) s.oninput = () => { empSearch = s.value; render(); };
      const s2 = $("#empsearch"); if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
    };
    return `
      <div class="page-head"><div><h1>Employees</h1><p>Employee records and onboarding.</p></div><button class="btn" id="newemp">＋ Add employee</button></div>
      <div class="filters">${[["current", "Current"], ["onboarding", "Onboarding"], ["active", "Active"], ["leave", "On leave"], ["terminated", "Terminated"], ["all", "All"]].map(([k, v]) => `<button class="chip ${empFilter === k ? "active" : ""}" data-c="${k}">${v}${k !== "all" ? ` (${counts[k]})` : ""}</button>`).join("")}</div>
      <div class="filters"><input class="search" id="empsearch" type="text" placeholder="Search by name, title, department…" value="${esc(empSearch)}" /></div>
      ${list.length ? `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Employee</th><th>Title</th><th>Department</th><th>Start</th><th>Status</th><th>Onboarding</th></tr></thead><tbody>
        ${list.map((e) => { const t = e.employee_tasks || []; const done = t.filter((x) => x.status === "complete" || x.status === "na").length;
          return `<tr class="clickable" data-emp="${e.id}" onclick="location.hash='#employees/${e.id}'"><td><b>${esc(empName(e))}</b>${e.preferred_name ? `<div class="small muted">${esc(e.first_name)} ${esc(e.last_name)}</div>` : ""}</td><td>${esc(e.job_title || "—")}</td><td>${esc(e.department || "—")}</td><td>${fmtDate(e.start_date) || "—"}</td>
            <td><span class="pill ${e.status === "active" ? "on" : e.status === "onboarding" ? "warn" : ""}">${EMP_STATUS[e.status]}</span></td><td class="small ${done === t.length ? "muted" : ""}">${t.length ? `${done}/${t.length} complete` : "—"}</td></tr>`; }).join("")}
      </tbody></table></div>`
      : `<div class="empty"><h3>No employees ${empFilter === "all" ? "yet" : "in this view"}</h3><p>Add an employee to start their onboarding checklist — W-4, I-9, guidebook acknowledgment, state new-hire report and more are created automatically with due dates.</p></div>`}`;
  }

  const SEL = (name, opts, val, blank = "—") => `<select name="${name}"><option value="">${blank}</option>${opts.map((o) => `<option ${val === o ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  const INP = (label, name, val, type = "text", ph = "") => `<div><label>${label}</label><input type="${type}" name="${name}" value="${esc(val ?? "")}" placeholder="${esc(ph)}" /></div>`;
  async function employeeModal(e = null, focus = null) {
    const { data: others } = await sb.from("employees").select("id,first_name,last_name").eq("org_id", S.org.id).neq("status", "terminated").order("last_name");
    const m = modal(`
      <div class="modal-head"><h3>${e ? "Edit employee" : "Add employee"}</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate>
        <h4 class="sec" id="sec-personal">Personal</h4>
        <div class="three">${INP("First name *", "first_name", e?.first_name)}${INP("Middle", "middle_name", e?.middle_name)}${INP("Last name *", "last_name", e?.last_name)}</div>
        <div class="three">${INP("Preferred name", "preferred_name", e?.preferred_name)}${INP("Date of birth", "date_of_birth", e?.date_of_birth, "date")}<div><label>Marital status</label>${SEL("marital_status", ["Single", "Married", "Domestic partner", "Divorced", "Widowed"], e?.marital_status)}</div></div>
        <div class="three"><div><label>Gender</label>${SEL("gender", ["Female", "Male", "Non-binary", "Prefer not to say"], e?.gender)}</div></div>
        <h4 class="sec" id="sec-contact">Contact</h4><p class="small muted" style="margin:4px 0 0">If an email here matches a portal user invited as <b>Employee</b>, their self-service profile links automatically.</p>
        <div class="two">${INP("Personal email", "personal_email", e?.personal_email, "email")}${INP("Work email", "work_email", e?.work_email, "email")}</div>
        <div class="two">${INP("Mobile phone", "mobile_phone", e?.mobile_phone, "tel")}${INP("Home phone", "home_phone", e?.home_phone, "tel")}</div>
        <div class="two">${INP("Address", "address1", e?.address1)}${INP("Apt / Suite", "address2", e?.address2)}</div>
        <div class="three">${INP("City", "city", e?.city)}${INP("State", "state", e?.state ?? "FL")}${INP("ZIP", "zip", e?.zip)}</div>
        <h4 class="sec" id="sec-employment">Employment</h4>
        <div class="three">${INP("Hire date", "hire_date", e?.hire_date, "date")}${INP("Start date", "start_date", e?.start_date, "date")}<div><label>Status</label><select name="status">${Object.entries(EMP_STATUS).map(([k, v]) => `<option value="${k}" ${(e?.status || "onboarding") === k ? "selected" : ""}>${v}</option>`).join("")}</select></div></div>
        <div class="three">${INP("Job title", "job_title", e?.job_title)}${INP("Department", "department", e?.department)}${INP("Work location", "work_location", e?.work_location)}</div>
        <div class="three"><div><label>Employee type</label>${SEL("employee_type", ["Full-time", "Part-time", "Temporary", "Seasonal", "Intern", "Contractor"], e?.employee_type)}</div>
          <div><label>FLSA class</label>${SEL("flsa_class", ["Exempt", "Non-exempt"], e?.flsa_class)}</div>
          <div><label>Manager</label><select name="manager_id"><option value="">—</option>${(others || []).filter((o) => o.id !== e?.id).map((o) => `<option value="${o.id}" ${e?.manager_id === o.id ? "selected" : ""}>${esc(o.first_name + " " + o.last_name)}</option>`).join("")}</select></div></div>
        <div class="three"><div><label>Pay type</label>${SEL("pay_type", ["Hourly", "Salary"], e?.pay_type)}</div>${INP("Pay rate", "pay_rate", e?.pay_rate, "number", "0.00")}<div><label>Pay frequency</label>${SEL("pay_frequency", ["Weekly", "Bi-weekly", "Semi-monthly", "Monthly"], e?.pay_frequency)}</div></div>
        <div class="three">${INP("Scheduled hours / week", "scheduled_hours", e?.scheduled_hours, "number")}</div>
        ${e ? `<div class="two">${INP("Termination date", "termination_date", e?.termination_date, "date")}${INP("Termination reason", "termination_reason", e?.termination_reason)}</div>` : ""}
        <label>Notes</label><textarea name="notes">${esc(e?.notes || "")}</textarea>
        <div class="modal-foot">${e ? `<button type="button" class="btn danger" id="del">Delete record</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${e ? "Save" : "Add employee"}</button></div>
      </form>`, { wide: true });
    const f = m.el.querySelector("#f");
    if (focus) { const sec = m.el.querySelector("#sec-" + focus); if (sec) { setTimeout(() => { sec.scrollIntoView({ block: "start", behavior: "smooth" }); const inp = sec.nextElementSibling?.querySelector("input,select"); if (inp) inp.focus({ preventScroll: true }); }, 60); } }
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      if (!d.first_name.trim() || !d.last_name.trim()) throw new Error("First and last name are required.");
      const rec = {};
      for (const [k, v] of Object.entries(d)) rec[k] = (typeof v === "string" && v.trim() === "") ? null : (typeof v === "string" ? v.trim() : v);
      if (rec.pay_rate != null) rec.pay_rate = Number(rec.pay_rate);
      if (rec.scheduled_hours != null) rec.scheduled_hours = Number(rec.scheduled_hours);
      if (rec.status === "terminated" && !rec.termination_date) rec.termination_date = new Date().toISOString().slice(0, 10);
      if (e) { const { error } = await sb.from("employees").update(rec).eq("id", e.id); if (error) throw error; await log("employee", e.id, "updated", { name: rec.first_name + " " + rec.last_name }); m.close(); toast("Saved"); render(); }
      else { const { data, error } = await sb.from("employees").insert({ ...rec, org_id: S.org.id, created_by: S.session.user.id }).select().single(); if (error) throw error;
        await log("employee", data.id, "created", { name: rec.first_name + " " + rec.last_name }); m.close(); toast("Employee added"); location.hash = "#employees/" + data.id; }
    }); };
    const del = m.el.querySelector("#del");
    if (del) del.onclick = async () => {
      if (!(await confirmBox("Delete employee record?", `${empName(e)}'s profile, onboarding files and documents will be permanently deleted. Prefer setting status to Terminated to keep the record.`))) return;
      try {
        const [{ data: t }, { data: fl }] = await Promise.all([sb.from("employee_tasks").select("file_path").eq("employee_id", e.id), sb.from("employee_files").select("file_path").eq("employee_id", e.id)]);
        const paths = [...(t || []), ...(fl || [])].map((x) => x.file_path).filter(Boolean); if (paths.length) await sb.storage.from(BUCKET).remove(paths);
        const { error } = await sb.from("employees").delete().eq("id", e.id); if (error) throw error;
        await log("employee", e.id, "deleted", { name: empName(e) }); m.close(); location.hash = "#employees";
      } catch (err) { fail(err); }
    };
  }

  async function viewEmployee(id) {
    const results = await Promise.all([
      sb.from("employees").select("*, manager:manager_id(first_name,last_name)").eq("id", id).single(),
      sb.from("employee_tasks").select("*, completed_by(id,full_name), template_doc:template_doc_id(id,title,file_path,file_name,mime_type)").eq("employee_id", id).order("sort_order"),
      sb.from("emergency_contacts").select("*").eq("employee_id", id).order("is_primary", { ascending: false }),
      sb.from("dependents").select("*").eq("employee_id", id).order("date_of_birth"),
      sb.from("employee_files").select("*").eq("employee_id", id).order("created_at", { ascending: false }),
    ]);
    const bad = results.find((r) => r.error); if (bad) throw new Error(bad.error.message + (/column|relation|does not exist/i.test(bad.error.message) ? " — run the latest SQL files in supabase/ (006, 007)." : ""));
    const e = results[0].data, tasks = results[1].data || [], contacts = results[2].data || [], deps = results[3].data || [], files = results[4].data || [];
    const done = tasks.filter((t) => t.status === "complete" || t.status === "na").length;
    const today = new Date().toISOString().slice(0, 10);
    const field = (l, v) => `<div class="fld"><span>${l}</span><b>${v ? esc(v) : "<span class='muted'>—</span>"}</b></div>`;
    const money = (n) => n == null ? "" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 });
    window.__afterRender = () => {
      $("#editemp").onclick = () => employeeModal(e);
      $("#empstatus").onchange = async (ev) => {
        const status = ev.target.value; const upd = { status };
        if (status === "terminated" && !e.termination_date) upd.termination_date = new Date().toISOString().slice(0, 10);
        try { const { error } = await sb.from("employees").update(upd).eq("id", e.id); if (error) throw error; await log("employee", e.id, "status_" + status, { name: empName(e) }); toast(`${empName(e)} is now ${EMP_STATUS[status]}`); render(); } catch (err) { fail(err); render(); }
      };
      $("#main").querySelectorAll("[data-editsec]").forEach((b) => b.onclick = () => employeeModal(e, b.dataset.editsec));
      const all = $("#allcomplete"); if (all) all.onclick = async () => {
        const open = tasks.filter((t) => !["complete", "na"].includes(t.status));
        if (!open.length) return;
        if (!(await confirmBox("Mark all onboarding tasks complete?", `${open.length} open item${open.length > 1 ? "s" : ""} for ${empName(e)} will be marked complete and stamped with your name and today's date.`, "Mark all complete"))) return;
        try {
          const { error } = await sb.from("employee_tasks").update({ status: "complete", completed_at: new Date().toISOString(), completed_by: S.session.user.id }).in("id", open.map((t) => t.id)); if (error) throw error;
          await log("employee", e.id, "task_complete", { name: empName(e), task: `all ${open.length} onboarding tasks` }); toast("All tasks marked complete"); render();
        } catch (err) { fail(err); }
      };
      const reopen = $("#reopenall"); if (reopen) reopen.onclick = async () => {
        if (!(await confirmBox("Reopen all tasks?", `Every onboarding item for ${empName(e)} goes back to Pending (files are kept).`, "Reopen all"))) return;
        try { const { error } = await sb.from("employee_tasks").update({ status: "pending", completed_at: null, completed_by: null }).eq("employee_id", e.id); if (error) throw error; render(); } catch (err) { fail(err); }
      };
      $("#addcontact").onclick = () => contactModal(e);
      $("#adddep").onclick = () => dependentModal(e);
      $("#addfile").onclick = () => empFileModal(e);
      $("#addtask").onclick = () => taskModal(e);
      $("#main").querySelectorAll("[data-task]").forEach((b) => b.onclick = () => taskModal(e, tasks.find((t) => t.id === b.dataset.task)));
      $("#main").querySelectorAll("[data-sign]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); signModal(e, tasks.find((t) => t.id === b.dataset.sign)); });
      $("#main").querySelectorAll("[data-open]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); openFile(b.dataset.open); });
      $("#main").querySelectorAll("[data-tstatus]").forEach((sel) => sel.onclick = (ev) => ev.stopPropagation());
      $("#main").querySelectorAll("[data-tstatus]").forEach((sel) => sel.onchange = async () => {
        const t = tasks.find((x) => x.id === sel.dataset.tstatus); const status = sel.value;
        const upd = { status, completed_at: ["complete", "na"].includes(status) ? new Date().toISOString() : null, completed_by: ["complete", "na"].includes(status) ? S.session.user.id : null };
        try { const { error } = await sb.from("employee_tasks").update(upd).eq("id", t.id); if (error) throw error; await log("employee", e.id, "task_" + status, { name: empName(e), task: t.label }); render(); } catch (err) { fail(err); }
      });
      $("#main").querySelectorAll("[data-editcontact]").forEach((b) => b.onclick = () => contactModal(e, contacts.find((c) => c.id === b.dataset.editcontact)));
      $("#main").querySelectorAll("[data-editdep]").forEach((b) => b.onclick = () => dependentModal(e, deps.find((c) => c.id === b.dataset.editdep)));
      $("#main").querySelectorAll("[data-delfile]").forEach((b) => b.onclick = async () => {
        const fl = files.find((x) => x.id === b.dataset.delfile);
        if (!(await confirmBox("Delete file?", fl.title))) return;
        try { await sb.storage.from(BUCKET).remove([fl.file_path]); const { error } = await sb.from("employee_files").delete().eq("id", fl.id); if (error) throw error; render(); } catch (err) { fail(err); }
      });
    };
    return `
      <div class="page-head"><div><a href="#employees" class="small">← All employees</a><h1>${esc(empName(e))}</h1>
        <p>${[e.job_title, e.department, e.work_location].filter(Boolean).map(esc).join(" · ")}</p></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><label class="inline-label">Status</label><select id="empstatus" class="status-select ${e.status}">${Object.entries(EMP_STATUS).map(([k, v]) => `<option value="${k}" ${e.status === k ? "selected" : ""}>${v}</option>`).join("")}</select><button class="btn quiet" id="editemp">Edit profile</button></div></div>
      ${e.status === "onboarding" && done === tasks.length && tasks.length ? `<div class="notice" style="margin-bottom:14px">All onboarding tasks are complete — this employee will switch to <b>Active</b> automatically; use the Status menu if you want it now.</div>` : ""}

      <div class="card" style="margin-bottom:16px"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><h3>Onboarding & compliance <span class="pill ${done === tasks.length ? "ok" : "on"}">${done}/${tasks.length}</span></h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${done < tasks.length ? `<button class="btn sm ghost" id="allcomplete">✓ Mark all complete</button>` : `<button class="btn sm quiet" id="reopenall">Reopen all</button>`}<button class="btn sm quiet" id="addtask">＋ Add task</button></div></div>
        <table style="margin-top:8px"><tbody>${tasks.map((t) => { const late = t.due_date && t.due_date < today && !["complete", "na"].includes(t.status);
          return `<tr class="clickable" data-task="${t.id}"><td style="width:46%"><b>${esc(t.label)}</b>${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ""}${t.notes ? `<div class="small">${esc(t.notes)}</div>` : ""}</td>
            <td class="small ${late ? "late" : "muted"}">${t.due_date ? (late ? "Overdue · " : "Due ") + fmtDate(t.due_date) : ""}</td>
            <td>${t.signed_file_path ? `<button class="btn sm ghost" data-open="${t.signed_file_path}">✍ Signed copy</button>` : t.file_path ? `<button class="btn sm ghost" data-open="${t.file_path}">📄 ${esc(t.file_name || "File")}</button>` : t.template_doc ? `<button class="btn sm quiet" data-open="${t.template_doc.file_path}">📄 ${esc(t.template_doc.title)}</button>${t.requires_signature ? ` <button class="btn sm" data-sign="${t.id}">✍ Sign</button>` : ""}` : `<span class="small muted">No file</span>`}</td>
            <td style="text-align:right"><select data-tstatus="${t.id}" class="${t.status}" style="width:auto;padding:5px 8px">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}" ${t.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
              ${t.completed_at ? `<div class="small muted">${esc(t.completed_by?.full_name || "")} · ${fmtDate(t.completed_at)}</div>` : ""}</td></tr>`; }).join("")}</tbody></table>
        <p class="small muted" style="margin:10px 0 0">Click a task to upload a completed form, sign, or add a note. Set which document backs each task under <a href="#settings">Settings → Onboarding</a>.</p></div>

      <div class="two">
        <div class="card"><div class="card-head"><h3>Personal</h3><button class="editlink" data-editsec="personal">Edit</button></div>${field("Legal name", [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" "))}${field("Preferred name", e.preferred_name)}${field("Date of birth", fmtDate(e.date_of_birth))}${field("Gender", e.gender)}${field("Marital status", e.marital_status)}</div>
        <div class="card"><div class="card-head"><h3>Contact</h3><button class="editlink" data-editsec="contact">Edit</button></div>${field("Personal email", e.personal_email)}${field("Work email", e.work_email)}${field("Mobile", e.mobile_phone)}${field("Home phone", e.home_phone)}${field("Address", [e.address1, e.address2, [e.city, e.state].filter(Boolean).join(", "), e.zip].filter(Boolean).join(", "))}</div>
        <div class="card"><div class="card-head"><h3>Employment</h3><button class="editlink" data-editsec="employment">Edit</button></div>${field("Hire date", fmtDate(e.hire_date))}${field("Start date", fmtDate(e.start_date))}${field("Employee type", e.employee_type)}${field("FLSA class", e.flsa_class)}${field("Manager", e.manager ? e.manager.first_name + " " + e.manager.last_name : "")}${field("Pay", e.pay_type ? `${e.pay_type}${e.pay_rate != null ? " · " + money(e.pay_rate) + (e.pay_type === "Hourly" ? "/hr" : "/yr") : ""}${e.pay_frequency ? " · " + e.pay_frequency : ""}` : "")}${field("Scheduled hours", e.scheduled_hours ? e.scheduled_hours + " / week" : "")}${e.status === "terminated" ? field("Terminated", fmtDate(e.termination_date) + (e.termination_reason ? " · " + e.termination_reason : "")) : ""}</div>
        <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Emergency contacts</h3><button class="btn sm quiet" id="addcontact">＋ Add</button></div>
          ${contacts.length ? contacts.map((c) => `<div class="sub-row"><div><b>${esc(c.full_name)}</b> ${c.is_primary ? '<span class="pill on">Primary</span>' : ""}<div class="small muted">${[c.relationship, c.phone, c.alt_phone, c.email].filter(Boolean).map(esc).join(" · ")}</div></div><button class="btn sm quiet" data-editcontact="${c.id}">Edit</button></div>`).join("") : `<p class="small muted" style="margin-top:8px">None on file.</p>`}</div>
        <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Dependents</h3><button class="btn sm quiet" id="adddep">＋ Add</button></div>
          ${deps.length ? deps.map((c) => `<div class="sub-row"><div><b>${esc(c.full_name)}</b><div class="small muted">${[c.relationship, c.date_of_birth ? "DOB " + fmtDate(c.date_of_birth) : ""].filter(Boolean).map(esc).join(" · ")}</div></div><button class="btn sm quiet" data-editdep="${c.id}">Edit</button></div>`).join("") : `<p class="small muted" style="margin-top:8px">None on file.</p>`}</div>
        <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Documents</h3><button class="btn sm quiet" id="addfile">＋ Upload</button></div>
          ${files.length ? files.map((fl) => `<div class="sub-row"><div><b>${esc(fl.title)}</b><div class="small muted">${[fl.category, fmtDate(fl.created_at)].filter(Boolean).map(esc).join(" · ")}</div></div><div style="display:flex;gap:6px"><button class="btn sm ghost" data-open="${fl.file_path}">Open</button><button class="btn sm danger" data-delfile="${fl.id}">Delete</button></div></div>`).join("") : `<p class="small muted" style="margin-top:8px">Reviews, write-ups, certifications and other employee files.</p>`}</div>
        ${e.notes ? `<div class="card" style="grid-column:1/-1"><h3>Notes</h3><p style="white-space:pre-wrap;margin:8px 0 0">${esc(e.notes)}</p></div>` : ""}
      </div>`;
  }

  function taskModal(e, t = null) {
    const m = modal(`
      <div class="modal-head"><h3>${t ? esc(t.label) : "Add task"}</h3><button class="x" data-close>×</button></div>
      ${t && (t.template_doc_id || t.requires_signature) ? `<div class="signbox">${t.template_doc ? `<button type="button" class="btn sm ghost" id="opentpl">📄 Open ${esc(t.template_doc.title)}</button>` : `<span class="small muted">No template document set — pick one under Settings → Onboarding.</span>`}
        ${t.signed_at ? `<span class="pill ok">Signed by ${esc(t.signed_name || "")} · ${fmtDT(t.signed_at)}</span>${t.signed_file_path ? `<button type="button" class="btn sm quiet" id="opensigned">Open signed copy</button>` : ""}` : (t.requires_signature ? `<button type="button" class="btn sm" id="signnow">✍ Sign now</button>` : "")}</div>` : ""}
      <form id="f" novalidate>
        ${t ? "" : `<label>Task name</label><input type="text" name="label" required placeholder="e.g. Direct deposit form" /><label>Description</label><input type="text" name="description" />`}
        <div class="two"><div><label>Status</label><select name="status">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}" ${(t?.status || "pending") === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div><label>Due date</label><input type="date" name="due_date" value="${t?.due_date || ""}" /></div></div>
        <label>Completed form / file ${t?.file_path ? `<span class="muted">(replace — current: ${esc(t.file_name)})</span>` : ""}</label><input type="file" name="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" />
        <label>Notes</label><textarea name="notes">${esc(t?.notes || "")}</textarea>
        <div class="modal-foot">${t && t.task_key === "custom" ? `<button type="button" class="btn danger" id="del">Delete</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Save</button></div>
      </form>`);
    const f = m.el.querySelector("#f");
    const ot = m.el.querySelector("#opentpl"); if (ot) ot.onclick = () => openFile(t.template_doc.file_path);
    const osg = m.el.querySelector("#opensigned"); if (osg) osg.onclick = () => openFile(t.signed_file_path);
    const sn = m.el.querySelector("#signnow"); if (sn) sn.onclick = () => { m.close(); signModal(e, t); };
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); const file = f.file.files[0];
      const doneNow = ["complete", "na"].includes(d.status);
      const rec = { status: d.status, due_date: d.due_date || null, notes: d.notes.trim() || null,
        completed_at: doneNow ? (t?.completed_at || new Date().toISOString()) : null, completed_by: doneNow ? (t?.completed_by?.id || S.session.user.id) : null };
      if (file) { rec.file_path = await uploadFile(file, "employees/" + e.id); rec.file_name = file.name; if (!doneNow && d.status === "pending") rec.status = "in_progress"; }
      if (t) { const { error } = await sb.from("employee_tasks").update(rec).eq("id", t.id); if (error) throw error; if (file && t.file_path) await sb.storage.from(BUCKET).remove([t.file_path]); }
      else { if (!d.label.trim()) throw new Error("Task name is required."); const { error } = await sb.from("employee_tasks").insert({ ...rec, org_id: S.org.id, employee_id: e.id, task_key: "custom", label: d.label.trim(), description: d.description.trim() || null, sort_order: 900 }); if (error) throw error; }
      await log("employee", e.id, "task_updated", { name: empName(e), task: t?.label || d.label }); m.close(); toast("Saved"); render();
    }); };
    const del = m.el.querySelector("#del");
    if (del) del.onclick = async () => { if (!(await confirmBox("Delete task?", t.label))) return; try { if (t.file_path) await sb.storage.from(BUCKET).remove([t.file_path]); const { error } = await sb.from("employee_tasks").delete().eq("id", t.id); if (error) throw error; m.close(); render(); } catch (err) { fail(err); } };
  }
  function contactModal(e, c = null) {
    const m = modal(`<div class="modal-head"><h3>${c ? "Edit" : "Add"} emergency contact</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate><label>Full name *</label><input type="text" name="full_name" value="${esc(c?.full_name || "")}" />
        <div class="two"><div><label>Relationship</label>${SEL("relationship", ["Spouse", "Partner", "Parent", "Child", "Sibling", "Friend", "Other"], c?.relationship)}</div>${INP("Phone", "phone", c?.phone, "tel")}</div>
        <div class="two">${INP("Alternate phone", "alt_phone", c?.alt_phone, "tel")}${INP("Email", "email", c?.email, "email")}</div>
        <label class="check"><input type="checkbox" name="is_primary" ${c?.is_primary ? "checked" : ""} /> Primary contact</label>
        <div class="modal-foot">${c ? `<button type="button" class="btn danger" id="del">Remove</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Save</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); if (!d.full_name.trim()) throw new Error("Name is required.");
      const rec = { full_name: d.full_name.trim(), relationship: d.relationship || null, phone: d.phone.trim() || null, alt_phone: d.alt_phone.trim() || null, email: d.email.trim() || null, is_primary: !!d.is_primary };
      if (rec.is_primary) await sb.from("emergency_contacts").update({ is_primary: false }).eq("employee_id", e.id);
      const q = c ? sb.from("emergency_contacts").update(rec).eq("id", c.id) : sb.from("emergency_contacts").insert({ ...rec, org_id: S.org.id, employee_id: e.id });
      const { error } = await q; if (error) throw error; m.close(); render();
    }); };
    const del = m.el.querySelector("#del"); if (del) del.onclick = async () => { const { error } = await sb.from("emergency_contacts").delete().eq("id", c.id); if (error) fail(error); m.close(); render(); };
  }
  function dependentModal(e, c = null) {
    const m = modal(`<div class="modal-head"><h3>${c ? "Edit" : "Add"} dependent</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate><label>Full name *</label><input type="text" name="full_name" value="${esc(c?.full_name || "")}" />
        <div class="two"><div><label>Relationship</label>${SEL("relationship", ["Spouse", "Domestic partner", "Child", "Stepchild", "Other"], c?.relationship)}</div>${INP("Date of birth", "date_of_birth", c?.date_of_birth, "date")}</div>
        <div class="modal-foot">${c ? `<button type="button" class="btn danger" id="del">Remove</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Save</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); if (!d.full_name.trim()) throw new Error("Name is required.");
      const rec = { full_name: d.full_name.trim(), relationship: d.relationship || null, date_of_birth: d.date_of_birth || null };
      const q = c ? sb.from("dependents").update(rec).eq("id", c.id) : sb.from("dependents").insert({ ...rec, org_id: S.org.id, employee_id: e.id });
      const { error } = await q; if (error) throw error; m.close(); render();
    }); };
    const del = m.el.querySelector("#del"); if (del) del.onclick = async () => { const { error } = await sb.from("dependents").delete().eq("id", c.id); if (error) fail(error); m.close(); render(); };
  }
  function empFileModal(e) {
    const m = modal(`<div class="modal-head"><h3>Upload employee document</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate><label>Title *</label><input type="text" name="title" placeholder="e.g. 2026 performance review" />
        <label>Category</label>${SEL("category", ["Review", "Disciplinary", "Certification", "Benefits", "Offer letter", "Separation", "Other"], null, "Select…")}
        <label>File *</label><input type="file" name="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt" />
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Upload</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); const file = f.file.files[0];
      if (!d.title.trim()) throw new Error("Title is required."); if (!file) throw new Error("Choose a file.");
      const path = await uploadFile(file, "employees/" + e.id);
      const { error } = await sb.from("employee_files").insert({ org_id: S.org.id, employee_id: e.id, title: d.title.trim(), category: d.category || null, file_path: path, file_name: file.name, uploaded_by: S.session.user.id }); if (error) throw error;
      await log("employee", e.id, "file_added", { name: empName(e), title: d.title.trim() }); m.close(); toast("Uploaded"); render();
    }); };
  }

  // ------------------------------------------------------------ PEOPLE (members & invites)
  async function viewPeople() {
    const [{ data: mems, error }, { data: invs }] = await Promise.all([
      sb.from("memberships").select("*, profile:user_id(full_name,email)").eq("org_id", S.org.id).order("created_at"),
      sb.from("invites").select("*").eq("org_id", S.org.id).is("accepted_at", null).order("created_at"),
    ]);
    if (error) throw error;
    window.__afterRender = () => {
      $("#invite").onclick = () => inviteModal();
      $("#main").querySelectorAll("[data-role]").forEach((sel) => sel.onchange = async () => {
        try { const { error } = await sb.from("memberships").update({ role: sel.value }).eq("id", sel.dataset.role); if (error) throw error; toast("Role updated"); } catch (e) { fail(e); render(); }
      });
      $("#main").querySelectorAll("[data-rm]").forEach((b) => b.onclick = async () => {
        const mm = mems.find((x) => x.id === b.dataset.rm);
        if (!(await confirmBox("Remove access?", `${mm.profile?.email} will no longer be able to sign in to ${S.org.name}.`, "Remove"))) return;
        try { const { error } = await sb.from("memberships").delete().eq("id", mm.id); if (error) throw error; await log("membership", mm.user_id, "removed", { email: mm.profile?.email }); render(); } catch (e) { fail(e); }
      });
      $("#main").querySelectorAll("[data-resend]").forEach((b) => b.onclick = () => busy(b, async () => {
        const { error } = await sb.auth.signInWithOtp({ email: b.dataset.resend, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } }); if (error) throw error; toast("Sign-in link re-sent");
      }));
      $("#main").querySelectorAll("[data-rminv]").forEach((b) => b.onclick = async () => {
        try { const { error } = await sb.from("invites").delete().eq("id", b.dataset.rminv); if (error) throw error; render(); } catch (e) { fail(e); }
      });
    };
    const me = S.session.user.id;
    return `
      <div class="page-head"><div><h1>People</h1><p>Who can sign in, and what they can see.</p></div><button class="btn" id="invite">＋ Invite someone</button></div>
      <div class="card" style="margin-bottom:14px"><table><thead><tr><th>Name</th><th>Email</th><th>Access</th><th></th></tr></thead><tbody>
        ${mems.map((m) => `<tr><td><b>${esc(m.profile?.full_name || "—")}</b>${m.user_id === me ? ' <span class="pill">you</span>' : ""}</td><td class="muted">${esc(m.profile?.email || "")}</td>
          <td>${m.user_id === me && !isSuper() ? `<span class="pill on">Owner</span>` : `<select data-role="${m.id}" style="width:auto;padding:5px 8px">${["owner", "staff", "employee"].map((r) => `<option value="${r}" ${(m.role === r || (r === "owner" && m.role === "admin") || (r === "employee" && m.role === "member")) ? "selected" : ""}>${ROLE[r].label}</option>`).join("")}</select>`}</td>
          <td style="text-align:right">${m.user_id === me && !isSuper() ? "" : `<button class="btn sm danger" data-rm="${m.id}">Remove</button>`}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No members yet.</td></tr>`}
      </tbody></table></div>
      <h3 style="margin:18px 0 8px">Pending invitations</h3>
      <div class="card">${(invs || []).length ? `<table><tbody>${invs.map((i) => `<tr><td>${esc(i.email)}</td><td><span class="pill">${roleLabel(i.role)}</span></td><td class="muted small">Invited ${fmtDate(i.created_at)}</td><td style="text-align:right"><button class="btn sm quiet" data-resend="${esc(i.email)}">Resend</button> <button class="btn sm quiet" data-rminv="${i.id}">Cancel</button></td></tr>`).join("")}</tbody></table>`
        : `<span class="muted small">No pending invitations. Invited people receive a sign-in link by email and get access the moment they use it.</span>`}</div>
      ${rolesExplainer()}`;
  }
  function rolesExplainer() {
    return `<div class="roles"><div class="eyebrow" style="margin-bottom:8px">Who sees what</div><div class="roles-grid">${["super", "owner", "staff", "employee"].map((r) => `<div class="role ${effRole() === r ? "me" : ""}"><b>${ROLE[r].label}${effRole() === r ? ' <span class="pill on">you</span>' : ""}</b><p>${ROLE[r].blurb}</p></div>`).join("")}</div></div>`;
  }
  function inviteModal() {
    const m = modal(`
      <div class="modal-head"><h3>Invite to ${esc(S.org.name)}</h3><button class="x" data-close>×</button></div>
      <form id="f"><label>Email address</label><input type="email" name="email" required />
        <label>Access level</label><select name="role"><option value="owner">Owner — full workspace, invites users, company settings</option><option value="staff" selected>Staff — employees, hiring, tasks, all documents</option><option value="employee">Employee — self-service: own profile, shared documents, Ask JHM</option></select>
        <p class="small muted" style="margin-top:12px">They'll get an email with a secure sign-in link. On first sign-in they set their name and password. If they already have an account, access is granted immediately.</p>
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Invite</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      const email = d.email.trim().toLowerCase();
      const { data: inv, error } = await sb.from("invites").upsert({ org_id: S.org.id, email, role: d.role, invited_by: S.session.user.id }, { onConflict: "org_id,email" }).select().single(); if (error) throw error;
      await log("membership", null, "invited", { email, role: d.role });
      if (inv.accepted_at) { m.close(); toast("They already had an account — access granted"); render(); return; }
      // send a sign-in link; the account is created when they click it and access is granted automatically
      const { error: mailErr } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname, data: { invited_to: S.org.name } } });
      m.close(); render();
      if (mailErr) toast("Invite saved, but the email could not be sent: " + mailErr.message, true); else toast("Invitation email sent to " + email);
    }); };
  }

  // ------------------------------------------------------------ ADMIN (super: manage clients)
  async function viewAdmin() {
    const { data: orgs, error } = await sb.from("organizations").select("*, memberships(count), documents(count), job_orders(count)").order("name");
    if (error) throw error;
    window.__afterRender = () => {
      $("#neworg").onclick = () => orgModal();
      $("#main").querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => orgModal(orgs.find((o) => o.id === b.dataset.edit)));
      $("#main").querySelectorAll("[data-enter]").forEach((b) => b.onclick = async () => { await loadContext(); await switchOrg(b.dataset.enter); });
    };
    return `
      <div class="page-head"><div><h1>Clients</h1><p>Every company workspace in the portal. Enter one to manage its documents, hiring and people.</p></div><button class="btn" id="neworg">＋ New client</button></div>
      <div class="grid">${orgs.map((o) => `<div class="card"><div style="display:flex;gap:12px;align-items:center"><div class="icon" style="background:${esc(o.accent || "#23305a")};color:#fff">${esc(initials(o.name))}</div><div class="grow"><h3>${esc(o.name)}</h3><div class="small muted">${o.memberships?.[0]?.count ?? 0} users · ${o.documents?.[0]?.count ?? 0} docs · ${o.job_orders?.[0]?.count ?? 0} job orders</div></div></div>
        <div class="modpills">${["documents", "employees", "hiring", "tasks", "requests"].map((k) => `<span class="pill ${(Object.assign({ documents: true, employees: true, hiring: true, tasks: true, requests: true }, o.modules || {}))[k] ? "on" : "off"}">${k[0].toUpperCase() + k.slice(1)}</span>`).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:14px"><button class="btn sm" data-enter="${o.id}">Enter workspace</button><button class="btn sm quiet" data-edit="${o.id}">Settings</button></div></div>`).join("")
        || `<div class="empty" style="grid-column:1/-1"><h3>No clients yet</h3><p>Create your first client workspace, then invite their owner as an admin.</p></div>`}</div>`;
  }
  function orgModal(o = null) {
    const m = modal(`
      <div class="modal-head"><h3>${o ? "Client settings" : "New client"}</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate><label>Company name</label><input type="text" name="company_name" required value="${esc(o?.name || "")}" placeholder="e.g. White House Custom Apparel & Graphics" />
        <div class="two"><div><label>Accent color</label><input type="text" name="accent" value="${esc(o?.accent || "#23305a")}" placeholder="#23305a" /></div>
        <div><label>Logo ${o?.logo_path ? "<span class='muted'>(replace)</span>" : ""}</label><input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml" /></div></div>
        <h4 class="sec">Modules</h4><p class="small muted" style="margin:6px 0 4px">Switch on what this client needs. Hidden modules disappear from their workspace entirely.</p>
        <div class="modgrid">${[["documents", "Documents", "Handbook, policies, benefits, forms"], ["employees", "Employees", "HRIS records, onboarding checklists, self-service profiles"], ["hiring", "Hiring", "Job orders, candidates, resumes"], ["tasks", "Tasks", "Cross-employee compliance task list"], ["requests", "Requests", "Ask JHM contact form and inbox"]].map(([k, t, d]) => { const cur = Object.assign({ documents: true, employees: true, hiring: true, tasks: true, requests: true }, o?.modules || {}); return `<label class="mod"><input type="checkbox" name="mod_${k}" ${cur[k] ? "checked" : ""} /><span><b>${t}</b><small>${d}</small></span></label>`; }).join("")}</div>
        <div class="modal-foot">${o ? `<button type="button" class="btn danger" id="del">Delete client</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${o ? "Save" : "Create"}</button></div></form>`, { wide: true });
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); const logo = f.logo.files[0];
      const name = (d.company_name || "").trim();
      if (!name) throw new Error("Please enter the company name.");
      const modules = Object.fromEntries(["documents", "employees", "hiring", "tasks", "requests"].map((k) => [k, !!d["mod_" + k]]));
      const rec = { name, modules, accent: /^#[0-9a-fA-F]{6}$/.test((d.accent || "").trim()) ? d.accent.trim() : "#23305a" };
      let orgId = o?.id;
      if (o) { const { error } = await sb.from("organizations").update(rec).eq("id", o.id); if (error) throw error; }
      else {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
        let slug = base, attempt = 0, data, error;
        do {
          ({ data, error } = await sb.from("organizations").insert({ ...rec, slug }).select().single());
          if (error && error.code === "23505") { attempt++; slug = `${base}-${Math.random().toString(36).slice(2, 6)}`; } else break;
        } while (attempt < 3);
        if (error) throw error; orgId = data.id;
      }
      if (logo) {
        const path = `${orgId}/branding/logo-${Date.now()}.${logo.name.split(".").pop()}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, logo, { contentType: logo.type }); if (error) throw error;
        await sb.from("organizations").update({ logo_path: path }).eq("id", orgId);
        if (o?.logo_path) await sb.storage.from(BUCKET).remove([o.logo_path]);
      }
      m.close(); toast("Saved"); await loadContext(); if (!o) await switchOrg(orgId); else render();
    }); };
    const del = m.el.querySelector("#del");
    if (del) del.onclick = async () => {
      if (!(await confirmBox("Delete this client?", `Everything for ${o.name} — documents, hiring, users — is permanently deleted. Files in storage must be cleared separately.`))) return;
      try { const { error } = await sb.from("organizations").delete().eq("id", o.id); if (error) throw error; m.close(); try { localStorage.removeItem("hhg.org"); } catch {} await loadContext(); location.hash = "#admin"; render(); } catch (e) { fail(e); }
    };
  }

  // ------------------------------------------------------------ REQUESTS (Ask JHM)
  const REQ_CATS = ["General question", "Document request", "New hire / onboarding", "Employee issue", "Policy / handbook", "Hiring help", "Compliance", "Portal access", "Other"];
  const REQ_STATUS = { new: "New", in_progress: "In progress", resolved: "Resolved" };
  let reqFilter = "open";
  function requestModal() {
    const m = modal(`<div class="modal-head"><h3>Ask JHM</h3><button class="x" data-close>×</button></div>
      <p class="small muted">Send a question or request to your HR consultant. You'll see the reply here in the portal under <b>Requests</b>.</p>
      <form id="f" novalidate>
        <div class="two"><div><label>Topic</label><select name="category">${REQ_CATS.map((c) => `<option>${c}</option>`).join("")}</select></div>
        <div><label>Urgency</label><select name="urgency"><option>Low</option><option selected>Normal</option><option>Urgent</option></select></div></div>
        <label>Subject *</label><input type="text" name="subject" placeholder="One line summary" />
        <label>Details *</label><textarea name="body" style="min-height:130px" placeholder="What do you need? Include names, dates and anything that helps."></textarea>
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Send request</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      if (!d.subject.trim() || !d.body.trim()) throw new Error("Subject and details are required.");
      const { error } = await sb.from("requests").insert({ org_id: S.org.id, user_id: S.session.user.id, category: d.category, urgency: d.urgency, subject: d.subject.trim(), body: d.body.trim() }); if (error) throw error;
      await log("request", null, "created", { subject: d.subject.trim() }); m.close(); toast("Request sent to JHM"); if ((location.hash || "").startsWith("#requests")) render();
    }); };
  }
  async function viewRequests() {
    let q = sb.from("requests").select("*, profile:user_id(full_name,email), organizations(name)").order("created_at", { ascending: false });
    if (S.org) q = q.eq("org_id", S.org.id);
    const { data: reqs, error } = await q; if (error) throw error;
    const list = reqs.filter((r) => reqFilter === "all" || (reqFilter === "open" ? r.status !== "resolved" : r.status === reqFilter));
    const mineOnly = S.org && !isStaff();
    window.__afterRender = () => {
      const nb = $("#newreq"); if (nb) nb.onclick = () => requestModal();
      $("#main").querySelectorAll(".chip").forEach((c) => c.onclick = () => { reqFilter = c.dataset.c; render(); });
      $("#main").querySelectorAll("[data-req]").forEach((el) => el.onclick = () => requestDetail(reqs.find((r) => r.id === el.dataset.req)));
    };
    return `
      <div class="page-head"><div><h1>${S.org ? "Ask JHM" : "Client requests"}</h1><p>${S.org ? (mineOnly ? "Your questions to JHM Consulting, and the answers. Nothing here is visible to other employees." : "Questions " + esc(S.org.name) + " has sent to JHM Consulting, and the replies.") : "Inbox across all clients."}</p></div>
        ${S.org ? `<button class="btn" id="newreq">＋ New question</button>` : ""}</div>
      <div class="filters">${[["open", "Open"], ["in_progress", "In progress"], ["resolved", "Resolved"], ["all", "All"]].map(([k, v]) => `<button class="chip ${reqFilter === k ? "active" : ""}" data-c="${k}">${v}</button>`).join("")}</div>
      <div class="list">${list.length ? list.map((r) => `<div class="row" data-req="${r.id}" style="cursor:pointer"><div class="icon ${r.urgency === "Urgent" ? "urgent" : ""}">${r.urgency === "Urgent" ? "!" : "✉"}</div>
        <div class="grow"><div class="title">${esc(r.subject)}</div><div class="meta">${!S.org ? `<span><b>${esc(r.organizations?.name || "")}</b></span>` : ""}<span>${esc(r.profile?.full_name || r.profile?.email || "")}</span><span>${esc(r.category)}</span><span>${fmtDT(r.created_at)}</span>${r.response ? `<span>· Replied</span>` : ""}</div></div>
        <div class="actions"><span class="pill ${r.status === "new" ? "warn" : r.status === "resolved" ? "" : "on"}">${REQ_STATUS[r.status]}</span></div></div>`).join("")
        : `<div class="empty"><h3>No requests ${reqFilter === "all" ? "yet" : "here"}</h3><p>${S.org ? "Use Ask JHM to send a question — replies show up here." : "Client questions land here when they use Ask JHM."}</p></div>`}</div>`;
  }
  function requestDetail(r) {
    const m = modal(`<div class="modal-head"><h3>${esc(r.subject)}</h3><button class="x" data-close>×</button></div>
      <div class="meta small muted" style="display:flex;gap:10px;flex-wrap:wrap">${[r.organizations?.name, r.profile?.full_name || r.profile?.email, r.category, r.urgency + " urgency", fmtDT(r.created_at)].filter(Boolean).map(esc).join(" · ")}</div>
      <div class="card" style="margin:14px 0;white-space:pre-wrap">${esc(r.body)}</div>
      ${r.response ? `<h3 style="font-size:15px">Reply from JHM</h3><div class="card reply" style="white-space:pre-wrap;margin-top:6px">${esc(r.response)}<div class="small muted" style="margin-top:8px">${fmtDT(r.responded_at)}</div></div>` : (isRealSuper() ? "" : `<p class="small muted">No reply yet.</p>`)}
      ${isRealSuper() ? `<form id="f" novalidate style="margin-top:14px"><label>${r.response ? "Update reply" : "Reply"}</label><textarea name="response">${esc(r.response || "")}</textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap"><select name="status" style="width:auto">${Object.entries(REQ_STATUS).map(([k, v]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${v}</option>`).join("")}</select><span class="spacer"></span><button type="button" class="btn danger sm" id="del">Delete</button><button class="btn" id="save">Save</button></div></form>` : ""}`, { wide: true });
    const f = m.el.querySelector("#f");
    if (f) {
      f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
        const d = Object.fromEntries(new FormData(f)); const resp = d.response.trim() || null;
        const upd = { status: d.status, response: resp, responded_at: resp && resp !== r.response ? new Date().toISOString() : (resp ? r.responded_at : null) };
        const { error } = await sb.from("requests").update(upd).eq("id", r.id); if (error) throw error; m.close(); toast("Saved"); render();
      }); };
      m.el.querySelector("#del").onclick = async () => { if (!(await confirmBox("Delete request?", r.subject))) return; const { error } = await sb.from("requests").delete().eq("id", r.id); if (error) fail(error); m.close(); render(); };
    }
  }

  // ------------------------------------------------------------ HOME
  async function viewHome() {
    const today = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
    const soon = iso(new Date(today.getTime() + 7 * 864e5)), t0 = iso(today);
    const first = (S.profile.full_name || "").split(" ")[0];
    const hour = today.getHours(); const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    if (!isStaff()) {
      const [{ data: docs }, { data: reqs }] = await Promise.all([
        sb.from("documents").select("id,title,category,file_path,updated_at").eq("org_id", S.org.id).order("updated_at", { ascending: false }).limit(6),
        sb.from("requests").select("id,subject,status,created_at").eq("org_id", S.org.id).eq("user_id", S.session.user.id).order("created_at", { ascending: false }).limit(5),
      ]);
      window.__afterRender = () => { $("#main").querySelectorAll("[data-open]").forEach((b) => b.onclick = () => openFile(b.dataset.open)); const a = $("#ask"); if (a) a.onclick = () => requestModal(); const a2 = $("#ask2"); if (a2) a2.onclick = () => requestModal(); };
      return `<div class="hero"><h1>${greet}${first ? ", " + esc(first) : ""}.</h1><p>Your profile, your company's HR documents, and a direct line to your HR consultant.</p></div>
        ${mods().employees ? `<div class="quick"><a class="btn sm" href="#me">My profile</a><a class="btn sm quiet" href="#docs">Documents</a><button class="btn sm quiet" id="ask2">Ask JHM</button></div>` : ""}
        <div class="two"><div class="card"><h3>Recent documents</h3>${(docs || []).length ? docs.map((d) => `<div class="sub-row"><div><b>${esc(d.title)}</b><div class="small muted">${CATS[d.category]} · ${fmtDate(d.updated_at)}</div></div><button class="btn sm ghost" data-open="${d.file_path}">Open</button></div>`).join("") : `<p class="small muted" style="margin-top:8px">Nothing shared yet.</p>`}<a href="#docs" class="small" style="display:inline-block;margin-top:10px">All documents →</a></div>
        <div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h3>Your requests</h3><button class="btn sm" id="ask">Ask JHM</button></div>${(reqs || []).length ? reqs.map((r) => `<div class="sub-row"><div><b>${esc(r.subject)}</b><div class="small muted">${fmtDate(r.created_at)}</div></div><span class="pill ${r.status === "resolved" ? "" : "on"}">${REQ_STATUS[r.status]}</span></div>`).join("") : `<p class="small muted" style="margin-top:8px">No questions yet.</p>`}</div></div>`;
    }
    const [{ data: emps }, { data: jobs }, { data: tasks }, { data: reqs }, { data: acts }, { data: docs }] = await Promise.all([
      sb.from("employees").select("id,status").eq("org_id", S.org.id),
      sb.from("job_orders").select("id,title,status,candidates(stage)").eq("org_id", S.org.id).in("status", ["open", "on_hold"]),
      sb.from("employee_tasks").select("id,label,due_date,status,employee_id,employees(first_name,last_name,preferred_name)").eq("org_id", S.org.id).in("status", ["pending", "in_progress"]).not("due_date", "is", null).lte("due_date", soon).order("due_date").limit(12),
      sb.from("requests").select("id,subject,status,urgency,created_at").eq("org_id", S.org.id).neq("status", "resolved").order("created_at", { ascending: false }).limit(5),
      sb.from("activity_log").select("*, actor:actor_id(full_name)").eq("org_id", S.org.id).order("created_at", { ascending: false }).limit(8),
      sb.from("documents").select("id", { count: "exact", head: true }).eq("org_id", S.org.id),
    ]);
    const E = emps || [], J = jobs || [], T = tasks || [], R = reqs || [];
    const overdue = T.filter((t) => t.due_date < t0);
    const activeCands = J.reduce((n, j) => n + j.candidates.filter((c) => !["hired", "passed"].includes(c.stage)).length, 0);
    window.__afterRender = () => {
      $("#main").querySelectorAll("[data-act]").forEach((b) => b.onclick = () => ({ emp: () => employeeModal(), doc: () => docModal(), job: () => jobModal(), inv: () => inviteModal(), ask: () => requestModal(), srch: () => openSearch() })[b.dataset.act]());
      $("#main").querySelectorAll("[data-req]").forEach((el) => el.onclick = () => requestDetail(R.find((r) => r.id === el.dataset.req)));
    };
    const tile = (n, l, h, warn) => `<a href="${h}" class="tile ${warn && n ? "warn" : ""}"><b>${n}</b><span>${l}</span></a>`;
    return `
      <div class="hero"><div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div><h1>${greet}${first ? ", " + esc(first) : ""}.</h1>
        <p>${overdue.length ? `<b class="late">${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}</b> need attention.` : T.length ? `${T.length} task${T.length > 1 ? "s" : ""} due in the next week.` : "Everything is on schedule."}${R.length ? ` ${R.length} open request${R.length > 1 ? "s" : ""}.` : ""}</p></div>
      <div class="tiles">${tile(E.filter((e) => e.status === "active").length, "Active employees", "#employees")}${tile(E.filter((e) => e.status === "onboarding").length, "Onboarding", "#employees", true)}${tile(J.length, "Open positions", "#hiring")}${tile(activeCands, "Active candidates", "#hiring")}${tile(overdue.length, "Overdue tasks", "#tasks", true)}${tile(R.length, "Open questions", "#requests", true)}</div>
      <div class="quick"><span class="eyebrow">Quick actions</span><button class="btn sm" data-act="emp">＋ Employee</button><button class="btn sm quiet" data-act="job">＋ Job order</button><button class="btn sm quiet" data-act="doc">↑ Upload document</button><button class="btn sm quiet" data-act="inv">Invite user</button><button class="btn sm quiet" data-act="ask">Ask JHM a question</button><button class="btn sm quiet" data-act="srch">⌕ Search</button></div>
      <div class="two" style="align-items:start">
        <div class="card"><div class="card-head"><h3>Needs attention</h3><a href="#tasks" class="small">All tasks →</a></div>
          ${T.length ? T.map((t) => { const late = t.due_date < t0; const e = t.employees || {}; return `<a class="sub-row link" href="#employees/${t.employee_id}"><div><b>${esc(t.label)}</b><div class="small muted">${esc((e.preferred_name || e.first_name || "") + " " + (e.last_name || ""))}</div></div><span class="small ${late ? "late" : "muted"}">${late ? "Overdue · " : "Due "}${fmtDate(t.due_date)}</span></a>`; }).join("") : `<p class="small muted" style="margin-top:8px">Nothing due in the next 7 days.</p>`}</div>
        <div class="card"><div class="card-head"><h3>Open questions for JHM</h3><a href="#requests" class="small">All →</a></div>
          ${R.length ? R.map((r) => `<div class="sub-row link" data-req="${r.id}"><div><b>${esc(r.subject)}</b><div class="small muted">${fmtDT(r.created_at)}${r.urgency === "Urgent" ? ' · <span class="late">Urgent</span>' : ""}</div></div><span class="pill ${r.status === "new" ? "warn" : "on"}">${REQ_STATUS[r.status]}</span></div>`).join("") : `<p class="small muted" style="margin-top:8px">No open requests.</p>`}</div>
        <div class="card" style="grid-column:1/-1"><div class="card-head"><h3>Recent activity</h3></div>
          ${(acts || []).length ? acts.map((a) => `<div class="act"><time>${fmtDT(a.created_at)}</time><b>${esc(a.actor?.full_name || "Someone")}</b> ${esc(actAny(a))}</div>`).join("") : `<p class="small muted">No activity yet.</p>`}</div>
      </div>`;
  }
  function actAny(a) {
    const d = a.detail || {};
    if (a.entity_type === "job_order" || a.entity_type === "candidate") return actText(a);
    if (a.entity_type === "document") return `${a.action} document${d.title ? ` "${d.title}"` : ""}`;
    if (a.entity_type === "employee") { if (a.action.startsWith("status_")) return `set ${d.name} to ${EMP_STATUS[a.action.slice(7)] || a.action.slice(7)}`; if (a.action === "task_signed") return `signed "${d.task}" for ${d.name} (${d.signer})`; if (a.action.startsWith("task_")) return `${a.action === "task_complete" ? "completed" : a.action === "task_na" ? "marked N/A" : "updated"} "${d.task}" for ${d.name}`; if (a.action === "file_added") return `added "${d.title}" to ${d.name}'s file`; return `${a.action} employee ${d.name || ""}`; }
    if (a.entity_type === "membership") return a.action === "invited" ? `invited ${d.email} as ${d.role}` : `${a.action} ${d.email || "a user"}`;
    if (a.entity_type === "request") return `sent a request: "${d.subject}"`;
    return `${a.action} ${a.entity_type}`;
  }

  // ------------------------------------------------------------ MY PROFILE (employee self-service)
  async function viewMyProfile() {
    const { data: e } = await sb.from("employees").select("*, manager:manager_id(first_name,last_name)").eq("org_id", S.org.id).eq("user_id", S.session.user.id).maybeSingle();
    if (!e) return `<div class="hero"><h1>My profile</h1></div><div class="empty"><h3>Your employee record isn't linked yet</h3><p>Your administrator adds your record and links it to <b>${esc(S.profile.email)}</b>. Until then, your documents and Ask JHM are available from the sidebar.</p></div>`;
    const rs = await Promise.all([
      sb.from("employee_tasks").select("*, template_doc:template_doc_id(id,title,file_path,file_name,mime_type)").eq("employee_id", e.id).order("sort_order"),
      sb.from("emergency_contacts").select("*").eq("employee_id", e.id).order("is_primary", { ascending: false }),
      sb.from("dependents").select("*").eq("employee_id", e.id).order("date_of_birth"),
    ]);
    const badq = rs.find((r) => r.error); if (badq) throw new Error(badq.error.message);
    const tasks = rs[0].data || [], contacts = rs[1].data || [], deps = rs[2].data || [];
    const field = (l, v) => `<div class="fld"><span>${l}</span><b>${v ? esc(v) : "<span class='muted'>—</span>"}</b></div>`;
    const done = (tasks || []).filter((t) => ["complete", "na"].includes(t.status)).length;
    window.__afterRender = () => {
      $("#addcontact").onclick = () => contactModal(e);
      $("#adddep").onclick = () => dependentModal(e);
      $("#main").querySelectorAll("[data-editcontact]").forEach((b) => b.onclick = () => contactModal(e, contacts.find((c) => c.id === b.dataset.editcontact)));
      $("#main").querySelectorAll("[data-editdep]").forEach((b) => b.onclick = () => dependentModal(e, deps.find((c) => c.id === b.dataset.editdep)));
      const a = $("#askchange"); if (a) a.onclick = () => requestModal();
      $("#main").querySelectorAll("[data-open]").forEach((b) => b.onclick = () => openFile(b.dataset.open));
      $("#main").querySelectorAll("[data-sign]").forEach((b) => b.onclick = () => signModal(e, (tasks || []).find((t) => t.id === b.dataset.sign)));
    };
    return `
      <div class="hero"><div class="eyebrow">${EMP_STATUS[e.status]}</div><h1>${esc(empName(e))}</h1><p>${[e.job_title, e.department, e.work_location].filter(Boolean).map(esc).join(" · ") || "Your employee profile."}</p></div>
      <div class="two" style="align-items:start">
        <div class="card"><h3>Personal</h3>${field("Legal name", [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(" "))}${field("Preferred name", e.preferred_name)}${field("Date of birth", fmtDate(e.date_of_birth))}<p class="small muted" style="margin:10px 0 0">Need something corrected? <a href="#" id="askchange">Ask JHM</a>.</p></div>
        <div class="card"><h3>Contact</h3>${field("Personal email", e.personal_email)}${field("Work email", e.work_email)}${field("Mobile", e.mobile_phone)}${field("Address", [e.address1, e.address2, [e.city, e.state].filter(Boolean).join(", "), e.zip].filter(Boolean).join(", "))}</div>
        <div class="card"><h3>Employment</h3>${field("Start date", fmtDate(e.start_date))}${field("Employee type", e.employee_type)}${field("Manager", e.manager ? e.manager.first_name + " " + e.manager.last_name : "")}${field("Scheduled hours", e.scheduled_hours ? e.scheduled_hours + " / week" : "")}</div>
        <div class="card" style="grid-column:1/-1"><h3>Onboarding <span class="pill ${done === (tasks || []).length ? "ok" : "on"}">${done}/${(tasks || []).length}</span></h3>
          ${(tasks || []).map((t) => { const d = ["complete", "na"].includes(t.status); return `<div class="sub-row"><div><b>${esc(t.label)}</b>${t.description ? `<div class="small muted">${esc(t.description)}</div>` : ""}${t.signed_at ? `<div class="small ok-text">Signed ${fmtDT(t.signed_at)}</div>` : ""}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${t.signed_file_path ? `<button class="btn sm quiet" data-open="${t.signed_file_path}">Signed copy</button>` : t.template_doc ? `<button class="btn sm quiet" data-open="${t.template_doc.file_path}">📄 Review</button>` : ""}${t.requires_signature && !t.signed_at && t.template_doc ? `<button class="btn sm" data-sign="${t.id}">✍ Sign</button>` : `<span class="pill ${d ? "ok" : t.status === "in_progress" ? "on" : ""}">${TASK_STATUS[t.status]}</span>`}</div></div>`; }).join("") || `<p class="small muted">No items.</p>`}</div>
        <div class="card"><div class="card-head"><h3>Emergency contacts</h3><button class="btn sm quiet" id="addcontact">＋ Add</button></div>
          ${(contacts || []).length ? contacts.map((c) => `<div class="sub-row"><div><b>${esc(c.full_name)}</b> ${c.is_primary ? '<span class="pill on">Primary</span>' : ""}<div class="small muted">${[c.relationship, c.phone, c.email].filter(Boolean).map(esc).join(" · ")}</div></div><button class="btn sm quiet" data-editcontact="${c.id}">Edit</button></div>`).join("") : `<p class="small muted" style="margin-top:8px">Add someone we can reach in an emergency.</p>`}</div>
        <div class="card"><div class="card-head"><h3>Dependents</h3><button class="btn sm quiet" id="adddep">＋ Add</button></div>
          ${(deps || []).length ? deps.map((c) => `<div class="sub-row"><div><b>${esc(c.full_name)}</b><div class="small muted">${[c.relationship, c.date_of_birth ? "DOB " + fmtDate(c.date_of_birth) : ""].filter(Boolean).map(esc).join(" · ")}</div></div><button class="btn sm quiet" data-editdep="${c.id}">Edit</button></div>`).join("") : `<p class="small muted" style="margin-top:8px">For benefits enrollment.</p>`}</div>
      </div>`;
  }

  // ------------------------------------------------------------ ORG CHART + DIRECTORY
  let dirSearch = "";
  async function viewOrgChart() {
    const { data: people, error } = await sb.from("directory").select("*").eq("org_id", S.org.id).order("last_name");
    if (error) throw error;
    const P = people || [];
    const byMgr = {}; P.forEach((p) => { (byMgr[p.manager_id || "root"] = byMgr[p.manager_id || "root"] || []).push(p); });
    const ids = new Set(P.map((p) => p.id));
    const roots = P.filter((p) => !p.manager_id || !ids.has(p.manager_id));
    const name = (p) => `${p.preferred_name || p.first_name} ${p.last_name}`;
    const canOpen = isStaff();
    const node = (p, depth = 0) => {
      const kids = (byMgr[p.id] || []).filter((k) => k.id !== p.id);
      const card = `<div class="oc-card ${p.user_id === S.session.user.id ? "me" : ""}" ${canOpen ? `onclick="location.hash='#employees/${p.id}'"` : ""}><div class="oc-av">${esc(initials(name(p)))}</div><div><b>${esc(name(p))}</b><div class="small muted">${esc(p.job_title || "—")}${p.department ? " · " + esc(p.department) : ""}</div>${p.work_email ? `<a class="small" href="mailto:${esc(p.work_email)}" onclick="event.stopPropagation()">${esc(p.work_email)}</a>` : ""}</div>${kids.length ? `<span class="pill">${kids.length}</span>` : ""}</div>`;
      return `<li>${card}${kids.length && depth < 8 ? `<ul>${kids.map((k) => node(k, depth + 1)).join("")}</ul>` : ""}</li>`;
    };
    const q = dirSearch.toLowerCase();
    const list = P.filter((p) => !q || `${name(p)} ${p.first_name} ${p.job_title || ""} ${p.department || ""} ${p.work_email || ""}`.toLowerCase().includes(q));
    const mgrName = (id) => { const m = P.find((x) => x.id === id); return m ? name(m) : ""; };
    window.__afterRender = () => {
      const s = $("#dirsearch"); if (s) { s.oninput = () => { dirSearch = s.value; const rows = $("#dirrows"); rows.innerHTML = dirRows(); }; }
      const b = $("#addemp"); if (b) b.onclick = () => employeeModal();
    };
    const dirRows = () => { const q2 = dirSearch.toLowerCase(); const l = P.filter((p) => !q2 || `${name(p)} ${p.first_name} ${p.job_title || ""} ${p.department || ""} ${p.work_email || ""}`.toLowerCase().includes(q2));
      return l.length ? l.map((p) => `<tr class="${canOpen ? "clickable" : ""}" ${canOpen ? `onclick="location.hash='#employees/${p.id}'"` : ""}><td><b>${esc(name(p))}</b></td><td>${esc(p.job_title || "—")}</td><td>${esc(p.department || "—")}</td><td>${p.work_email ? `<a href="mailto:${esc(p.work_email)}" onclick="event.stopPropagation()">${esc(p.work_email)}</a>` : '<span class="muted">—</span>'}</td><td class="muted">${esc(mgrName(p.manager_id) || "—")}</td></tr>`).join("") : `<tr><td colspan="5" class="muted">No matches.</td></tr>`; };
    return `
      <div class="page-head"><div><h1>Org chart</h1><p>${canOpen ? `${P.length} people · built from each employee's manager. Set a manager on an employee's profile to place them.` : "You and your direct reports."}</p></div>${canOpen ? `<button class="btn" id="addemp">＋ Add employee</button>` : ""}</div>
      ${P.length ? `<div class="card oc-wrap"><ul class="oc">${roots.map((r) => node(r)).join("")}</ul></div>` : `<div class="empty"><h3>No one here yet</h3><p>${canOpen ? "Add employees and set their managers — the chart draws itself." : "Your company hasn't added employees yet."}</p></div>`}
      <div class="page-head" style="margin-top:28px"><div><h2>Directory</h2></div><input class="search" id="dirsearch" type="text" placeholder="Search name, title, department, email…" value="${esc(dirSearch)}" /></div>
      <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Name</th><th>Title</th><th>Department</th><th>Work email</th><th>Reports to</th></tr></thead><tbody id="dirrows">${dirRows()}</tbody></table></div>`;
  }

  // ------------------------------------------------------------ E-SIGNATURE
  function signModal(e, t) {
    if (!t?.template_doc) { toast("This task has no document to sign yet.", true); return; }
    const isSelf = e.user_id === S.session.user.id || !isStaff();
    const defaultName = isSelf ? (S.profile.full_name || "") : `${e.first_name} ${e.last_name}`;
    const m = modal(`<div class="modal-head"><h3>Sign: ${esc(t.label)}</h3><button class="x" data-close>×</button></div>
      <div class="signbox"><button type="button" class="btn sm ghost" id="review">📄 Review ${esc(t.template_doc.title)}</button><span class="small muted">Read the document before signing.</span></div>
      <label>Full legal name of signer</label><input type="text" id="sname" value="${esc(defaultName)}" autocomplete="off" />
      <label>Signature <span class="muted">— draw with your finger or mouse</span></label>
      <div class="padwrap"><canvas id="pad" width="760" height="220"></canvas><button type="button" class="btn sm quiet" id="clear">Clear</button></div>
      <label class="check"><input type="checkbox" id="consent" /> I have reviewed <b>${esc(t.template_doc.title)}</b> and agree to sign it electronically. I understand this signature is legally binding, the same as a handwritten one.</label>
      <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="dosign">Sign and file</button></div>`, { wide: true });
    m.el.querySelector("#review").onclick = () => openFile(t.template_doc.file_path);
    const cv = m.el.querySelector("#pad"), ctx = cv.getContext("2d"); let drawing = false, has = false, last = null;
    ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#17191f";
    const pos = (ev) => { const r = cv.getBoundingClientRect(); const p = ev.touches ? ev.touches[0] : ev; return [(p.clientX - r.left) * cv.width / r.width, (p.clientY - r.top) * cv.height / r.height]; };
    const start = (ev) => { ev.preventDefault(); drawing = true; last = pos(ev); };
    const move = (ev) => { if (!drawing) return; ev.preventDefault(); const p = pos(ev); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; has = true; };
    const end = () => (drawing = false);
    cv.onmousedown = start; cv.onmousemove = move; window.addEventListener("mouseup", end);
    cv.ontouchstart = start; cv.ontouchmove = move; cv.ontouchend = end;
    m.el.querySelector("#clear").onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); has = false; };
    m.el.querySelector("#dosign").onclick = () => busy(m.el.querySelector("#dosign"), async () => {
      const name = m.el.querySelector("#sname").value.trim();
      if (!name) throw new Error("Enter the signer's full legal name.");
      if (!has) throw new Error("Please draw a signature.");
      if (!m.el.querySelector("#consent").checked) throw new Error("Please confirm you reviewed the document and consent to sign electronically.");
      const when = new Date();
      const pngBlob = await new Promise((res) => cv.toBlob(res, "image/png"));
      const base = `${S.org.id}/employees/${e.id}/signatures/${t.task_key}-${when.getTime()}`;
      const { error: e1 } = await sb.storage.from(BUCKET).upload(base + ".png", pngBlob, { contentType: "image/png" }); if (e1) throw e1;
      const upd = { signed_at: when.toISOString(), signed_name: name, signed_by: S.session.user.id, signature_path: base + ".png", status: "complete", completed_at: when.toISOString(), completed_by: S.session.user.id };
      // stamped PDF: original + certificate page (PDF templates only)
      const isPdf = /pdf$/i.test(t.template_doc.mime_type || "") || /\.pdf$/i.test(t.template_doc.file_name || "");
      if (isPdf && window.PDFLib) {
        try {
          const { data: dl, error: e2 } = await sb.storage.from(BUCKET).download(t.template_doc.file_path); if (e2) throw e2;
          const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
          const pdf = await PDFDocument.load(await dl.arrayBuffer(), { ignoreEncryption: true });
          const png = await pdf.embedPng(await pngBlob.arrayBuffer());
          const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
          const page = pdf.addPage([612, 792]); const ink = rgb(.09, .1, .12), grey = rgb(.45, .47, .52);
          page.drawText("Electronic Signature Certificate", { x: 56, y: 720, size: 20, font: bold, color: ink });
          page.drawText(S.org.name, { x: 56, y: 696, size: 11, font, color: grey });
          const lines = [["Document", t.template_doc.title], ["Task", t.label], ["Employee", `${e.first_name} ${e.last_name}`], ["Signed by", name], ["Signer account", S.profile.email], ["Signed at", when.toLocaleString() + " (" + Intl.DateTimeFormat().resolvedOptions().timeZone + ")"], ["Consent", "Signer confirmed they reviewed the document and agreed to sign electronically."]];
          let y = 650; for (const [k, v] of lines) { page.drawText(k.toUpperCase(), { x: 56, y, size: 8, font: bold, color: grey }); page.drawText(String(v), { x: 180, y, size: 11, font, color: ink, maxWidth: 380 }); y -= 26; }
          const sw = 260, sh = sw * png.height / png.width; page.drawRectangle({ x: 56, y: y - sh - 20, width: sw, height: sh, borderColor: grey, borderWidth: .5 }); page.drawImage(png, { x: 56, y: y - sh - 20, width: sw, height: sh });
          page.drawText("Signature", { x: 56, y: y - sh - 34, size: 8, font: bold, color: grey });
          page.drawText("Generated by the HHG Client Portal · The Hope Harvest Group / JHM Consulting", { x: 56, y: 40, size: 8, font, color: grey });
          const bytes = await pdf.save();
          const { error: e3 } = await sb.storage.from(BUCKET).upload(base + "-signed.pdf", new Blob([bytes], { type: "application/pdf" }), { contentType: "application/pdf" }); if (e3) throw e3;
          upd.signed_file_path = base + "-signed.pdf"; upd.signed_file_name = (t.template_doc.title || "document").replace(/[^\w.\- ]+/g, "") + " - signed.pdf";
        } catch (err) { console.warn("stamped PDF failed, keeping signature image", err); }
      }
      const { error: e4 } = await sb.from("employee_tasks").update(upd).eq("id", t.id); if (e4) throw e4;
      await log("employee", e.id, "task_signed", { name: `${e.first_name} ${e.last_name}`, task: t.label, signer: name });
      m.close(); toast("Signed and filed"); render();
    });
  }

  // ------------------------------------------------------------ TASKS (all employees)
  let taskFilter = "open";
  async function viewTasks() {
    const { data: tasks, error } = await sb.from("employee_tasks").select("*, completed_by(id,full_name), template_doc:template_doc_id(id,title,file_path,file_name,mime_type), employees(id,first_name,last_name,preferred_name,status)").eq("org_id", S.org.id).order("due_date", { ascending: true, nullsFirst: false });
    if (error) throw error;
    const t0 = new Date().toISOString().slice(0, 10), soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const isOpen = (t) => ["pending", "in_progress"].includes(t.status);
    const groups = { overdue: tasks.filter((t) => isOpen(t) && t.due_date && t.due_date < t0), soon: tasks.filter((t) => isOpen(t) && t.due_date && t.due_date >= t0 && t.due_date <= soon), open: tasks.filter(isOpen), done: tasks.filter((t) => !isOpen(t)), all: tasks };
    const list = groups[taskFilter] || tasks;
    window.__afterRender = () => {
      $("#main").querySelectorAll(".chip").forEach((c) => c.onclick = () => { taskFilter = c.dataset.c; render(); });
      $("#main").querySelectorAll("[data-task]").forEach((row) => row.onclick = () => { const t = tasks.find((x) => x.id === row.dataset.task); taskModal({ ...t.employees, id: t.employee_id }, t); });
      $("#main").querySelectorAll("[data-open]").forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); openFile(b.dataset.open); });
    };
    return `
      <div class="page-head"><div><h1>Tasks</h1><p>Onboarding and compliance items across every employee.</p></div></div>
      <div class="filters">${[["overdue", "Overdue"], ["soon", "Due this week"], ["open", "All open"], ["done", "Completed"], ["all", "Everything"]].map(([k, v]) => `<button class="chip ${taskFilter === k ? "active" : ""} ${k === "overdue" && groups.overdue.length ? "alert" : ""}" data-c="${k}">${v} (${groups[k].length})</button>`).join("")}</div>
      ${list.length ? `<div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>Task</th><th>Employee</th><th>Due</th><th>File</th><th>Status</th></tr></thead><tbody>
        ${list.map((t) => { const e = t.employees || {}; const late = isOpen(t) && t.due_date && t.due_date < t0; return `<tr class="clickable" data-task="${t.id}"><td><b>${esc(t.label)}</b>${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ""}</td><td><a href="#employees/${t.employee_id}" onclick="event.stopPropagation()">${esc((e.preferred_name || e.first_name || "") + " " + (e.last_name || ""))}</a></td><td class="small ${late ? "late" : "muted"}">${t.due_date ? (late ? "Overdue · " : "") + fmtDate(t.due_date) : "—"}</td><td>${t.file_path ? `<button class="btn sm ghost" data-open="${t.file_path}">📄</button>` : '<span class="small muted">—</span>'}</td><td><span class="pill ${t.status === "complete" ? "ok" : t.status === "in_progress" ? "on" : t.status === "na" ? "" : "warn"}">${TASK_STATUS[t.status]}</span></td></tr>`; }).join("")}
      </tbody></table></div>` : `<div class="empty"><h3>Nothing here</h3><p>${taskFilter === "overdue" ? "No overdue tasks — nice." : "No tasks match this filter."}</p></div>`}`;
  }

  // ------------------------------------------------------------ SETTINGS (tabbed)
  async function viewSettings(tab) {
    const tabs = [];
    if (S.org && isAdmin()) tabs.push({ k: "company", t: "Company", d: "Name, logo, accent colour" });
    if (S.org && isStaff() && mods().employees) tabs.push({ k: "onboarding", t: "Onboarding checklist", d: "Tasks, documents, signatures" });
    if (S.org && isAdmin()) tabs.push({ k: "access", t: "People & access", d: "Users, roles, invitations" });
    tabs.push({ k: "account", t: "Your account", d: "Name, password" });
    tabs.push({ k: "roles", t: "Roles", d: "Who sees what" });
    if (isRealSuper()) tabs.push({ k: "portal", t: "Portal", d: "Clients, modules" });
    const cur = tabs.find((x) => x.k === tab) ? tab : tabs[0].k;
    let body = "", hook = () => {};

    if (cur === "company") {
      body = `<div class="card"><h3>Company</h3><p class="small muted">How ${esc(S.org.name)}'s workspace looks to everyone who signs in.</p>
        <form id="cf" novalidate><label>Company name</label><input type="text" name="cname" value="${esc(S.org.name)}" />
          <label>Logo</label>${S.logoUrl ? `<div class="ws-logo" style="max-width:260px;border:1px solid var(--line);margin-bottom:8px"><img src="${S.logoUrl}" alt="" /></div>` : ""}<input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml,image/webp" /><div class="small muted" style="margin-top:4px">PNG or SVG with a transparent background looks best. Wide wordmarks are fine.</div>
          <label>Accent colour</label><div style="display:flex;gap:10px;align-items:center"><span id="swatch" style="width:36px;height:36px;border-radius:10px;background:${esc(S.org.accent || "#17191f")};border:1px solid var(--line);flex-shrink:0"></span><input type="text" id="accent" name="accent" value="${esc(S.org.accent || "#17191f")}" style="max-width:140px" /><span class="small muted">Used for the company monogram.</span></div>
          <div class="modal-foot" style="justify-content:flex-start"><button class="btn" id="csave">Save</button></div></form></div>`;
      hook = () => {
        const c = $("#cf"); c.onsubmit = (e) => { e.preventDefault(); busy($("#csave"), async () => {
          const rec = { name: c.cname.value.trim(), accent: /^#[0-9a-fA-F]{6}$/.test(c.accent.value.trim()) ? c.accent.value.trim() : S.org.accent };
          if (!rec.name) throw new Error("Company name is required.");
          const logo = c.logo.files[0];
          if (logo) { const path = `${S.org.id}/branding/logo-${Date.now()}.${logo.name.split(".").pop()}`; const { error } = await sb.storage.from(BUCKET).upload(path, logo, { contentType: logo.type }); if (error) throw error; rec.logo_path = path; if (S.org.logo_path) await sb.storage.from(BUCKET).remove([S.org.logo_path]); }
          const { error } = await sb.from("organizations").update(rec).eq("id", S.org.id); if (error) throw error;
          const keep = S.org.id; await loadContext(); S.org = S.orgs.find((o) => o.id === keep) || S.org; S.role = S.org.role; S.logoUrl = null; if (S.org.logo_path) { try { S.logoUrl = await signedUrl(S.org.logo_path, 3600); } catch {} }
          toast("Company settings saved"); render(); }); };
        const ac = $("#accent"), sw = $("#swatch"); ac.oninput = () => (sw.style.background = ac.value);
      };
    }

    if (cur === "onboarding") {
      await sb.rpc("ensure_task_templates", { p_org: S.org.id });
      const [{ data: tpls }, { data: docs }] = await Promise.all([sb.from("task_templates").select("*").eq("org_id", S.org.id).order("sort_order"), sb.from("documents").select("id,title,category").eq("org_id", S.org.id).order("title")]);
      const docOpts = (sel) => `<option value="">— no document —</option>${(docs || []).map((d) => `<option value="${d.id}" ${sel === d.id ? "selected" : ""}>${esc(d.title)}</option>`).join("")}`;
      body = `<div class="card"><h3>Onboarding checklist</h3><p class="small muted">Every new employee receives these tasks. Attach the document behind each one (upload it under <a href="#docs">Documents</a> first) and tick <b>Sign</b> where a signature is required. Changes apply to employees added from now on.</p>
        <div style="overflow:auto"><table class="tpl"><thead><tr><th style="width:36px">On</th><th>Task</th><th>Document</th><th style="text-align:center">Sign</th><th>Due</th><th></th></tr></thead><tbody>
        ${(tpls || []).map((t) => `<tr data-tpl="${t.id}"><td><input type="checkbox" class="en" ${t.enabled ? "checked" : ""} title="Enabled" /></td><td><input type="text" class="lbl" value="${esc(t.label)}" /><input type="text" class="desc small" value="${esc(t.description || "")}" placeholder="Short description" style="margin-top:4px" /></td><td><select class="doc">${docOpts(t.document_id)}</select></td><td style="text-align:center"><input type="checkbox" class="sig" ${t.requires_signature ? "checked" : ""} /></td><td><select class="due"><option value="start" ${t.due_rule === "start" ? "selected" : ""}>Start date</option><option value="start+3bd" ${t.due_rule === "start+3bd" ? "selected" : ""}>Start + 3 business days</option><option value="hire+20" ${t.due_rule === "hire+20" ? "selected" : ""}>Hire + 20 days</option><option value="none" ${t.due_rule === "none" ? "selected" : ""}>No due date</option></select></td><td>${t.task_key.startsWith("custom_") ? `<button class="btn sm danger deltpl">Delete</button>` : ""}</td></tr>`).join("")}
        </tbody></table></div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;align-items:center"><button class="btn quiet sm" id="addtpl">＋ Add task</button><span class="spacer"></span><button class="btn" id="savetpl">Save checklist</button></div></div>`;
      hook = () => {
        $("#savetpl").onclick = () => busy($("#savetpl"), async () => {
          const rows = [...$("#main").querySelectorAll("tr[data-tpl]")].map((r, i) => ({ id: r.dataset.tpl, enabled: r.querySelector(".en").checked, label: r.querySelector(".lbl").value.trim() || "Task", description: r.querySelector(".desc").value.trim() || null, document_id: r.querySelector(".doc").value || null, requires_signature: r.querySelector(".sig").checked, due_rule: r.querySelector(".due").value, sort_order: (i + 1) * 10 }));
          for (const r of rows) { const { id, ...rec } = r; const { error } = await sb.from("task_templates").update(rec).eq("id", id); if (error) throw error; }
          toast("Checklist saved"); render();
        });
        $("#addtpl").onclick = () => busy($("#addtpl"), async () => { const { error } = await sb.from("task_templates").insert({ org_id: S.org.id, task_key: "custom_" + Date.now().toString(36), label: "New task", sort_order: 500, due_rule: "start" }); if (error) throw error; render(); });
        $("#main").querySelectorAll(".deltpl").forEach((b) => b.onclick = async () => { const { error } = await sb.from("task_templates").delete().eq("id", b.closest("tr").dataset.tpl); if (error) fail(error); else render(); });
      };
    }

    if (cur === "access") { location.hash = "#people"; return ""; }

    if (cur === "account") {
      body = `<div class="two" style="align-items:start"><div class="card"><h3>Your profile</h3><form id="pf"><label>Full name</label><input type="text" name="full_name" value="${esc(S.profile.full_name || "")}" /><label>Email</label><input type="email" value="${esc(S.profile.email)}" disabled /><label>Role</label><input type="text" value="${roleLabel(S.role)}${S.org ? " · " + esc(S.org.name) : ""}" disabled /><div class="modal-foot" style="justify-content:flex-start"><button class="btn">Save</button></div></form></div>
        <div class="card"><h3>Password</h3><form id="pw"><label>New password <span class="muted">(10+ characters)</span></label><input type="password" name="password" minlength="10" required autocomplete="new-password" /><div class="modal-foot" style="justify-content:flex-start"><button class="btn">Update password</button></div></form></div></div>`;
      hook = () => {
        const f = $("#pf"); f.onsubmit = (e) => { e.preventDefault(); busy(f.querySelector("button"), async () => { const { error } = await sb.from("profiles").update({ full_name: f.full_name.value.trim() }).eq("id", S.session.user.id); if (error) throw error; S.profile.full_name = f.full_name.value.trim(); toast("Saved"); render(); }); };
        const p = $("#pw"); p.onsubmit = (e) => { e.preventDefault(); busy(p.querySelector("button"), async () => { if (p.password.value.length < 10) throw new Error("Use at least 10 characters."); const { error } = await sb.auth.updateUser({ password: p.password.value }); if (error) throw error; p.reset(); toast("Password changed"); }); };
      };
    }

    if (cur === "roles") body = rolesExplainer();
    if (cur === "portal") body = `<div class="card"><h3>Portal administration</h3><p class="small muted">Client workspaces, logos, modules and access are managed from the Clients screen.</p><a class="btn quiet" href="#admin">Go to Clients →</a></div>`;

    window.__afterRender = hook;
    return `<div class="page-head"><div><h1>Settings</h1></div></div>
      <div class="settings"><nav class="subnav">${tabs.map((x) => `<a href="#settings/${x.k}" class="${x.k === cur ? "active" : ""}"><b>${x.t}</b><span>${x.d}</span></a>`).join("")}</nav><div class="settings-body">${body}</div></div>`;
  }

  // ------------------------------------------------------------ GLOBAL SEARCH (⌘K)
  function commands() {
    const c = [
      { t: "Home", k: "dashboard overview", go: () => (location.hash = "#home") },
      { t: "Documents", k: "files handbook policies library", go: () => (location.hash = "#docs") },
      { t: "Ask JHM", k: "help question contact support requests", go: () => (location.hash = "#requests") },
      { t: "New question for JHM", k: "ask help request send", go: () => requestModal() },
      { t: "Settings", k: "profile password account company logo color", go: () => (location.hash = "#settings") },
    ];
    const M = mods();
    if (!isStaff() && M.employees) c.push({ t: "My profile", k: "me record emergency contact dependents", go: () => (location.hash = "#me") });
    if (isStaff()) {
      if (M.employees) c.push({ t: "Employees", k: "hris staff people roster", go: () => (location.hash = "#employees") }, { t: "Add employee", k: "new hire onboarding create", go: () => employeeModal() });
      if (M.hiring) c.push({ t: "Hiring", k: "jobs recruiting candidates positions", go: () => (location.hash = "#hiring") }, { t: "New job order", k: "open position requisition create", go: () => jobModal() });
      if (M.tasks) c.push({ t: "Tasks", k: "onboarding compliance checklist overdue i-9 w-4", go: () => (location.hash = "#tasks") });
      if (M.documents) c.push({ t: "Upload document", k: "add file handbook policy benefits", go: () => docModal() });
    }
    if (M.employees) c.push({ t: "Org chart & directory", k: "organization team structure who reports manager email", go: () => (location.hash = "#org") });
    if (isAdmin()) c.push({ t: "People & access", k: "users members roles permissions", go: () => (location.hash = "#people") }, { t: "Invite someone", k: "add user access email", go: () => inviteModal() });
    if (isRealSuper()) c.push({ t: "All clients", k: "workspaces admin switch", go: () => (location.hash = "#admin") });
    return c.map((x) => ({ type: "Go to", title: x.t, sub: "", keys: (x.t + " " + x.k).toLowerCase(), go: x.go }));
  }
  function openSearch() {
    if (!S.org) return;
    const root = $("#modal-root");
    root.innerHTML = `<div class="modal-bg palette"><div class="pal"><div class="pal-in"><span>⌕</span><input id="palq" type="text" placeholder="Search employees, jobs, candidates, tasks, documents, requests… or type an action" autocomplete="off" /><kbd>esc</kbd></div><div id="palr" class="pal-r"><div class="pal-hint">Start typing. ↑↓ to move, Enter to open.</div></div></div></div>`;
    const bg = root.querySelector(".modal-bg"), q = $("#palq"), out = $("#palr");
    const close = () => (root.innerHTML = "");
    bg.onclick = (e) => { if (e.target === bg) close(); };
    q.focus();
    let items = [], sel = 0, seq = 0;
    const draw = () => {
      if (!items.length) { out.innerHTML = `<div class="pal-hint">${q.value.trim() ? "No matches." : "Start typing. ↑↓ to move, Enter to open."}</div>`; return; }
      let html = "", lastType = null;
      items.forEach((it, i) => { if (it.type !== lastType) { html += `<div class="pal-type">${it.type}</div>`; lastType = it.type; } html += `<div class="pal-it ${i === sel ? "sel" : ""}" data-i="${i}"><div><b>${esc(it.title)}</b>${it.sub ? `<span class="small muted"> · ${esc(it.sub)}</span>` : ""}</div>${it.badge ? `<span class="pill ${it.badgeClass || ""}">${esc(it.badge)}</span>` : ""}</div>`; });
      out.innerHTML = html;
      out.querySelectorAll(".pal-it").forEach((el) => { el.onmouseenter = () => { sel = +el.dataset.i; draw(); }; el.onclick = () => pick(); });
      const s = out.querySelector(".sel"); if (s) s.scrollIntoView({ block: "nearest" });
    };
    const pick = () => { const it = items[sel]; if (!it) return; close(); it.go(); };
    const run = async () => {
      const term = q.value.trim(); const my = ++seq;
      const cmds = commands().filter((c) => !term || term.toLowerCase().split(/\s+/).every((w) => c.keys.includes(w)));
      if (!term) { items = cmds; sel = 0; draw(); return; }
      const like = `%${term.replace(/[%_]/g, "")}%`; const org = S.org.id;
      const M = mods(); const none = Promise.resolve({ data: [] });
      const [emps, jobs, cands, docs, tasks, reqs] = await Promise.all([
        M.employees ? sb.from(isStaff() ? "employees" : "directory").select("id,first_name,last_name,preferred_name,job_title,department,status").eq("org_id", org).or(`first_name.ilike.${like},last_name.ilike.${like},preferred_name.ilike.${like},job_title.ilike.${like},department.ilike.${like},work_email.ilike.${like}`).limit(6) : none,
        isStaff() && M.hiring ? sb.from("job_orders").select("id,title,department,status").eq("org_id", org).or(`title.ilike.${like},department.ilike.${like},location.ilike.${like}`).limit(5) : none,
        isStaff() && M.hiring ? sb.from("candidates").select("id,full_name,stage,job_order_id,job_orders(title)").eq("org_id", org).or(`full_name.ilike.${like},email.ilike.${like}`).limit(5) : none,
        sb.from("documents").select("id,title,category,file_path").eq("org_id", org).or(`title.ilike.${like},description.ilike.${like}`).limit(6),
        isStaff() ? sb.from("employee_tasks").select("id,label,status,due_date,employee_id,employees(first_name,last_name)").eq("org_id", org).or(`label.ilike.${like},notes.ilike.${like}`).limit(6) : Promise.resolve({ data: [] }),
        sb.from("requests").select("id,subject,status").eq("org_id", org).or(`subject.ilike.${like},body.ilike.${like}`).limit(4),
      ]);
      if (my !== seq) return;
      items = [
        ...(emps.data || []).map((e) => ({ type: isStaff() ? "Employees" : "People", title: `${e.preferred_name || e.first_name} ${e.last_name}`, sub: [e.job_title, e.department].filter(Boolean).join(" · "), badge: isStaff() ? EMP_STATUS[e.status] : "", go: () => (location.hash = isStaff() ? "#employees/" + e.id : "#org") })),
        ...(jobs.data || []).map((j) => ({ type: "Job orders", title: j.title, sub: j.department || "", badge: JOB_STATUS[j.status], go: () => (location.hash = "#hiring/" + j.id) })),
        ...(cands.data || []).map((c) => ({ type: "Candidates", title: c.full_name, sub: c.job_orders?.title || "", badge: STAGE_LABEL[c.stage], go: () => (location.hash = "#hiring/" + c.job_order_id) })),
        ...(tasks.data || []).map((t) => ({ type: "Tasks", title: t.label, sub: t.employees ? `${t.employees.first_name} ${t.employees.last_name}` : "", badge: TASK_STATUS[t.status], badgeClass: t.status === "complete" ? "ok" : "", go: () => (location.hash = "#employees/" + t.employee_id) })),
        ...(docs.data || []).map((d) => ({ type: "Documents", title: d.title, sub: CATS[d.category], badge: "Open", go: () => openFile(d.file_path) })),
        ...(reqs.data || []).map((r) => ({ type: "Requests", title: r.subject, sub: "", badge: REQ_STATUS[r.status], go: () => (location.hash = "#requests") })),
        ...cmds,
      ];
      sel = 0; draw();
    };
    let t; q.oninput = () => { clearTimeout(t); t = setTimeout(run, 140); };
    q.onkeydown = (e) => { if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); draw(); } else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); } else if (e.key === "Enter") { e.preventDefault(); pick(); } else if (e.key === "Escape") close(); };
    run();
  }
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (S.session && S.org) openSearch(); }
    if (e.key === "/" && S.session && S.org && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) && !$("#modal-root").innerHTML) { e.preventDefault(); openSearch(); }
  });

  // ------------------------------------------------------------ boot
  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    S.session = session;
    if (S.recovery) return renderAuth("recovery");
    if (!session) return renderAuth();
    try { await loadContext(); } catch (e) { fail(e); return renderAuth("signin", `<div class="error">Could not load your profile. Try signing in again.</div>`); }
    if (!location.hash) location.hash = S.org ? "#home" : (isSuper() ? "#admin" : "#home");
    render();
    if (!S.profile.full_name) setupModal();
  }
  function setupModal() {
    const m = modal(`<div class="modal-head"><h3>Welcome — finish setting up</h3></div>
      <p class="small muted">You signed in with an emailed link. Add your name and choose a password so you can sign in directly next time.</p>
      <form id="f" novalidate><label>Full name</label><input type="text" name="full_name" autocomplete="name" />
        <label>Password <span class="muted">(10+ characters)</span></label><input type="password" name="password" autocomplete="new-password" />
        <div class="modal-foot"><button class="btn" id="save">Save and continue</button></div></form>`);
    m.el.closest(".modal-bg").onclick = null;
    const f = m.el.querySelector("#f");
    f.onsubmit = (ev) => { ev.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const name = f.full_name.value.trim(), pw = f.password.value;
      if (!name) throw new Error("Please enter your name."); if (pw.length < 10) throw new Error("Password must be at least 10 characters.");
      const { error: e1 } = await sb.auth.updateUser({ password: pw }); if (e1) throw e1;
      const { error: e2 } = await sb.from("profiles").update({ full_name: name }).eq("id", S.session.user.id); if (e2) throw e2;
      S.profile.full_name = name; m.close(); toast("You're all set"); render();
    }); };
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { S.recovery = true; S.session = session; renderAuth("recovery"); return; }
    if (event === "SIGNED_IN" && !S.session) { S.session = session; boot(); }
    if (event === "SIGNED_OUT") { S.session = null; S.profile = null; S.org = null; S.orgs = []; location.hash = ""; renderAuth(); }
  });
  boot();
})();
