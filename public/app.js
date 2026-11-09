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
  };
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
  const isAdmin = () => S.role === "super" || S.role === "admin";
  const isSuper = () => S.role === "super";

  let toastT;
  function toast(msg, err = false) {
    const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), err ? 5000 : 2600);
  }
  function fail(e) { console.error(e); toast(e?.message || String(e), true); }

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
    location.hash = "#docs"; render();
  }

  // ------------------------------------------------------------ shell
  function navItems() {
    if (!S.org) return isSuper() ? [{ h: "#admin", t: "Clients", i: "✦" }] : [];
    const items = [{ h: "#docs", t: "Documents", i: "▤" }];
    if (isAdmin()) items.push({ h: "#hiring", t: "Hiring", i: "◫" }, { h: "#people", t: "People", i: "◉" });
    if (isSuper()) items.push({ h: "#admin", t: "Clients", i: "✦" });
    return items;
  }
  function renderShell(inner) {
    const route = (location.hash || "#docs").split("/")[0];
    const nav = navItems();
    const accent = S.org?.accent || "#1f4d3a";
    document.documentElement.style.setProperty("--accent", accent);
    const logo = S.logoUrl ? `<img class="logo" src="${S.logoUrl}" alt="" />` : `<div class="logo">${esc(initials(S.org?.name || "HH"))}</div>`;
    const orgSwitch = S.orgs.length > 1 ? `<div class="org-switch"><select id="orgsel">${S.orgs.map((o) => `<option value="${o.id}" ${o.id === S.org?.id ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select></div>` : "";
    app.innerHTML = `
      <div class="shell">
        <header class="topbar">
          <div class="brand">${logo}<div><div class="name">${esc(S.org?.name || CFG.PORTAL_NAME)}</div><div class="sub">HR portal · ${S.role === "super" ? "JHM admin" : S.role === "admin" ? "Client admin" : "Staff"}</div></div></div>
          <div class="spacer"></div>${orgSwitch}
          <div class="avatar" id="avatar" title="${esc(S.profile.email)}">${esc(initials(S.profile.full_name || S.profile.email))}</div>
          <div class="menu hidden" id="menu"><div class="who"><b>${esc(S.profile.full_name || "")}</b><br><span class="muted">${esc(S.profile.email)}</span></div>
            <button data-go="#account">Account & password</button><button id="signout">Sign out</button></div>
        </header>
        <div class="layout">
          <nav class="sidenav">${nav.map((n) => `<a href="${n.h}" class="${route === n.h ? "active" : ""}">${n.i} ${n.t}</a>`).join("")}
            <div class="sect">Help</div><a href="mailto:${esc(CFG.SUPPORT_EMAIL)}">✉ Ask JHM</a></nav>
          <main class="main" id="main">${inner}</main>
        </div>
        <nav class="tabbar">${nav.map((n) => `<a href="${n.h}" class="${route === n.h ? "active" : ""}"><span>${n.i}</span>${n.t}</a>`).join("")}</nav>
      </div>`;
    const menu = $("#menu");
    $("#avatar").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
    document.addEventListener("click", () => menu.classList.add("hidden"), { once: true });
    $("#signout").onclick = () => sb.auth.signOut();
    menu.querySelector("[data-go]").onclick = () => { location.hash = "#account"; };
    const sel = $("#orgsel"); if (sel) sel.onchange = () => switchOrg(sel.value);
  }

  // ------------------------------------------------------------ router
  async function render() {
    if (S.recovery) return renderAuth("recovery");
    if (!S.session) return renderAuth();
    if (!S.org && !isSuper()) {
      return renderShell(`<div class="empty"><h3>No access yet</h3><p>Your account isn't attached to a client workspace.<br>Ask your HR consultant to invite <b>${esc(S.profile.email)}</b>.</p>
        <a class="btn ghost" href="mailto:${esc(CFG.SUPPORT_EMAIL)}">Email ${esc(CFG.SUPPORT_EMAIL)}</a></div>`);
    }
    let [route, arg] = (location.hash || "#docs").slice(1).split("/");
    if (!S.org) route = "admin";   // super admin with no clients yet: only the Clients screen makes sense
    let html = "";
    const token = (render.seq = (render.seq || 0) + 1);
    try {
      if (route === "hiring" && isAdmin()) html = arg ? await viewJobOrder(arg) : await viewHiring();
      else if (route === "people" && isAdmin()) html = await viewPeople();
      else if (route === "admin" && isSuper()) html = await viewAdmin();
      else if (route === "account") html = viewAccount();
      else html = await viewDocs();
    } catch (e) { fail(e); html = `<div class="empty">Something went wrong loading this page.</div>`; }
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
          ${isAdmin() ? `<span class="pill ${d.staff_visible ? "on" : ""}">${d.staff_visible ? "Staff can view" : "Admins only"}</span>` : ""}</div>
          ${d.description ? `<div class="small muted">${esc(d.description)}</div>` : ""}</div>
        <div class="actions"><button class="btn sm ghost" data-open="${d.file_path}" data-id="${d.id}">Open</button><button class="btn sm quiet" data-dl="${d.file_path}">Download</button>
          ${isAdmin() ? `<button class="btn sm quiet" data-edit="${d.id}">Edit</button><button class="btn sm danger" data-del="${d.id}">Delete</button>` : ""}</div></div>`).join("")
      : `<div class="empty"><h3>No documents here yet</h3><p>${isAdmin() ? "Upload a handbook, policy, job description or benefits handout to get started." : "Your HR consultant hasn't shared anything in this category yet."}</p></div>`;

    return `
      <div class="page-head"><div><h1>Documents</h1><p>${isAdmin() ? "Everything you've shared with " + esc(S.org.name) + "." : "Your company's HR documents, shared by JHM Consulting."}</p></div>
        ${isAdmin() ? `<button class="btn" id="upload">＋ Upload document</button>` : ""}</div>
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
        <label class="check"><input type="checkbox" name="staff_visible" ${doc?.staff_visible ? "checked" : ""} /> Visible to client staff (members) — leave off for admin-only items</label>
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
        <div class="modal-foot">${job ? `<button type="button" class="btn danger" id="del">Delete</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${job ? "Save" : "Create"}</button></div>
      </form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      const rec = { title: d.title.trim(), department: d.department.trim() || null, location: d.location.trim() || null, employment_type: d.employment_type, status: d.status, opened_at: d.opened_at || null, process_doc_id: d.process_doc_id || null, description: d.description.trim() || null };
      if (job) { const { error } = await sb.from("job_orders").update(rec).eq("id", job.id); if (error) throw error; await log("job_order", job.id, "updated", { title: rec.title, status: rec.status }); }
      else { const { data, error } = await sb.from("job_orders").insert({ ...rec, org_id: S.org.id, created_by: S.session.user.id }).select().single(); if (error) throw error; await log("job_order", data.id, "created", { title: rec.title }); location.hash = "#hiring/" + data.id; }
      m.close(); toast("Saved"); render();
    }); };
    const del = m.el.querySelector("#del");
    if (del) del.onclick = async () => {
      if (!(await confirmBox("Delete job order?", "All candidates, resumes and notes in this order will be deleted too."))) return;
      try {
        const { data: cands } = await sb.from("candidates").select("resume_path").eq("job_order_id", job.id);
        const paths = (cands || []).map((c) => c.resume_path).filter(Boolean); if (paths.length) await sb.storage.from(BUCKET).remove(paths);
        const { error } = await sb.from("job_orders").delete().eq("id", job.id); if (error) throw error;
        await log("job_order", job.id, "deleted", { title: job.title }); m.close(); location.hash = "#hiring";
      } catch (e) { fail(e); }
    };
  }

  async function viewJobOrder(id) {
    const [{ data: job, error }, { data: cands }, { data: acts }] = await Promise.all([
      sb.from("job_orders").select("*, process_doc:process_doc_id(id,title,file_path)").eq("id", id).single(),
      sb.from("candidates").select("*").eq("job_order_id", id).order("created_at"),
      sb.from("activity_log").select("*, actor:actor_id(full_name)").eq("org_id", S.org.id).in("entity_type", ["job_order", "candidate"]).order("created_at", { ascending: false }).limit(60),
    ]);
    if (error) throw error;
    const candIds = new Set(cands.map((c) => c.id));
    const activity = (acts || []).filter((a) => a.entity_id === id || candIds.has(a.entity_id) || a.detail?.job_order_id === id).slice(0, 25);

    const candCard = (c) => `<div class="cand" draggable="true" data-c="${c.id}"><div class="n">${esc(c.full_name)}</div><div class="s">${[c.source, fmtDate(c.created_at)].filter(Boolean).join(" · ")}${c.resume_path ? " · 📄" : ""}</div></div>`;
    window.__afterRender = () => {
      $("#editjob").onclick = () => jobModal(job);
      $("#addcand").onclick = () => candModal(job);
      const pd = $("#procdoc"); if (pd) pd.onclick = () => openFile(job.process_doc.file_path);
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
      ${job.description ? `<div class="card" style="margin-bottom:16px;white-space:pre-wrap">${esc(job.description)}</div>` : ""}
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
      $("#main").querySelectorAll("[data-rminv]").forEach((b) => b.onclick = async () => {
        try { const { error } = await sb.from("invites").delete().eq("id", b.dataset.rminv); if (error) throw error; render(); } catch (e) { fail(e); }
      });
    };
    const me = S.session.user.id;
    return `
      <div class="page-head"><div><h1>People</h1><p>Who can sign in to ${esc(S.org.name)}, and what they can see.</p></div><button class="btn" id="invite">＋ Invite someone</button></div>
      <div class="card" style="margin-bottom:14px"><table><thead><tr><th>Name</th><th>Email</th><th>Access</th><th></th></tr></thead><tbody>
        ${mems.map((m) => `<tr><td><b>${esc(m.profile?.full_name || "—")}</b>${m.user_id === me ? ' <span class="pill">you</span>' : ""}</td><td class="muted">${esc(m.profile?.email || "")}</td>
          <td>${m.user_id === me && !isSuper() ? `<span class="pill on">Admin</span>` : `<select data-role="${m.id}" style="width:auto;padding:5px 8px"><option value="admin" ${m.role === "admin" ? "selected" : ""}>Admin</option><option value="member" ${m.role === "member" ? "selected" : ""}>Staff</option></select>`}</td>
          <td style="text-align:right">${m.user_id === me && !isSuper() ? "" : `<button class="btn sm danger" data-rm="${m.id}">Remove</button>`}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No members yet.</td></tr>`}
      </tbody></table></div>
      <h3 style="margin:18px 0 8px">Pending invitations</h3>
      <div class="card">${(invs || []).length ? `<table><tbody>${invs.map((i) => `<tr><td>${esc(i.email)}</td><td><span class="pill">${i.role === "admin" ? "Admin" : "Staff"}</span></td><td class="muted small">Invited ${fmtDate(i.created_at)}</td><td style="text-align:right"><button class="btn sm quiet" data-rminv="${i.id}">Cancel</button></td></tr>`).join("")}</tbody></table>`
        : `<span class="muted small">No pending invitations. When you invite someone, they get access the moment they create an account with that email.</span>`}</div>
      <div class="notice" style="margin-top:14px"><b>Access levels.</b> <b>Admin</b> sees everything for this company: all documents, hiring boards, resumes, and can invite others. <b>Staff</b> can only open documents marked “visible to client staff” — handbooks and benefits handouts, for example.</div>`;
  }
  function inviteModal() {
    const m = modal(`
      <div class="modal-head"><h3>Invite to ${esc(S.org.name)}</h3><button class="x" data-close>×</button></div>
      <form id="f"><label>Email address</label><input type="email" name="email" required />
        <label>Access level</label><select name="role"><option value="admin">Admin — full access (owner / manager)</option><option value="member">Staff — shared documents only</option></select>
        <p class="small muted" style="margin-top:12px">Send them to <b>${esc(location.origin + location.pathname)}</b> to create an account with this email. If they already have an account, access is granted immediately.</p>
        <div class="modal-foot"><button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">Invite</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f));
      const { error } = await sb.from("invites").upsert({ org_id: S.org.id, email: d.email.trim().toLowerCase(), role: d.role, invited_by: S.session.user.id }, { onConflict: "org_id,email" }); if (error) throw error;
      await log("membership", null, "invited", { email: d.email.trim().toLowerCase(), role: d.role });
      m.close(); toast("Invitation created"); render();
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
      <div class="grid">${orgs.map((o) => `<div class="card"><div style="display:flex;gap:12px;align-items:center"><div class="icon" style="background:${esc(o.accent || "#1f4d3a")};color:#fff">${esc(initials(o.name))}</div><div class="grow"><h3>${esc(o.name)}</h3><div class="small muted">${o.memberships?.[0]?.count ?? 0} users · ${o.documents?.[0]?.count ?? 0} docs · ${o.job_orders?.[0]?.count ?? 0} job orders</div></div></div>
        <div style="display:flex;gap:8px;margin-top:14px"><button class="btn sm" data-enter="${o.id}">Enter workspace</button><button class="btn sm quiet" data-edit="${o.id}">Settings</button></div></div>`).join("")
        || `<div class="empty" style="grid-column:1/-1"><h3>No clients yet</h3><p>Create your first client workspace, then invite their owner as an admin.</p></div>`}</div>`;
  }
  function orgModal(o = null) {
    const m = modal(`
      <div class="modal-head"><h3>${o ? "Client settings" : "New client"}</h3><button class="x" data-close>×</button></div>
      <form id="f" novalidate><label>Company name</label><input type="text" name="company_name" required value="${esc(o?.name || "")}" placeholder="e.g. White House Custom Apparel & Graphics" />
        <div class="two"><div><label>Accent color</label><input type="text" name="accent" value="${esc(o?.accent || "#1f4d3a")}" placeholder="#1f4d3a" /></div>
        <div><label>Logo ${o?.logo_path ? "<span class='muted'>(replace)</span>" : ""}</label><input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml" /></div></div>
        <div class="modal-foot">${o ? `<button type="button" class="btn danger" id="del">Delete client</button><span class="spacer"></span>` : ""}<button type="button" class="btn quiet" data-close>Cancel</button><button class="btn" id="save">${o ? "Save" : "Create"}</button></div></form>`);
    const f = m.el.querySelector("#f");
    f.onsubmit = (e) => { e.preventDefault(); busy(m.el.querySelector("#save"), async () => {
      const d = Object.fromEntries(new FormData(f)); const logo = f.logo.files[0];
      const name = (d.company_name || "").trim();
      if (!name) throw new Error("Please enter the company name.");
      const rec = { name, accent: /^#[0-9a-fA-F]{6}$/.test((d.accent || "").trim()) ? d.accent.trim() : "#1f4d3a" };
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

  // ------------------------------------------------------------ ACCOUNT
  function viewAccount() {
    window.__afterRender = () => {
      const f = $("#pf"); f.onsubmit = (e) => { e.preventDefault(); busy(f.querySelector("button"), async () => {
        const { error } = await sb.from("profiles").update({ full_name: f.full_name.value.trim() }).eq("id", S.session.user.id); if (error) throw error;
        S.profile.full_name = f.full_name.value.trim(); toast("Saved"); render(); }); };
      const p = $("#pw"); p.onsubmit = (e) => { e.preventDefault(); busy(p.querySelector("button"), async () => {
        const { error } = await sb.auth.updateUser({ password: p.password.value }); if (error) throw error; p.reset(); toast("Password changed"); }); };
    };
    return `<div class="page-head"><div><h1>Account</h1></div></div>
      <div class="two"><div class="card"><h3>Your name</h3><form id="pf"><label>Full name</label><input type="text" name="full_name" value="${esc(S.profile.full_name || "")}" /><label>Email</label><input type="email" value="${esc(S.profile.email)}" disabled /><button class="btn block">Save</button></form></div>
      <div class="card"><h3>Change password</h3><form id="pw"><label>New password</label><input type="password" name="password" minlength="10" required autocomplete="new-password" /><button class="btn block">Update password</button></form></div></div>`;
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    S.session = session;
    if (S.recovery) return renderAuth("recovery");
    if (!session) return renderAuth();
    try { await loadContext(); } catch (e) { fail(e); return renderAuth("signin", `<div class="error">Could not load your profile. Try signing in again.</div>`); }
    if (!location.hash) location.hash = S.org ? "#docs" : (isSuper() ? "#admin" : "#docs");
    render();
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { S.recovery = true; S.session = session; renderAuth("recovery"); return; }
    if (event === "SIGNED_IN" && !S.session) { S.session = session; boot(); }
    if (event === "SIGNED_OUT") { S.session = null; S.profile = null; S.org = null; S.orgs = []; location.hash = ""; renderAuth(); }
  });
  boot();
})();
