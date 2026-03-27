import React, { createContext, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  addEdge,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import Cropper from "react-cropper";
import Quill from "quill";
import "quill/dist/quill.snow.css";

const InlineBlot = Quill.import("blots/inline");
class InkDictionaryBlot extends InlineBlot {
  static create(value) {
    const node = super.create();
    if (value && typeof value === "object") {
      const bits = [value.definition, value.usageNotes].filter(Boolean);
      if (bits.length) node.setAttribute("title", bits.join("\n\n").slice(0, 480));
    }
    return node;
  }

  static blotName = "inkDict";
  static className = "ink-dict-term";
}
InkDictionaryBlot.tagName = "span";
try {
  Quill.register(InkDictionaryBlot, true);
} catch {
  /* hot reload */
}

function escapeRxDict(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dictionaryMatchRanges(text, glossary) {
  const terms = (glossary || [])
    .map(e => ({
      term: (e.term || "").trim(),
      definition: e.definition || "",
      usageNotes: e.usageNotes || "",
    }))
    .filter(e => e.term.length >= 2)
    .sort((a, b) => b.term.length - a.term.length);
  const ranges = [];
  const occupied = [];
  for (const entry of terms) {
    const re = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRxDict(entry.term)}(?![\\p{L}\\p{M}\\p{N}_])`, "giu");
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (occupied.some(([a, b]) => !(end <= a || start >= b))) continue;
      occupied.push([start, end]);
      ranges.push({ start, end, ...entry });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function applyGlossaryHighlights(quill, glossary) {
  if (!quill || !glossary?.length) {
    if (quill) quill.formatText(0, Math.max(quill.getLength(), 1), "inkDict", false);
    return;
  }
  const raw = quill.getText();
  const body = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const spans = dictionaryMatchRanges(body, glossary);
  const fullLen = quill.getLength();
  quill.formatText(0, fullLen, "inkDict", false);
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end, term, definition, usageNotes } = spans[i];
    const len = end - start;
    if (len <= 0 || start < 0 || start + len > fullLen) continue;
    quill.formatText(start, len, "inkDict", { term, definition, usageNotes });
  }
}
import "@xyflow/react/dist/style.css";
import "cropperjs/dist/cropper.css";
import "./styles.css";
import { t } from "./i18n/fr.js";

const boot = window.INKRISE_BOOTSTRAP || {};
const SessionContext = createContext(null);
const WORDS_PER_PAGE = 250;
const WORD_TOKEN_RE = /[^\W_]+(?:['’][^\W_]+)*(?:-[^\W_]+(?:['’][^\W_]+)*)*/gu;
const COVER_CANVAS_WIDTH = 1600;
const COVER_CANVAS_HEIGHT = 2560;
const COVER_ASPECT_RATIO = COVER_CANVAS_WIDTH / COVER_CANVAS_HEIGHT;

function getCsrfToken() { const m = document.cookie.match(/csrftoken=([^;]+)/); return m ? decodeURIComponent(m[1]) : boot.csrfToken || ""; }
function normalizeHtml(v) { return v === "<p><br></p>" ? "" : v; }
function cx(...v) { return v.filter(Boolean).join(" "); }
function pages(w) { return Math.max(1, Math.ceil(w / WORDS_PER_PAGE)); }
function formatWhen(v) {
  if (!v) return "";
  const d = new Date(v);
  return `${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}
function formatLongWhen(v) {
  if (!v) return "Jamais";
  const d = new Date(v);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function formatSavedAt(v) {
  if (!v) return "";
  const d = new Date(v);
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function chapterRoute(project) {
  const chapterId = project?.continueChapterId || project?.firstChapterId;
  return chapterId ? `/projects/${project.slug}/workspace/${chapterId}` : `/projects/${project.slug}/edit`;
}
/** Plain text for counts — mirrors Django Chapter.plain_text (strip tags, collapse whitespace). */
function plainTextFromHtml(html) {
  const temp = document.createElement("div");
  temp.innerHTML = html || "";
  return (temp.textContent || temp.innerText || "").replace(/\s+/g, " ").trim();
}
function countWordsInText(text) {
  const normalized = (text || "").normalize("NFKC").replace(/\u2019/g, "'").replace(/[‐‑‒–—―]+/g, " ").replace(/-{2,}/g, " ");
  return normalized.match(WORD_TOKEN_RE)?.length || 0;
}
function extractErrorMessage(e) { if (!e) return "Une erreur est survenue."; if (typeof e === "string") return e; if (e.message) return e.message; if (typeof e.error === "string") return e.error; if (e.error && typeof e.error === "object") { const k = Object.keys(e.error)[0]; if (k) { const v = e.error[k]?.[0]; if (v) return `${k}: ${v}`; } } return "Une erreur est survenue."; }

async function apiFetch(url, options = {}) {
  const method = options.method || "GET"; const headers = { ...(options.headers || {}) }; let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== "string") { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
  if (method !== "GET") headers["X-CSRFToken"] = getCsrfToken();
  const r = await fetch(url, { credentials: "same-origin", ...options, method, headers, body });
  let p = {}; try { p = await r.json(); } catch (e) { p = {}; } if (!r.ok) throw p; return p;
}

/* ─── Icons ─── */
function IconFeather(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20.24 12.24a6 6 0 00-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>; }
function IconLibrary(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M4 19.5v-15A2.5 2.5 0 016.5 2H20v20H6.5a2.5 2.5 0 010-5H20"/></svg>; }
function IconPlus(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>; }
function IconUser(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>; }
function IconHelp(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function IconPen(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>; }
function IconUsers(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>; }
function IconMapPin(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>; }
function IconSitemap(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>; }
function IconBrain(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M9.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 01-4.96.44A2.5 2.5 0 015 17.5a2.5 2.5 0 01.49-4.78A2.5 2.5 0 017 9.5a2.5 2.5 0 012.5-2.5zM14.5 2A2.5 2.5 0 0012 4.5v15a2.5 2.5 0 004.96.44A2.5 2.5 0 0019 17.5a2.5 2.5 0 00-.49-4.78A2.5 2.5 0 0017 9.5a2.5 2.5 0 00-2.5-2.5z"/></svg>; }
function IconFileText(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>; }
function IconLayers(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>; }
function IconBook(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>; }
function IconBarChart(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>; }
function IconSettings(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>; }
function IconLogout(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>; }
function IconSearch(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function IconDownload(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>; }
function IconPackage(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>; }
function IconChevronRight(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="9 18 15 12 9 6"/></svg>; }
function IconDoc(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>; }
function IconFolder(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>; }
function IconSidebar(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>; }
function IconPanelRight(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>; }
function IconImage(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="nav-icon" {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>; }
function IconUpload(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>; }
function IconEye(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>; }
function IconEyeOff(p) { return <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>; }

/* ─── Thème (profil) ─── */
function applyUserTheme(profile) {
  const root = document.documentElement;
  const pref = profile?.uiTheme || "system";
  const effective = pref === "light" ? "light" : pref === "dark" ? "dark" : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  root.setAttribute("data-theme", effective);
  const accent = profile?.uiAccent;
  if (accent && /^#[0-9A-Fa-f]{6}$/i.test(accent)) {
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-strong", accent);
  } else {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-strong");
  }
}

/* ─── Session ─── */
function useSessionProvider() {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState({ authenticated: false, user: null, projects: [] });
  const refreshSession = useCallback(async () => { setLoading(true); try { const p = await apiFetch("/api/session/"); setSession({ authenticated: p.authenticated, user: p.user, projects: p.projects || [] }); } finally { setLoading(false); } }, []);
  useEffect(() => { refreshSession(); }, [refreshSession]);

  useEffect(() => {
    const root = document.documentElement;
    if (!session.authenticated || !session.user?.profile) {
      root.setAttribute("data-theme", "dark");
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-strong");
      return;
    }
    const profile = session.user.profile;
    applyUserTheme(profile);
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onScheme = () => { if (profile.uiTheme === "system") applyUserTheme(profile); };
    if (profile.uiTheme === "system") mq.addEventListener("change", onScheme);
    return () => { if (profile.uiTheme === "system") mq.removeEventListener("change", onScheme); };
  }, [session.authenticated, session.user]);

  return { loading, session, refreshSession, setSession };
}
function useSession() { return useContext(SessionContext); }

function LoadingScreen({ label = "Chargement..." }) { return <div className="route-state"><div className="route-state-panel"><div className="spinner" /><p>{label}</p></div></div>; }
function ErrorState({ title = "Erreur", message, action }) { return <div className="route-state"><div className="route-state-panel route-state-panel--error"><h2>{title}</h2><p>{message}</p>{action}</div></div>; }
function HomeRedirect() { const { loading, session } = useSession(); if (loading) return <LoadingScreen />; return <Navigate to={session.authenticated ? "/dashboard" : "/login"} replace />; }
function RequireAuth({ children }) { const { loading, session } = useSession(); if (loading) return <LoadingScreen />; if (!session.authenticated) return <Navigate to="/login" replace />; return children; }
function PublicOnly({ children }) { const { loading, session } = useSession(); if (loading) return <LoadingScreen />; if (session.authenticated) return <Navigate to="/dashboard" replace />; return children; }

function AuthLayout({ title, subtitle, children }) {
  return (
    <div className="auth-shell"><div className="auth-window"><div className="auth-window-inner">
      <div className="window-dots"><span /><span /><span /></div>
      <div className="auth-content">
        <div className="auth-brand"><div className="auth-brand-badge">IR</div><div className="auth-brand-text"><div className="brand-title">InkRise</div><small>Studio d'écriture</small></div></div>
        <div className="auth-copy"><h1>{title}</h1><p>{subtitle}</p></div>
        {children}
      </div>
    </div></div></div>
  );
}

function Field({ label, children, hint, error }) { return <label className="field"><span className="field__label">{label}</span>{children}{hint ? <small className="field__hint">{hint}</small> : null}{error ? <small className="field__error">{error}</small> : null}</label>; }
function Btn({ children, onClick, variant = "secondary", type = "button", disabled, className }) { return <button type={type} className={cx(variant === "primary" ? "btn-primary" : "btn-secondary", disabled && "is-disabled", className)} onClick={onClick} disabled={disabled}>{children}</button>; }

function Accordion({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (<div className={cx("accordion", open && "is-open")}><div className="accordion-header" onClick={() => setOpen(v => !v)}><h3>{title}</h3><IconChevronRight className="accordion-chevron" /></div><div className="accordion-body">{children}</div></div>);
}

/* ─── Quill Editor Component (key-based remounting) ─── */
function QuillEditor({ initialContent, onChange, projectSlug, chapterId, onSaveState, glossary = [], highlightPhrase = "" }) {
  const editorRef = useRef(null);
  const toolbarRef = useRef(null);
  const quillRef = useRef(null);
  const dictTimerRef = useRef(null);
  const skipNextDictRef = useRef(false);
  const glossaryRef = useRef(glossary);
  glossaryRef.current = glossary;

  useEffect(() => {
    if (!editorRef.current || !toolbarRef.current) return;
    let mounted = true;
    const q = new Quill(editorRef.current, {
      modules: { toolbar: toolbarRef.current, history: { delay: 500, maxStack: 100, userOnly: true } },
      placeholder: "Commencez à écrire...",
      theme: "snow",
    });

    if (initialContent) {
      q.clipboard.dangerouslyPasteHTML(initialContent);
    }

    let initializing = true;
    q.on("text-change", () => {
      if (!mounted || initializing) return;
      onChange(normalizeHtml(q.root.innerHTML));
      if (skipNextDictRef.current) {
        skipNextDictRef.current = false;
        return;
      }
      window.clearTimeout(dictTimerRef.current);
      dictTimerRef.current = window.setTimeout(() => {
        const sel = q.getSelection();
        applyGlossaryHighlights(q, glossaryRef.current);
        if (sel) q.setSelection(sel);
      }, 450);
    });
    setTimeout(() => {
      initializing = false;
      applyGlossaryHighlights(q, glossaryRef.current);
    }, 60);

    q.getModule("toolbar").addHandler("image", () => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const fd = new FormData(); fd.append("image", file);
        onSaveState?.("Téléversement...");
        try {
          const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${chapterId}/upload-image/`, { method: "POST", body: fd });
          const range = q.getSelection(true);
          q.insertEmbed(range ? range.index : 0, "image", p.url, "user");
          onSaveState?.("Image insérée");
        } catch (e) { onSaveState?.(extractErrorMessage(e)); }
      };
      input.click();
    });

    quillRef.current = q;
    return () => {
      mounted = false;
      window.clearTimeout(dictTimerRef.current);
      quillRef.current = null;
    };
  }, []);

  useEffect(() => {
    const q = quillRef.current;
    if (!q) return;
    skipNextDictRef.current = true;
    applyGlossaryHighlights(q, glossary);
  }, [glossary]);

  useEffect(() => {
    const q = quillRef.current;
    if (!q || !highlightPhrase?.trim()) return;
    const needle = highlightPhrase.trim();
    const full = q.getText();
    const idx = full.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) return;
    requestAnimationFrame(() => {
      try {
        q.setSelection(idx, needle.length, "silent");
        const b = q.getBounds(idx);
        if (b?.top != null) {
          const wrap = editorRef.current?.closest(".editor-canvas");
          wrap?.scrollTo({ top: Math.max(0, wrap.scrollTop + b.top - 120), behavior: "smooth" });
        }
      } catch {
        /* selection may fail on some states */
      }
    });
  }, [highlightPhrase, chapterId, initialContent]);

  return (
    <>
      <div ref={toolbarRef} className="editor-toolbar-bar">
        <span className="ql-formats"><button className="ql-bold" type="button" /><button className="ql-italic" type="button" /><button className="ql-underline" type="button" /></span>
        <span className="ql-formats"><select className="ql-header" defaultValue=""><option value="" /><option value="1" /><option value="2" /></select></span>
        <span className="ql-formats"><button className="ql-list" value="ordered" type="button" /><button className="ql-list" value="bullet" type="button" /></span>
        <span className="ql-formats"><button className="ql-blockquote" type="button" /><button className="ql-link" type="button" /><button className="ql-image" type="button" /><button className="ql-clean" type="button" /></span>
      </div>
      <div className="editor-canvas">
        <div className="editor-chapter-heading">
          {/* Title is rendered externally */}
        </div>
        <div className="manuscript-wrapper">
          <div className="manuscript-page">
            <div ref={editorRef} />
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── App Layout ─── */
function AppLayout({ children, currentProjectSlug }) {
  const { session, setSession } = useSession();
  const navigate = useNavigate();
  const [projectDropdown, setProjectDropdown] = useState(false);
  const dropdownRef = useRef(null);
  const currentProject = useMemo(() => session.projects.find(p => p.slug === currentProjectSlug) || null, [session.projects, currentProjectSlug]);
  const handleLogout = async () => { await apiFetch("/api/auth/logout/", { method: "POST" }); setSession({ authenticated: false, user: null, projects: [] }); navigate("/login"); };

  useEffect(() => {
    if (!projectDropdown) return;
    const close = (e) => { if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setProjectDropdown(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [projectDropdown]);

  const globalLinks = [
    { to: "/dashboard", icon: IconLibrary, label: "Bibliothèque" },
    { to: "/projects/new", icon: IconPlus, label: "Nouveau projet" },
    { to: "/profile", icon: IconUser, label: "Profil" },
    { to: "/help", icon: IconHelp, label: "Aide" },
  ];
  const projectLinks = currentProjectSlug ? [
    { to: `/projects/${currentProjectSlug}/stats`, icon: IconBarChart, label: "Aperçu" },
    { to: chapterRoute(currentProject || { slug: currentProjectSlug }), icon: IconPen, label: "Récit" },
    { to: `/projects/${currentProjectSlug}/characters`, icon: IconUsers, label: "Personnages" },
    { to: `/projects/${currentProjectSlug}/places`, icon: IconMapPin, label: "Lieux" },
    { to: `/projects/${currentProjectSlug}/structure`, icon: IconSitemap, label: "Structure" },
    { to: `/projects/${currentProjectSlug}/search`, icon: IconSearch, label: "Recherche" },
    { to: `/projects/${currentProjectSlug}/connections`, icon: IconBrain, label: "Carte Mentale" },
    { to: `/projects/${currentProjectSlug}/research`, icon: IconFileText, label: "Documentation" },
    { to: `/projects/${currentProjectSlug}/dictionary`, icon: IconBook, label: "Dictionnaire" },
    { to: `/projects/${currentProjectSlug}/matter`, icon: IconLayers, label: "Liminaire" },
    { to: `/projects/${currentProjectSlug}/cover`, icon: IconImage, label: "Couverture" },
    { to: `/projects/${currentProjectSlug}/export`, icon: IconPackage, label: "Exporter" },
  ] : [];
  const railLinks = currentProjectSlug ? projectLinks : globalLinks;

  return (
    <div className="studio-app">
      <header className="studio-topbar">
        <div className="topbar-left">
          <div className="topbar-brand" onClick={() => navigate("/dashboard")}>
            <IconFeather className="brand-icon" />
            <div className="topbar-brand-text"><span className="brand-title">InkRise</span><span className="brand-subtitle">Zen Writing Studio</span></div>
          </div>
        </div>
        <div className="topbar-right">
          {currentProject && (
            <div style={{ position: "relative" }} ref={dropdownRef}>
              <div className="project-selector" onClick={() => setProjectDropdown(v => !v)}>Project: <strong>{currentProject.title}</strong> <span>▾</span></div>
              {projectDropdown && (
                <div className="project-dropdown">
                  {session.projects.map(p => { const t = `/projects/${p.slug}/stats`; return <button key={p.slug} className={cx("project-dropdown-item", p.slug === currentProjectSlug && "is-active")} onClick={() => { navigate(t); setProjectDropdown(false); }}><span className="project-dropdown-dot" style={{ backgroundColor: p.accentColor }} />{p.title}</button>; })}
                  <button className="project-dropdown-item" onClick={() => { navigate("/dashboard"); setProjectDropdown(false); }}><IconLibrary style={{ width: 14, height: 14 }} /> Bibliothèque</button>
                </div>
              )}
            </div>
          )}
          <div className="user-badge" onClick={() => navigate("/profile")}>
            <span className="avatar-circle">{(session.user?.firstName || session.user?.username || "U")[0].toUpperCase()}</span>
            <span>{session.user?.profile?.penName || session.user?.firstName || session.user?.username}</span>
          </div>
        </div>
      </header>
      <div className="studio-body">
        <nav className="studio-rail">
          {railLinks.map(l => <NavLink key={l.to} to={l.to} className={({ isActive }) => cx("rail-btn", isActive && "is-active")} title={l.label}><l.icon /></NavLink>)}
          <div className="rail-spacer" />
          {currentProjectSlug && <><NavLink to={`/projects/${currentProjectSlug}/edit`} className={({ isActive }) => cx("rail-btn", isActive && "is-active")} title="Paramètres"><IconSettings /></NavLink><div className="rail-divider" /></>}
          {!currentProjectSlug && <div className="rail-divider" />}
          <button type="button" className="rail-btn rail-btn--logout" onClick={handleLogout} title="Déconnexion"><IconLogout /></button>
        </nav>
        {children}
      </div>
    </div>
  );
}

function PageLayout({ title, subtitle, actions, children }) {
  return (<div className="studio-main"><div className="studio-main-inner">
    <div className="page-header"><div className="page-header-text"><div className="section-label">{subtitle || "InkRise"}</div><h1>{title}</h1></div>{actions && <div className="page-header-actions">{actions}</div>}</div>
    {children}
  </div></div>);
}

function useCrudPage(projectSlug, apiPath, listKey) {
  const [project, setProject] = useState(null); const [items, setItems] = useState([]); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const [pp, lp] = await Promise.all([apiFetch(`/api/projects/${projectSlug}/`), apiFetch(`/api/projects/${projectSlug}/${apiPath}/`)]); setProject(pp.project); setItems(lp[listKey] || []); setLoading(false); } catch (e) { setError(extractErrorMessage(e)); setLoading(false); } }, [projectSlug, apiPath, listKey]);
  useEffect(() => { load(); }, [load]);
  const save = async (body) => { const p = await apiFetch(`/api/projects/${projectSlug}/${apiPath}/`, { method: "POST", body }); setItems(p[listKey] || []); return p; };
  const remove = async (id) => { const p = await apiFetch(`/api/projects/${projectSlug}/${apiPath}/${id}/`, { method: "DELETE" }); setItems(p[listKey] || []); };
  return { project, items, loading, error, load, save, remove };
}

/* ─── Login / Register ─── */
function LoginPage() {
  const { refreshSession } = useSession(); const navigate = useNavigate();
  const [form, setForm] = useState({ username: "", password: "" }); const [status, setStatus] = useState({ saving: false, error: "" });
  const submit = async (e) => { e.preventDefault(); setStatus({ saving: true, error: "" }); try { await apiFetch("/api/auth/login/", { method: "POST", body: form }); await refreshSession(); navigate("/dashboard"); } catch (err) { setStatus({ saving: false, error: extractErrorMessage(err) }); } };
  return (
    <AuthLayout title="Bon retour" subtitle="Connectez-vous pour continuer à écrire.">
      <form className="stack-form" onSubmit={submit}>
        <Field label="Nom d'utilisateur"><input className="input" value={form.username} onChange={e => setForm(c => ({ ...c, username: e.target.value }))} placeholder="Identifiant" autoComplete="username" /></Field>
        <Field label="Mot de passe"><input className="input" type="password" value={form.password} onChange={e => setForm(c => ({ ...c, password: e.target.value }))} placeholder="Mot de passe" autoComplete="current-password" /></Field>
        {status.error && <div className="inline-error">{status.error}</div>}
        <Btn variant="primary" type="submit" disabled={status.saving}>{status.saving ? "Connexion..." : "Se connecter"}</Btn>
      </form>
      <p className="auth-forgot"><a href="/accounts/password_reset/" className="auth-forgot-link">Mot de passe oublié ?</a></p>
      <div className="auth-switch"><span>Pas de compte ?</span><Link to="/register">Créer un compte</Link></div>
    </AuthLayout>
  );
}

function RegisterPage() {
  const { refreshSession } = useSession(); const navigate = useNavigate();
  const [form, setForm] = useState({ username: "", first_name: "", email: "", password1: "", password2: "" }); const [status, setStatus] = useState({ saving: false, error: "" });
  const submit = async (e) => { e.preventDefault(); setStatus({ saving: true, error: "" }); try { await apiFetch("/api/auth/register/", { method: "POST", body: form }); await refreshSession(); navigate("/dashboard"); } catch (err) { setStatus({ saving: false, error: extractErrorMessage(err) }); } };
  return (<AuthLayout title="Créer votre espace" subtitle="Un environnement d'écriture privé."><form className="stack-form" onSubmit={submit}><Field label="Identifiant"><input className="input" value={form.username} onChange={e => setForm(c => ({ ...c, username: e.target.value }))} /></Field><Field label="Prénom"><input className="input" value={form.first_name} onChange={e => setForm(c => ({ ...c, first_name: e.target.value }))} /></Field><Field label="E-mail"><input className="input" type="email" value={form.email} onChange={e => setForm(c => ({ ...c, email: e.target.value }))} /></Field><Field label="Mot de passe"><input className="input" type="password" value={form.password1} onChange={e => setForm(c => ({ ...c, password1: e.target.value }))} /></Field><Field label="Confirmer"><input className="input" type="password" value={form.password2} onChange={e => setForm(c => ({ ...c, password2: e.target.value }))} /></Field>{status.error && <div className="inline-error">{status.error}</div>}<Btn variant="primary" type="submit" disabled={status.saving}>{status.saving ? "Création..." : "Créer le compte"}</Btn></form><div className="auth-switch"><span>Déjà inscrit ?</span><Link to="/login">Connexion</Link></div></AuthLayout>);
}

/* ─── Dashboard ─── */
function DashboardPage() {
  const { session } = useSession();
  const totalWords = session.projects.reduce((t, p) => t + p.totalWordCount, 0);
  return (
    <AppLayout>
      <PageLayout
        title="Vos projets"
        subtitle={t("dashboard.activeProjects", session.projects.length)}
        actions={<Link className="btn-primary" to="/projects/new"><IconPlus style={{ width: 14, height: 14 }} /> Nouveau projet</Link>}
      >
        <div className="dashboard-library-layout">
          <section className="dashboard-library-shelf surface">
            <div className="surface-header">
              <div>
                <div className="section-label">Bibliothèque</div>
                <h2>{t("dashboard.recentBooks")}</h2>
              </div>
            </div>
            <div className="library-book-grid">
              {session.projects.map(project => (
                <article key={project.slug} className="library-book-card">
                  <Link className="library-book-cover" to={`/projects/${project.slug}/stats`} aria-label={`Ouvrir ${project.title}`}>
                    <div className="library-book-object" style={{ "--book-accent": project.accentColor, "--book-accent-soft": `${project.accentColor}55` }}>
                      {project.coverThumbnailUrl ? (
                        <img src={project.coverThumbnailUrl} alt="" className="library-book-object-img" />
                      ) : (
                        <div className="library-book-fallback">
                          <div className="library-book-spine" />
                          <div className="library-book-face" />
                        </div>
                      )}
                    </div>
                  </Link>
                  <div className="library-book-meta">
                    <strong>{project.title}</strong>
                    <span>{project.genre || "Fiction"}</span>
                    <p>{project.logline || "Ajustez le résumé du projet pour l’avoir ici."}</p>
                    <small>Dernière modification : {formatLongWhen(project.lastActivityAt || project.updatedAt)}</small>
                  </div>
                  <div className="library-book-actions">
                    <Link className="btn-primary" to={`/projects/${project.slug}/stats`}>Ouvrir</Link>
                    <Link className="btn-ghost" to={`/projects/${project.slug}/edit`}>Paramètres</Link>
                  </div>
                </article>
              ))}
              {!session.projects.length && <article className="empty-state"><h3>{t("dashboard.emptyTitle")}</h3><p>{t("dashboard.emptyHint")}</p></article>}
            </div>
          </section>
          <aside className="dashboard-library-sidebar">
            <section className="surface surface--compact">
              <div className="section-label">Auteur</div>
              <h2 style={{ marginTop: "4px" }}>{session.user?.profile?.penName || session.user?.firstName || session.user?.username}</h2>
              <div className="metric-stack">
                <div className="metric-pill"><span>Projets</span><strong>{session.projects.length}</strong></div>
                <div className="metric-pill"><span>Mots</span><strong>{totalWords.toLocaleString("fr-FR")}</strong></div>
              </div>
            </section>
            <section className="surface surface--compact">
              <div className="section-label">Reprise</div>
              <h3 style={{ marginBottom: 8 }}>Continuer là où vous vous êtes arrêté</h3>
              {session.projects[0] ? (
                <>
                  <p style={{ color: "var(--muted)", marginBottom: 12 }}>{session.projects[0].title}</p>
                  <Link className="btn-primary" to={`/projects/${session.projects[0].slug}/stats`}>Ouvrir le cockpit</Link>
                </>
              ) : (
                <p style={{ color: "var(--muted)" }}>Votre bibliothèque apparaîtra ici dès le premier projet créé.</p>
              )}
            </section>
          </aside>
        </div>
      </PageLayout>
    </AppLayout>
  );
}

/* ─── Project Form ─── */
function ProjectFormPage({ mode }) {
  const { projectSlug } = useParams(); const { refreshSession } = useSession(); const navigate = useNavigate();
  const [loading, setLoading] = useState(mode === "edit"); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: "", logline: "", description: "", genre: "", accent_color: "#c49a6c" });
  useEffect(() => { let a = true; if (mode !== "edit") { setLoading(false); return; } apiFetch(`/api/projects/${projectSlug}/`).then(p => { if (!a) return; setForm({ title: p.project.title, logline: p.project.logline, description: p.project.description, genre: p.project.genre, accent_color: p.project.accentColor }); setLoading(false); }).catch(e => { if (!a) return; setError(extractErrorMessage(e)); setLoading(false); }); return () => { a = false; }; }, [mode, projectSlug]);
  const submit = async (e) => { e.preventDefault(); setSaving(true); setError(""); try { if (mode === "edit") { const p = await apiFetch(`/api/projects/${projectSlug}/`, { method: "PUT", body: form }); await refreshSession(); navigate(`/projects/${p.project.slug}/stats`); } else { const p = await apiFetch("/api/projects/", { method: "POST", body: form }); await refreshSession(); navigate(`/projects/${p.project.slug}/stats`); } } catch (e) { setError(extractErrorMessage(e)); setSaving(false); } };
  if (loading) return <LoadingScreen />;
  if (error && mode === "edit") return <ErrorState title="Erreur" message={error} />;
  return (<AppLayout currentProjectSlug={projectSlug}><PageLayout title={mode === "edit" ? "Modifier le projet" : "Nouveau projet"} subtitle="Configuration"><section className="surface" style={{ maxWidth: "700px" }}><form className="stack-form stack-form--wide" onSubmit={submit}><div className="form-grid"><Field label="Titre"><input className="input" value={form.title} onChange={e => setForm(c => ({ ...c, title: e.target.value }))} /></Field><Field label="Genre"><input className="input" value={form.genre} onChange={e => setForm(c => ({ ...c, genre: e.target.value }))} /></Field></div><Field label="Accroche"><input className="input" value={form.logline} onChange={e => setForm(c => ({ ...c, logline: e.target.value }))} /></Field><Field label="Description"><textarea className="input textarea" rows="5" value={form.description} onChange={e => setForm(c => ({ ...c, description: e.target.value }))} /></Field><Field label="Couleur"><input className="color-input" type="color" value={form.accent_color} onChange={e => setForm(c => ({ ...c, accent_color: e.target.value }))} /></Field>{error && <div className="inline-error">{error}</div>}<div className="button-row"><Btn variant="primary" type="submit" disabled={saving}>{saving ? "..." : "Enregistrer"}</Btn><Link className="btn-ghost" to="/dashboard">Retour</Link></div></form></section></PageLayout></AppLayout>);
}

/* ─── Workspace (Editor) ─── */
function WorkspacePage() {
  const { projectSlug, chapterId } = useParams(); const navigate = useNavigate(); const [searchParams] = useSearchParams();
  const highlightPhrase = searchParams.get("highlight") || "";
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [data, setData] = useState(null);
  const [title, setTitle] = useState(""); const [content, setContent] = useState(""); const [summary, setSummary] = useState("");
  const [notes, setNotes] = useState([]); const [dictionaryPreview, setDictionaryPreview] = useState([]); const [dictionaryGlossary, setDictionaryGlossary] = useState([]);
  const [formatting, setFormatting] = useState({ fontFamily: "serif", fontSize: 17, lineHeight: 1.85, manuscriptWidth: 780 });
  const [saveState, setSaveState] = useState("Prêt"); const [summaryState, setSummaryState] = useState("Prêt");
  const [noteForm, setNoteForm] = useState({ id: null, title: "", body: "", pinned: false });
  const [dictionaryForm, setDictionaryForm] = useState({ term: "", definition: "", usageNotes: "" });
  const [tools, setTools] = useState({ lookupTerm: "", lookupResults: [], lookupMessage: "", draftText: "", correctedText: "", correctMessage: "" });
  const [formattingState, setFormattingState] = useState(""); const [searchQuery, setSearchQuery] = useState(""); const [searchResults, setSearchResults] = useState([]);
  const [zenMode, setZenMode] = useState(false); const [showSearch, setShowSearch] = useState(false);
  const [showNav, setShowNav] = useState(true); const [showContext, setShowContext] = useState(false);
  const [characters, setCharacters] = useState([]);
  const contentRef = useRef(""); const zenEditorRef = useRef(null); const zenQuillRef = useRef(null);
  const autosaveTimerRef = useRef(null); const summaryTimerRef = useRef(null);
  const suppressAutosaveRef = useRef(true); const suppressSummaryRef = useRef(true);

  const loadWorkspace = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [p, charsRes] = await Promise.all([
        apiFetch(chapterId ? `/api/projects/${projectSlug}/workspace/${chapterId}/` : `/api/projects/${projectSlug}/workspace/`),
        apiFetch(`/api/projects/${projectSlug}/characters/`).catch(() => ({ characters: [] }))
      ]);
      setData(p); setTitle(p.currentChapter.title); setContent(p.currentChapter.content || "");
      contentRef.current = p.currentChapter.content || "";
      setSummary(p.currentChapter.summary || ""); setNotes(p.currentChapter.notes || []);
      setDictionaryPreview(p.project.dictionaryPreview || []);
      setDictionaryGlossary(p.dictionaryGlossary || []);
      setFormatting(p.project.formatting);
      setNoteForm({ id: null, title: "", body: "", pinned: false });
      setSaveState("Prêt"); setSummaryState("Prêt"); setCharacters(charsRes.characters || []);
      suppressAutosaveRef.current = true; suppressSummaryRef.current = true;
      setLoading(false);
    } catch (e) { setError(extractErrorMessage(e)); setLoading(false); }
  }, [chapterId, projectSlug]);
  useEffect(() => { loadWorkspace(); }, [loadWorkspace]);

  const patchCurrentChapter = useCallback((patch, nextProject = null) => { setData(c => { if (!c) return c; const nc = { ...c.currentChapter, ...patch }; const ncs = (nextProject?.chapters || c.project.chapters).map(ch => ch.id === nc.id ? { ...ch, title: nc.title, wordCount: nc.wordCount, characterCount: nc.characterCount } : ch); return { ...c, currentChapter: nc, project: nextProject ? { ...nextProject, chapters: ncs } : { ...c.project, chapters: ncs } }; }); }, []);

  const handleContentChange = useCallback((newContent) => {
    contentRef.current = newContent;
    setContent(newContent);
  }, []);

  useEffect(() => { if (!data?.currentChapter?.id) return; if (suppressAutosaveRef.current) { suppressAutosaveRef.current = false; return; } window.clearTimeout(autosaveTimerRef.current); setSaveState("Sauvegarde..."); autosaveTimerRef.current = window.setTimeout(async () => { try { const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${data.currentChapter.id}/autosave/`, { method: "POST", body: { title, content } }); patchCurrentChapter({ id: p.chapter.id, title: p.chapter.title, wordCount: p.chapter.wordCount, characterCount: p.chapter.characterCount, content }, p.project || null); setSaveState(`Sauvé ${formatSavedAt(p.chapter.savedAt)}`); } catch (e) { setSaveState(extractErrorMessage(e)); } }, 850); return () => window.clearTimeout(autosaveTimerRef.current); }, [title, content, data?.currentChapter?.id, patchCurrentChapter, projectSlug]);

  useEffect(() => { if (!data?.currentChapter?.id) return; if (suppressSummaryRef.current) { suppressSummaryRef.current = false; return; } window.clearTimeout(summaryTimerRef.current); setSummaryState("..."); summaryTimerRef.current = window.setTimeout(async () => { try { const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${data.currentChapter.id}/summary/`, { method: "POST", body: { summary } }); patchCurrentChapter({ summary: p.summary }); setSummaryState(`Sauvé`); } catch (e) { setSummaryState(extractErrorMessage(e)); } }, 850); return () => window.clearTimeout(summaryTimerRef.current); }, [summary, data?.currentChapter?.id, patchCurrentChapter, projectSlug]);

  const createChapter = async () => { const p = await apiFetch(`/api/projects/${projectSlug}/chapters/`, { method: "POST", body: {} }); setData(c => (c ? { ...c, project: { ...c.project, chapters: p.chapters } } : c)); navigate(`/projects/${projectSlug}/workspace/${p.chapter.id}`); };
  const moveChapter = async (id, dir) => { const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${id}/move/`, { method: "POST", body: { direction: dir } }); setData(c => (c ? { ...c, project: { ...c.project, chapters: p.chapters } } : c)); };
  const deleteChapter = async (id) => { if (!window.confirm("Supprimer ce chapitre ?")) return; const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${id}/`, { method: "DELETE" }); setData(c => (c ? { ...c, project: { ...c.project, chapters: p.chapters } } : c)); navigate(`/projects/${projectSlug}/workspace/${p.nextChapterId}`); };
  const saveNote = async (e) => { e.preventDefault(); const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${data.currentChapter.id}/notes/`, { method: "POST", body: noteForm }); setNotes(p.notes); patchCurrentChapter({ notes: p.notes }); setNoteForm({ id: null, title: "", body: "", pinned: false }); };
  const removeNote = async (nid) => { const p = await apiFetch(`/api/projects/${projectSlug}/chapters/${data.currentChapter.id}/notes/${nid}/`, { method: "DELETE" }); setNotes(p.notes); };
  const saveDictionaryEntry = async (e) => {
    e.preventDefault();
    const p = await apiFetch(`/api/projects/${projectSlug}/dictionary/`, { method: "POST", body: dictionaryForm });
    setDictionaryPreview(p.entries.slice(0, 8));
    setDictionaryGlossary(p.entries);
    setDictionaryForm({ term: "", definition: "", usageNotes: "" });
  };
  const saveFormatting = async () => { try { const p = await apiFetch(`/api/projects/${projectSlug}/formatting/`, { method: "POST", body: formatting }); setFormatting(p.formatting); setFormattingState("Sauvé"); } catch (e) { setFormattingState(extractErrorMessage(e)); } };
  const lookupSynonyms = async () => { if (!tools.lookupTerm.trim()) return; try { const p = await apiFetch(`/api/projects/${projectSlug}/thesaurus/?term=${encodeURIComponent(tools.lookupTerm)}`); setTools(c => ({ ...c, lookupResults: p.matches || [], lookupMessage: p.matches?.length ? "" : "Aucun résultat." })); } catch (e) { setTools(c => ({ ...c, lookupMessage: extractErrorMessage(e), lookupResults: [] })); } };
  const correctText = async () => { try { const p = await apiFetch(`/api/projects/${projectSlug}/correct-text/`, { method: "POST", body: { text: tools.draftText } }); setTools(c => ({ ...c, correctedText: p.corrected, correctMessage: p.corrected ? "" : "Rien à corriger." })); } catch (e) { setTools(c => ({ ...c, correctedText: "", correctMessage: extractErrorMessage(e) })); } };
  const runSearch = async () => { if (!searchQuery.trim()) return; try { const p = await apiFetch(`/api/projects/${projectSlug}/search/?q=${encodeURIComponent(searchQuery)}`); setSearchResults(p.results || []); } catch { setSearchResults([]); } };

  useEffect(() => { if (!zenMode) return; const h = (e) => { if (e.key === "Escape") setZenMode(false); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [zenMode]);

  useEffect(() => {
    if (!zenMode || !zenEditorRef.current || zenQuillRef.current) return;
    zenQuillRef.current = new Quill(zenEditorRef.current, { modules: { toolbar: "#zen-toolbar", history: { delay: 500, maxStack: 100, userOnly: true } }, placeholder: "Concentrez-vous...", theme: "snow" });
    zenQuillRef.current.clipboard.dangerouslyPasteHTML(contentRef.current || "");
    let init = true;
    zenQuillRef.current.on("text-change", () => { if (init) return; const html = normalizeHtml(zenQuillRef.current.root.innerHTML); contentRef.current = html; setContent(html); });
    setTimeout(() => { init = false; }, 50);
    return () => { zenQuillRef.current = null; };
  }, [zenMode]);

  if (loading) return <LoadingScreen label="Chargement..." />;
  if (error || !data) return <ErrorState title="Erreur" message={error || "Aucune donnée."} action={<Btn onClick={loadWorkspace}>Réessayer</Btn>} />;
  const project = data.project; const cc = data.currentChapter;
  const livePlainText = plainTextFromHtml(content);
  const liveWordCount = countWordsInText(livePlainText);
  const liveCharacterCount = livePlainText.length;

  return (
    <>
      {zenMode && (
        <div className="zen-overlay">
          <div className="zen-header"><div className="zen-header-left"><span style={{ color: "var(--muted)" }}>{project.title}</span><span style={{ color: "var(--muted)", fontSize: "10px" }}>·</span><span style={{ fontWeight: 600 }}>{title}</span></div><div className="zen-header-right"><span className="status-badge">{liveWordCount.toLocaleString("fr-FR")} mots</span><span className="status-badge status-badge--accent">{saveState}</span><button type="button" className="zen-exit-btn" onClick={() => setZenMode(false)}>Échap · Quitter</button></div></div>
          <div className="zen-body">
            <input className="zen-title-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Titre" />
            <div id="zen-toolbar" className="zen-toolbar editor-toolbar-bar"><span className="ql-formats"><button className="ql-bold" type="button" /><button className="ql-italic" type="button" /><button className="ql-underline" type="button" /></span><span className="ql-formats"><select className="ql-header" defaultValue=""><option value="" /><option value="1" /><option value="2" /></select><button className="ql-list" value="ordered" type="button" /><button className="ql-list" value="bullet" type="button" /></span><span className="ql-formats"><button className="ql-blockquote" type="button" /><button className="ql-link" type="button" /><button className="ql-image" type="button" /><button className="ql-clean" type="button" /></span></div>
            <div className="zen-editor-wrap"><div className="manuscript-page"><div ref={zenEditorRef} /></div></div>
          </div>
        </div>
      )}
      <AppLayout currentProjectSlug={project.slug}>
        <div className={cx("workspace-layout", showNav && "show-nav", showContext && "show-context")}>
          {showNav && (
            <aside className="manuscript-nav">
              <div className="nav-header"><h2>Navigator</h2><div className="nav-header-actions"><button type="button" className="nav-header-btn" onClick={createChapter} title="Ajouter">+</button></div></div>
              <div className="nav-tree">
                <div className="tree-project-label"><IconFolder className="nav-icon" /> {project.title}</div>
                {project.chapters.map(ch => (
                  <div key={ch.id} className={cx("tree-chapter", cc.id === ch.id && "is-active")} onClick={() => navigate(`/projects/${projectSlug}/workspace/${ch.id}`)}>
                    <IconDoc className="nav-icon" /><span className="tree-chapter-title">{ch.title}</span><span className="tree-chapter-meta">{ch.wordCount.toLocaleString("fr-FR")}</span>
                    <div className="tree-chapter-actions"><button type="button" onClick={e => { e.stopPropagation(); moveChapter(ch.id, "up"); }}>↑</button><button type="button" onClick={e => { e.stopPropagation(); moveChapter(ch.id, "down"); }}>↓</button><button type="button" onClick={e => { e.stopPropagation(); deleteChapter(ch.id); }}>×</button></div>
                  </div>
                ))}
                {!project.chapters.length && <div className="tree-empty">Aucun chapitre</div>}
              </div>
            </aside>
          )}

          <div className="editor-area">
            <div className="editor-topbar">
              <div className="editor-topbar-left">
                <button type="button" className={cx("panel-toggle-btn", showNav && "is-active")} onClick={() => setShowNav(v => !v)} title="Navigator"><IconSidebar /></button>
                <div className="editor-breadcrumb"><span>{project.title}</span><span>/</span><strong>{cc.title}</strong></div>
              </div>
              <div className="editor-topbar-right">
                <span className="status-badge status-badge--accent">{saveState}</span>
                <div className="zen-mode-toggle" onClick={() => setZenMode(true)}><span>Zen</span><div className={cx("toggle-switch", zenMode && "is-on")} /></div>
                <button type="button" className="editor-icon-btn" onClick={() => setShowSearch(v => !v)} title="Rechercher"><IconSearch /></button>
                <button type="button" className={cx("panel-toggle-btn", showContext && "is-active")} onClick={() => setShowContext(v => !v)} title="Context"><IconPanelRight /></button>
              </div>
            </div>
            {showSearch && (
              <div className="search-overlay"><div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}><input className="input" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Rechercher..." onKeyDown={e => e.key === "Enter" && runSearch()} autoFocus /><Btn onClick={runSearch}><IconSearch /></Btn></div>{searchResults.length > 0 && <div className="context-list">{searchResults.map((r, i) => <div key={`${r.type}-${r.id}-${i}`} className="context-list-row" style={{ cursor: "pointer" }} onClick={() => { navigate(r.url || `/projects/${projectSlug}/workspace/${r.chapterId}`); setShowSearch(false); }}><strong>{r.title}</strong>{r.meta && <small style={{ color: "var(--muted)", marginLeft: 6 }}>{r.meta}</small>}<p>{r.snippet}</p></div>)}</div>}{searchQuery && !searchResults.length && <div className="inline-note">Aucun résultat.</div>}<div className="inline-note" style={{ marginTop: 8 }}><Link to={`/projects/${projectSlug}/search?q=${encodeURIComponent(searchQuery)}`} onClick={() => setShowSearch(false)}>Recherche avancée</Link></div></div>
            )}
            {!zenMode && (
              <QuillEditor
                key={`editor-${cc.id}`}
                initialContent={cc.content}
                onChange={handleContentChange}
                projectSlug={projectSlug}
                chapterId={cc.id}
                onSaveState={setSaveState}
                glossary={dictionaryGlossary}
                highlightPhrase={highlightPhrase}
              />
            )}
            <div className="editor-status-bar">
              <span>● {saveState}</span>
              <span>UTF-8</span>
              <span>{liveWordCount.toLocaleString("fr-FR")} mots · {liveCharacterCount.toLocaleString("fr-FR")} signes · ~{pages(liveWordCount)} p.</span>
            </div>
          </div>

          {showContext && (
            <aside className="context-panel">
              <div className="context-panel-header"><h2>Research & Context</h2></div>
              <div className="context-panel-body">
                <Accordion title="Character Card" defaultOpen={true}>
                  <div className="character-card-display">{characters.slice(0, 3).map(ch => (<div key={ch.id} className="character-card-item"><div className="character-card-item-header"><div className="character-avatar">{(ch.name || "?")[0]}</div><div><strong>{ch.name}</strong><small>{ch.role || "Personnage"}</small></div></div>{(ch.summary || ch.notes) && <dl className="character-card-fields">{ch.summary && <div className="character-card-field"><dt>Traits</dt><dd>{ch.summary}</dd></div>}{ch.notes && <div className="character-card-field"><dt>Notes</dt><dd>{ch.notes.length > 100 ? ch.notes.slice(0, 100) + "..." : ch.notes}</dd></div>}</dl>}</div>))}{!characters.length && <div style={{ fontSize: "11px", color: "var(--muted)" }}>Aucun personnage. <Link to={`/projects/${projectSlug}/characters`} style={{ color: "var(--accent)" }}>Ajouter</Link></div>}</div>
                </Accordion>
                <Accordion title="Résumé" defaultOpen={false}><div className="context-form"><textarea className="input textarea" rows="5" value={summary} onChange={e => setSummary(e.target.value)} placeholder="Intention de scène..." /><span className={cx("context-save-state", summaryState === "Sauvé" && "is-accent")}>{summaryState}</span></div></Accordion>
                <Accordion title="Notes privées" defaultOpen={false}><div className="context-form"><form className="context-form" onSubmit={saveNote}><Field label="Titre"><input className="input" value={noteForm.title} onChange={e => setNoteForm(c => ({ ...c, title: e.target.value }))} /></Field><Field label="Contenu"><textarea className="input textarea" rows="2" value={noteForm.body} onChange={e => setNoteForm(c => ({ ...c, body: e.target.value }))} /></Field><Btn variant="primary" type="submit">{noteForm.id ? "Modifier" : "+"}</Btn></form>{notes.length > 0 && <div className="context-list">{notes.map(n => <div key={n.id} className="context-list-row"><div className="context-list-topline"><strong>{n.title}</strong><div className="context-mini-actions"><button type="button" onClick={() => setNoteForm({ id: n.id, title: n.title, body: n.body, pinned: n.pinned })}>✎</button><button type="button" onClick={() => removeNote(n.id)}>×</button></div></div><p>{n.body}</p></div>)}</div>}</div></Accordion>
                <Accordion title="Dictionnaire" defaultOpen={false}><div className="context-form"><form className="context-form" onSubmit={saveDictionaryEntry}><Field label="Terme"><input className="input" value={dictionaryForm.term} onChange={e => setDictionaryForm(c => ({ ...c, term: e.target.value }))} /></Field><Field label="Définition"><textarea className="input textarea" rows="2" value={dictionaryForm.definition} onChange={e => setDictionaryForm(c => ({ ...c, definition: e.target.value }))} /></Field><Btn variant="primary" type="submit">+</Btn></form>{dictionaryPreview.length > 0 && <div className="context-list">{dictionaryPreview.map(e => <div key={e.id} className="context-list-row"><strong>{e.term}</strong><p>{e.definition}</p></div>)}</div>}</div></Accordion>
                <Accordion title="Outils" defaultOpen={false}><div className="context-form"><Field label="Thésaurus"><input className="input" value={tools.lookupTerm} onChange={e => setTools(c => ({ ...c, lookupTerm: e.target.value }))} placeholder="Mot" /></Field><Btn onClick={lookupSynonyms}>Synonymes</Btn>{tools.lookupResults.length > 0 && <div className="context-list">{tools.lookupResults.map(r => <div key={r.term} className="context-list-row"><strong>{r.term}</strong><p>{r.synonyms.join(", ")}</p></div>)}</div>}<div className="divider" /><Field label="Correcteur"><textarea className="input textarea" rows="2" value={tools.draftText} onChange={e => setTools(c => ({ ...c, draftText: e.target.value }))} /></Field><Btn onClick={correctText}>Corriger</Btn>{tools.correctedText && <div className="tool-output"><p>{tools.correctedText}</p></div>}</div></Accordion>
                <Accordion title="Mise en forme" defaultOpen={false}><div className="context-form"><Field label="Police"><select className="input" value={formatting.fontFamily} onChange={e => setFormatting(c => ({ ...c, fontFamily: e.target.value }))}><option value="serif">Serif</option><option value="sans">Sans</option><option value="mono">Mono</option></select></Field><Field label="Taille"><input className="input" type="number" min="14" max="28" value={formatting.fontSize} onChange={e => setFormatting(c => ({ ...c, fontSize: Number(e.target.value) }))} /></Field><Btn variant="primary" onClick={saveFormatting}>Sauvegarder</Btn></div></Accordion>
              </div>
            </aside>
          )}
        </div>
        <div className="editor-stats-widget"><dl><dt>WORDS</dt><dd>{liveWordCount.toLocaleString("fr-FR")}</dd></dl><div className="stat-divider" /><dl><dt>PAGES</dt><dd>{pages(liveWordCount)}</dd></dl></div>
      </AppLayout>
    </>
  );
}

function SearchPage() {
  const { projectSlug } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const qUrl = searchParams.get("q") || "";
  const [localQ, setLocalQ] = useState(qUrl);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const project = session.projects.find(p => p.slug === projectSlug);

  useEffect(() => { setLocalQ(qUrl); }, [qUrl]);

  useEffect(() => {
    if (qUrl.trim().length < 2) {
      setResults([]);
      return;
    }
    let cancel = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const p = await apiFetch(`/api/projects/${projectSlug}/search/?q=${encodeURIComponent(qUrl)}`);
        if (!cancel) setResults(p.results || []);
      } catch (e) {
        if (!cancel) {
          setError(extractErrorMessage(e));
          setResults([]);
        }
      }
      if (!cancel) setLoading(false);
    })();
    return () => { cancel = true; };
  }, [projectSlug, qUrl]);

  const run = () => {
    const q = localQ.trim();
    if (q.length < 2) return;
    setSearchParams({ q });
  };

  const grouped = useMemo(() => {
    const m = {};
    for (const r of results) {
      const k = r.type || "other";
      if (!m[k]) m[k] = [];
      m[k].push(r);
    }
    return m;
  }, [results]);

  const typeLabel = t => ({
    chapter: "Texte — chapitres",
    chapter_title: "Titres de chapitres",
    note: "Notes",
    dictionary: "Dictionnaire",
    character: "Personnages",
    place: "Lieux",
    research: "Documentation",
  }[t] || t);

  return (
    <AppLayout currentProjectSlug={projectSlug}>
      <PageLayout title="Recherche" subtitle={project?.title || "Projet"}>
        <section className="surface" style={{ maxWidth: 880 }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <input className="input" style={{ flex: "1 1 240px" }} value={localQ} onChange={e => setLocalQ(e.target.value)} placeholder="Mot-clé (2 caractères min.)…" onKeyDown={e => e.key === "Enter" && run()} />
            <Btn variant="primary" onClick={run} disabled={loading}>Rechercher</Btn>
          </div>
          {error && <div className="inline-error">{error}</div>}
          {loading && <p className="inline-note">Recherche en cours…</p>}
          {!loading && qUrl.length >= 2 && !results.length && !error && <p className="inline-note">Aucun résultat pour « {qUrl} ».</p>}
          {Object.keys(grouped).map(type => (
            <div key={type} style={{ marginTop: 22 }}>
              <div className="section-label">{typeLabel(type)}</div>
              <div className="context-list">
                {grouped[type].map(r => (
                  <div key={`${r.type}-${r.id}`} className="context-list-row" style={{ cursor: "pointer" }} onClick={() => navigate(r.url)} role="presentation">
                    <div><strong>{r.title}</strong>{r.meta ? <small style={{ color: "var(--muted)", marginLeft: 8 }}>{r.meta}</small> : null}</div>
                    <p>{r.snippet}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      </PageLayout>
    </AppLayout>
  );
}

/* ─── Dictionary / Characters / Places / Connections / Research / Matter ─── */
function DictionaryPage() { const { projectSlug } = useParams(); const { project, items: entries, loading, error, load, save, remove } = useCrudPage(projectSlug, "dictionary", "entries"); const [form, setForm] = useState({ id: null, term: "", definition: "", usageNotes: "" }); const saveEntry = async (e) => { e.preventDefault(); await save(form); setForm({ id: null, term: "", definition: "", usageNotes: "" }); }; if (loading) return <LoadingScreen />; if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />; return (<AppLayout currentProjectSlug={project.slug}><PageLayout title="Dictionnaire" subtitle="Glossaire"><div className="content-grid"><section className="surface"><div className="surface-header"><div><div className="section-label">Éditeur</div><h2>{form.id ? "Modifier" : "Ajouter"}</h2></div></div><form className="stack-form" onSubmit={saveEntry}><Field label="Terme"><input className="input" value={form.term} onChange={e => setForm(c => ({ ...c, term: e.target.value }))} /></Field><Field label="Définition"><textarea className="input textarea" rows="4" value={form.definition} onChange={e => setForm(c => ({ ...c, definition: e.target.value }))} /></Field><Field label="Notes"><input className="input" value={form.usageNotes} onChange={e => setForm(c => ({ ...c, usageNotes: e.target.value }))} /></Field><div className="button-row"><Btn variant="primary" type="submit">Enregistrer</Btn>{form.id && <button type="button" className="btn-ghost" onClick={() => setForm({ id: null, term: "", definition: "", usageNotes: "" })}>Annuler</button>}</div></form></section><section className="surface"><div className="surface-header"><div><div className="section-label">Glossaire</div><h2>{entries.length} termes</h2></div></div><div className="list-surface">{entries.map(e => <div key={e.id} className="list-row"><div className="list-row-topline"><strong>{e.term}</strong><div className="mini-actions"><button type="button" onClick={() => setForm({ id: e.id, term: e.term, definition: e.definition, usageNotes: e.usageNotes || "" })}>✎</button><button type="button" onClick={() => remove(e.id)}>×</button></div></div><p>{e.definition}</p></div>)}{!entries.length && <div style={{ padding: "12px 0", fontSize: "12px", color: "var(--muted)", textAlign: "center" }}>Vide</div>}</div></section></div></PageLayout></AppLayout>); }

function emptyCharacterForm() {
  return {
    id: null,
    name: "",
    role: "",
    summary: "",
    appearance: "",
    goals: "",
    conflicts: "",
    notes: "",
    classIds: [],
    firstName: "",
    lastName: "",
    nickname: "",
    pronouns: "",
    sexOrGender: "",
    species: "",
    age: "",
    birthDate: "",
    birthPlace: "",
    residence: "",
    occupation: "",
    personality: "",
    backstory: "",
    evolution: "",
    inventory: "",
    possessions: "",
    extras: "",
    starRating: 3,
  };
}

function characterToForm(ch) {
  return {
    id: ch.id,
    name: ch.name || "",
    role: ch.role || "",
    summary: ch.summary || "",
    appearance: ch.appearance || "",
    goals: ch.goals || "",
    conflicts: ch.conflicts || "",
    notes: ch.notes || "",
    classIds: ch.classIds || [],
    firstName: ch.firstName || "",
    lastName: ch.lastName || "",
    nickname: ch.nickname || "",
    pronouns: ch.pronouns || "",
    sexOrGender: ch.sexOrGender || "",
    species: ch.species || "",
    age: ch.age != null ? String(ch.age) : "",
    birthDate: ch.birthDate ? ch.birthDate.slice(0, 10) : "",
    birthPlace: ch.birthPlace || "",
    residence: ch.residence || "",
    occupation: ch.occupation || "",
    personality: ch.personality || "",
    backstory: ch.backstory || "",
    evolution: ch.evolution || "",
    inventory: ch.inventory || "",
    possessions: ch.possessions || "",
    extras: ch.extras || "",
    starRating: ch.starRating || 3,
  };
}

function CharactersPage() {
  const { projectSlug } = useParams();
  const [project, setProject] = useState(null);
  const [classes, setClasses] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [classForm, setClassForm] = useState({ id: null, name: "", description: "" });
  const [characterForm, setCharacterForm] = useState(emptyCharacterForm);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pp, cp] = await Promise.all([
        apiFetch(`/api/projects/${projectSlug}/`),
        apiFetch(`/api/projects/${projectSlug}/characters/`),
      ]);
      setProject(pp.project);
      setClasses(cp.classes);
      setCharacters(cp.characters);
      setLoading(false);
    } catch (e) {
      setError(extractErrorMessage(e));
      setLoading(false);
    }
  }, [projectSlug]);

  useEffect(() => { load(); }, [load]);

  const selected = characters.find(c => c.id === selectedId) || null;

  useEffect(() => {
    if (selected) setCharacterForm(characterToForm(selected));
    else setCharacterForm(emptyCharacterForm());
  }, [selectedId, characters]);

  const saveClass = async e => {
    e.preventDefault();
    const p = await apiFetch(`/api/projects/${projectSlug}/character-classes/`, { method: "POST", body: classForm });
    setClasses(p.classes);
    setClassForm({ id: null, name: "", description: "" });
  };

  const saveCharacter = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {
        id: characterForm.id,
        name: characterForm.name,
        role: characterForm.role,
        summary: characterForm.summary,
        appearance: characterForm.appearance,
        goals: characterForm.goals,
        conflicts: characterForm.conflicts,
        notes: characterForm.notes,
        classIds: characterForm.classIds,
        firstName: characterForm.firstName,
        lastName: characterForm.lastName,
        nickname: characterForm.nickname,
        pronouns: characterForm.pronouns,
        sexOrGender: characterForm.sexOrGender,
        species: characterForm.species,
        age: characterForm.age === "" ? null : Number(characterForm.age),
        birthDate: characterForm.birthDate || null,
        birthPlace: characterForm.birthPlace,
        residence: characterForm.residence,
        occupation: characterForm.occupation,
        personality: characterForm.personality,
        backstory: characterForm.backstory,
        evolution: characterForm.evolution,
        inventory: characterForm.inventory,
        possessions: characterForm.possessions,
        extras: characterForm.extras,
        starRating: Math.min(5, Math.max(1, Number(characterForm.starRating) || 3)),
      };
      const p = await apiFetch(`/api/projects/${projectSlug}/characters/`, { method: "POST", body });
      setClasses(p.classes);
      setCharacters(p.characters);
      if (!characterForm.id && p.characters?.length) {
        const newest = p.characters[p.characters.length - 1];
        setSelectedId(newest.id);
      }
    } finally {
      setSaving(false);
    }
  };

  const removeClass = async id => {
    const p = await apiFetch(`/api/projects/${projectSlug}/character-classes/${id}/`, { method: "DELETE" });
    setClasses(p.classes);
  };

  const removeCharacter = async id => {
    if (!window.confirm("Supprimer ce personnage ?")) return;
    const p = await apiFetch(`/api/projects/${projectSlug}/characters/${id}/`, { method: "DELETE" });
    setCharacters(p.characters);
    if (selectedId === id) {
      setSelectedId(null);
    }
  };

  const newCharacter = () => {
    setSelectedId(null);
    setCharacterForm(emptyCharacterForm());
  };

  if (loading) return <LoadingScreen />;
  if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />;

  return (
    <AppLayout currentProjectSlug={project.slug}>
      <PageLayout title="Personnages" subtitle="Fiches type carnet (inspiré WriteControl)">
        <div className="characters-studio-layout">
          <section className="surface characters-class-panel">
            <div className="surface-header"><h2>Classes</h2></div>
            <form className="stack-form" onSubmit={saveClass}>
              <Field label="Nom"><input className="input" value={classForm.name} onChange={e => setClassForm(c => ({ ...c, name: e.target.value }))} /></Field>
              <Field label="Description"><textarea className="input textarea" rows="2" value={classForm.description} onChange={e => setClassForm(c => ({ ...c, description: e.target.value }))} /></Field>
              <Btn variant="primary" type="submit">{classForm.id ? "Modifier la classe" : "Ajouter une classe"}</Btn>
            </form>
            <div className="list-surface">
              {classes.map(i => (
                <div key={i.id} className="list-row">
                  <div className="list-row-topline">
                    <strong>{i.name}</strong>
                    <div className="mini-actions">
                      <button type="button" onClick={() => setClassForm({ id: i.id, name: i.name, description: i.description })}>✎</button>
                      <button type="button" onClick={() => removeClass(i.id)}>×</button>
                    </div>
                  </div>
                  <p>{i.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="surface characters-list-panel">
            <div className="surface-header">
              <h2>Distribution</h2>
              <button type="button" className="btn-secondary" onClick={newCharacter}>Nouveau personnage</button>
            </div>
            <div className="character-card-grid">
              {characters.map(ch => (
                <button
                  key={ch.id}
                  type="button"
                  className={cx("character-pick-card", selectedId === ch.id && "is-active")}
                  onClick={() => setSelectedId(ch.id)}
                >
                  <div className="character-pick-avatar">
                    {ch.avatarUrl ? <img src={ch.avatarUrl} alt="" /> : (ch.name || "?")[0].toUpperCase()}
                  </div>
                  <div className="character-pick-meta">
                    <strong>{ch.name}</strong>
                    <span>{ch.role || "—"}</span>
                    <div className="character-stars" aria-hidden>{Array.from({ length: ch.starRating || 3 }).map((_, i) => <span key={i}>★</span>)}</div>
                  </div>
                </button>
              ))}
              {!characters.length && <p className="inline-note">Aucun personnage — créez-en un.</p>}
            </div>
          </section>

          <section className="surface characters-detail-panel">
            <form className="stack-form stack-form--wide" onSubmit={saveCharacter}>
              <div className="character-detail-header">
                <div className="character-detail-hero">
                  <div className="character-pick-avatar character-pick-avatar--large">
                    {selected?.avatarUrl ? <img src={selected.avatarUrl} alt="" /> : (characterForm.name || "?")[0].toUpperCase()}
                  </div>
                  <div>
                    <Field label="Nom affiché"><input className="input" value={characterForm.name} onChange={e => setCharacterForm(c => ({ ...c, name: e.target.value }))} required /></Field>
                    <Field label="Rôle / fonction"><input className="input" value={characterForm.role} onChange={e => setCharacterForm(c => ({ ...c, role: e.target.value }))} placeholder="Protagoniste, narrateur…" /></Field>
                    <Field label="Importance (1–5)"><input className="input" type="number" min={1} max={5} value={characterForm.starRating} onChange={e => setCharacterForm(c => ({ ...c, starRating: Number(e.target.value) }))} /></Field>
                  </div>
                </div>
                {characterForm.id && (
                  <button type="button" className="btn-ghost" onClick={() => removeCharacter(characterForm.id)}>Supprimer</button>
                )}
              </div>

              <Accordion title="État civil" defaultOpen>
                <div className="form-grid">
                  <Field label="Prénom"><input className="input" value={characterForm.firstName} onChange={e => setCharacterForm(c => ({ ...c, firstName: e.target.value }))} /></Field>
                  <Field label="Nom"><input className="input" value={characterForm.lastName} onChange={e => setCharacterForm(c => ({ ...c, lastName: e.target.value }))} /></Field>
                </div>
                <div className="form-grid">
                  <Field label="Surnom"><input className="input" value={characterForm.nickname} onChange={e => setCharacterForm(c => ({ ...c, nickname: e.target.value }))} /></Field>
                  <Field label="Pronoms"><input className="input" value={characterForm.pronouns} onChange={e => setCharacterForm(c => ({ ...c, pronouns: e.target.value }))} /></Field>
                </div>
                <Field label="Sexe / genre"><input className="input" value={characterForm.sexOrGender} onChange={e => setCharacterForm(c => ({ ...c, sexOrGender: e.target.value }))} /></Field>
                <div className="form-grid">
                  <Field label="Espèce / ethnie"><input className="input" value={characterForm.species} onChange={e => setCharacterForm(c => ({ ...c, species: e.target.value }))} /></Field>
                  <Field label="Âge"><input className="input" type="number" min={0} max={200} value={characterForm.age} onChange={e => setCharacterForm(c => ({ ...c, age: e.target.value }))} /></Field>
                </div>
                <div className="form-grid">
                  <Field label="Date de naissance"><input className="input" type="date" value={characterForm.birthDate} onChange={e => setCharacterForm(c => ({ ...c, birthDate: e.target.value }))} /></Field>
                  <Field label="Lieu de naissance"><input className="input" value={characterForm.birthPlace} onChange={e => setCharacterForm(c => ({ ...c, birthPlace: e.target.value }))} /></Field>
                </div>
                <div className="form-grid">
                  <Field label="Résidence"><input className="input" value={characterForm.residence} onChange={e => setCharacterForm(c => ({ ...c, residence: e.target.value }))} /></Field>
                  <Field label="Occupation"><input className="input" value={characterForm.occupation} onChange={e => setCharacterForm(c => ({ ...c, occupation: e.target.value }))} /></Field>
                </div>
              </Accordion>

              <Accordion title="Physique">
                <Field label="Apparence"><textarea className="input textarea" rows={3} value={characterForm.appearance} onChange={e => setCharacterForm(c => ({ ...c, appearance: e.target.value }))} /></Field>
              </Accordion>

              <Accordion title="Caractère">
                <Field label="Personnalité"><textarea className="input textarea" rows={3} value={characterForm.personality} onChange={e => setCharacterForm(c => ({ ...c, personality: e.target.value }))} /></Field>
              </Accordion>

              <Accordion title="Profil">
                <Field label="Résumé"><textarea className="input textarea" rows={3} value={characterForm.summary} onChange={e => setCharacterForm(c => ({ ...c, summary: e.target.value }))} /></Field>
                <Field label="Historique / passé"><textarea className="input textarea" rows={3} value={characterForm.backstory} onChange={e => setCharacterForm(c => ({ ...c, backstory: e.target.value }))} /></Field>
              </Accordion>

              <Accordion title="Évolution">
                <Field label="Arc / évolution"><textarea className="input textarea" rows={3} value={characterForm.evolution} onChange={e => setCharacterForm(c => ({ ...c, evolution: e.target.value }))} /></Field>
                <div className="form-grid">
                  <Field label="Objectifs"><textarea className="input textarea" rows={2} value={characterForm.goals} onChange={e => setCharacterForm(c => ({ ...c, goals: e.target.value }))} /></Field>
                  <Field label="Conflits"><textarea className="input textarea" rows={2} value={characterForm.conflicts} onChange={e => setCharacterForm(c => ({ ...c, conflicts: e.target.value }))} /></Field>
                </div>
              </Accordion>

              <Accordion title="Inventaire & possessions">
                <Field label="Inventaire"><textarea className="input textarea" rows={2} value={characterForm.inventory} onChange={e => setCharacterForm(c => ({ ...c, inventory: e.target.value }))} /></Field>
                <Field label="Possessions"><textarea className="input textarea" rows={2} value={characterForm.possessions} onChange={e => setCharacterForm(c => ({ ...c, possessions: e.target.value }))} /></Field>
              </Accordion>

              <Accordion title="Autres">
                <Field label="Divers"><textarea className="input textarea" rows={2} value={characterForm.extras} onChange={e => setCharacterForm(c => ({ ...c, extras: e.target.value }))} /></Field>
                <Field label="Notes privées"><textarea className="input textarea" rows={3} value={characterForm.notes} onChange={e => setCharacterForm(c => ({ ...c, notes: e.target.value }))} /></Field>
                {classes.length > 0 && (
                  <Field label="Classes">
                    <div className="checkbox-grid">
                      {classes.map(i => (
                        <label key={i.id} className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={characterForm.classIds.includes(i.id)}
                            onChange={e => setCharacterForm(c => ({
                              ...c,
                              classIds: e.target.checked ? [...c.classIds, i.id] : c.classIds.filter(x => x !== i.id),
                            }))}
                          />
                          <span>{i.name}</span>
                        </label>
                      ))}
                    </div>
                  </Field>
                )}
              </Accordion>

              <div className="button-row">
                <Btn variant="primary" type="submit" disabled={saving}>{saving ? "Enregistrement…" : characterForm.id ? "Mettre à jour" : "Créer le personnage"}</Btn>
              </div>
            </form>
          </section>
        </div>
      </PageLayout>
    </AppLayout>
  );
}



function PlacesPage() { const { projectSlug } = useParams(); const { project, items: places, loading, error, load, save, remove } = useCrudPage(projectSlug, "places", "places"); const [form, setForm] = useState({ id: null, name: "", description: "", significance: "", history: "", geography: "", culture: "", notes: "" }); const resetForm = () => setForm({ id: null, name: "", description: "", significance: "", history: "", geography: "", culture: "", notes: "" }); const submit = async (e) => { e.preventDefault(); await save(form); resetForm(); }; if (loading) return <LoadingScreen />; if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />; return (<AppLayout currentProjectSlug={project.slug}><PageLayout title="Lieux" subtitle="Univers"><div className="content-grid content-grid--wide"><section className="surface"><form className="stack-form" onSubmit={submit}><Field label="Nom"><input className="input" value={form.name} onChange={e => setForm(c => ({ ...c, name: e.target.value }))} /></Field><Field label="Description"><textarea className="input textarea" rows="3" value={form.description} onChange={e => setForm(c => ({ ...c, description: e.target.value }))} /></Field><Field label="Importance"><textarea className="input textarea" rows="2" value={form.significance} onChange={e => setForm(c => ({ ...c, significance: e.target.value }))} /></Field><div className="form-grid"><Field label="Histoire"><textarea className="input textarea" rows="2" value={form.history} onChange={e => setForm(c => ({ ...c, history: e.target.value }))} /></Field><Field label="Géographie"><textarea className="input textarea" rows="2" value={form.geography} onChange={e => setForm(c => ({ ...c, geography: e.target.value }))} /></Field></div><Btn variant="primary" type="submit">{form.id ? "Modifier" : "Ajouter"}</Btn></form></section><section className="surface"><div className="surface-header"><div><h2>{places.length} lieux</h2></div></div><div className="list-surface">{places.map(p => <div key={p.id} className="list-row"><div className="list-row-topline"><strong>{p.name}</strong><div className="mini-actions"><button type="button" onClick={() => setForm({ id: p.id, name: p.name, description: p.description, significance: p.significance, history: p.history, geography: p.geography, culture: p.culture, notes: p.notes })}>✎</button><button type="button" onClick={() => remove(p.id)}>×</button></div></div><p>{p.description}</p></div>)}</div></section></div></PageLayout></AppLayout>); }

/* ─── Structure (Table View) ─── */
function StructurePage() {
  const { projectSlug } = useParams(); const navigate = useNavigate();
  const [data, setData] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const p = await apiFetch(`/api/projects/${projectSlug}/structure/`); setData(p); setLoading(false); } catch (e) { setError(extractErrorMessage(e)); setLoading(false); } }, [projectSlug]);
  useEffect(() => { load(); }, [load]);
  const createChapter = async () => { const p = await apiFetch(`/api/projects/${projectSlug}/chapters/`, { method: "POST", body: {} }); navigate(`/projects/${projectSlug}/workspace/${p.chapter.id}`); };
  if (loading) return <LoadingScreen />;
  if (error || !data) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />;
  const tw = data.project.stats.totalWordCount;
  const chapterStatus = (ch) => { if (ch.wordCount === 0) return "draft"; if (ch.summary) return "done"; if (ch.wordCount > 500) return "revised"; return "draft"; };
  const statusLabels = { done: "DONE", revised: "REVISED", draft: "DRAFT" };
  const counts = { done: data.chapters.filter(c => chapterStatus(c) === "done").length, revised: data.chapters.filter(c => chapterStatus(c) === "revised").length, draft: data.chapters.filter(c => chapterStatus(c) === "draft").length };

  return (
    <AppLayout currentProjectSlug={data.project.slug}>
      <PageLayout title="Structure" subtitle={t("structure.subtitle")}>
        <div className="structure-header">
          <div className="structure-stats">
            <div className="structure-stat"><span className="structure-stat-value">{data.chapters.length}</span><span className="structure-stat-label">Chapitres</span></div>
            <div className="structure-stat"><span className="structure-stat-value">{tw.toLocaleString("fr-FR")}</span><span className="structure-stat-label">Mots</span></div>
            <div className="structure-stat"><span className="structure-stat-value">~{pages(tw)}</span><span className="structure-stat-label">Pages</span></div>
          </div>
          <Btn variant="primary" onClick={createChapter}>+ Ajouter chapitre</Btn>
        </div>
        <div className="structure-table-wrap">
          <table className="structure-table">
            <thead><tr><th>#</th><th>Titre du chapitre</th><th>Mots</th><th>Pages</th><th>Statut</th><th>Dernière sauvegarde</th><th></th></tr></thead>
            <tbody>
              {data.chapters.map(ch => {
                const st = chapterStatus(ch);
                return (
                  <tr key={ch.id} onClick={() => navigate(`/projects/${projectSlug}/workspace/${ch.id}`)}>
                    <td className="ch-num">{String(ch.position).padStart(2, "0")}</td>
                    <td className="ch-title"><strong>{ch.title}</strong>{ch.summary && <small>{ch.summary.length > 60 ? ch.summary.slice(0, 60) + "..." : ch.summary}</small>}</td>
                    <td className="ch-words">{ch.wordCount.toLocaleString("fr-FR")}</td>
                    <td className="ch-pages">~{pages(ch.wordCount)}</td>
                    <td><span className={`status-pill status-pill--${st}`}>{statusLabels[st]}</span></td>
                    <td className="ch-date">{ch.lastAutosavedAt ? formatWhen(ch.lastAutosavedAt) : "—"}</td>
                    <td className="ch-actions"><button type="button" onClick={e => e.stopPropagation()}>⋮</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="structure-footer">
            <div className="structure-footer-stats">
              <span><span className="dot" style={{ background: "var(--success)" }} /> {counts.done} Terminé</span>
              <span><span className="dot" style={{ background: "var(--warning)" }} /> {counts.revised} En révision</span>
              <span><span className="dot" style={{ background: "var(--muted)" }} /> {counts.draft} Brouillon</span>
            </div>
            <span>Dernière sauvegarde auto : {formatWhen(data.chapters[0]?.lastAutosavedAt)}</span>
          </div>
        </div>
      </PageLayout>
    </AppLayout>
  );
}

/* ─── Mind Map (Connections) ─── */
const MINDMAP_SOURCE_META = {
  characters: { label: "Import personnages" },
  places: { label: "Import lieux" },
  chapters: { label: "Import chapitres" },
};

const MINDMAP_KIND_META = {
  character: { label: "Personnage", tone: "characters", shortLabel: "Perso", color: "#6ba8d4" },
  place: { label: "Lieu", tone: "places", shortLabel: "Lieu", color: "#6bc490" },
  chapter: { label: "Chapitre", tone: "chapters", shortLabel: "Chap.", color: "#c49a6c" },
  scene: { label: "Scène", tone: "scene", shortLabel: "Scène", color: "#f59e0b" },
  theme: { label: "Thème", tone: "theme", shortLabel: "Thème", color: "#a78bfa" },
  idea: { label: "Idée", tone: "idea", shortLabel: "Idée", color: "#f472b6" },
  research: { label: "Recherche", tone: "research", shortLabel: "Recherche", color: "#22c55e" },
  custom: { label: "Libre", tone: "custom", shortLabel: "Libre", color: "#94a3b8" },
};

const MINDMAP_KIND_OPTIONS = Object.entries(MINDMAP_KIND_META).map(([value, meta]) => ({ value, ...meta }));
const NODE_KIND_FROM_SOURCE = {
  characters: "character",
  places: "place",
  chapters: "chapter",
};
const MINDMAP_LAYOUT_ORDER = ["character", "place", "chapter", "scene", "theme", "idea", "research", "custom"];
function getMindmapMeta(kind) {
  return MINDMAP_KIND_META[kind] || MINDMAP_KIND_META.custom;
}

function buildMindmapNode(node) {
  return {
    id: `node-${node.id}`,
    type: "mindmap",
    position: { x: node.positionX || 0, y: node.positionY || 0 },
    data: { ...node, label: node.name },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  };
}

function buildMindmapEdge(connection, showLabels = true) {
  return {
    id: `edge-${connection.id}`,
    source: `node-${connection.fromNodeId}`,
    target: `node-${connection.toNodeId}`,
    label: showLabels ? (connection.label || "") : "",
    data: connection,
    type: "smoothstep",
    animated: false,
  };
}

function dedupeMindmapNodes(list) {
  const nodesById = new Map();
  list.forEach(node => nodesById.set(node.id, node));
  return Array.from(nodesById.values());
}

function nodeMatchesSearch(node, query) {
  if (!query) return true;
  const meta = getMindmapMeta(node.data.kind);
  const haystack = `${node.data.name || ""} ${node.data.description || ""} ${meta.label}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function parseNodeId(value) {
  if (value === "" || value === null || value === undefined) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : "";
}

function getCoverLayer(cover, predicate) {
  return cover?.composition?.layers?.find(predicate) || null;
}

function clamp(value, min, max, fallback = min) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function cacheBustMediaUrl(url) {
  if (!url) return url;
  return url.includes("?") ? `${url}&_=${Date.now()}` : `${url}?_=${Date.now()}`;
}

function getBackgroundCropDraft(draftCover, backgroundLayer) {
  return {
    cropX: clamp(draftCover?.backgroundCropX ?? backgroundLayer?.cropX ?? 0, 0, 99, 0),
    cropY: clamp(draftCover?.backgroundCropY ?? backgroundLayer?.cropY ?? 0, 0, 99, 0),
    cropWidth: clamp(draftCover?.backgroundCropWidth ?? backgroundLayer?.cropWidth ?? 100, 1, 100, 100),
    cropHeight: clamp(draftCover?.backgroundCropHeight ?? backgroundLayer?.cropHeight ?? 100, 1, 100, 100),
    rotation: clamp(draftCover?.backgroundRotation ?? backgroundLayer?.rotation ?? 0, -180, 180, 0),
    flipX: Number(draftCover?.backgroundFlipX ?? backgroundLayer?.flipX ?? 1) === -1 ? -1 : 1,
    flipY: Number(draftCover?.backgroundFlipY ?? backgroundLayer?.flipY ?? 1) === -1 ? -1 : 1,
  };
}

function buildGeneratedCoverPayload(draftCover, template) {
  const backgroundLayer = getCoverLayer(draftCover, layer => layer.type === "background");
  const ornamentLayer = getCoverLayer(draftCover, layer => layer.type === "ornament");
  const backgroundImage = backgroundLayer?.imageUrl || draftCover?.coverImageUrl || "";
  const layout = template.layout;
  const subtitleText = draftCover?.subtitleText ?? "";
  const titleText = draftCover?.titleText ?? draftCover?.projectTitle ?? "Titre du livre";
  const authorText = draftCover?.authorText ?? "Auteur";
  const accentGlyph = draftCover?.accentGlyph || ornamentLayer?.glyph || template?.accentGlyph || "✦";
  const backgroundCrop = getBackgroundCropDraft(draftCover, backgroundLayer);
  const showOrnament = draftCover?.showOrnament ?? ornamentLayer?.visible ?? true;
  const composition = {
    version: 2,
    layers: [
      {
        id: "bg",
        type: "background",
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        color: template?.bgColor || "#18181b",
        imageUrl: backgroundImage,
        fit: "cover",
        cropX: backgroundCrop.cropX,
        cropY: backgroundCrop.cropY,
        cropWidth: backgroundCrop.cropWidth,
        cropHeight: backgroundCrop.cropHeight,
        rotation: backgroundCrop.rotation,
        flipX: backgroundCrop.flipX,
        flipY: backgroundCrop.flipY,
        overlayColor: template?.overlayColor || "#09090b",
        overlayOpacity: template?.overlayOpacity ?? 0.22,
        opacity: 1,
        locked: true,
        visible: true,
        zIndex: 0,
      },
      {
        id: "subtitle",
        type: "text",
        role: "subtitle",
        text: subtitleText,
        ...layout.subtitle,
        fontFamily: template?.subtitleFont || "Libre Baskerville, Georgia, serif",
        fontSize: template?.subtitleSize ?? 26,
        color: template?.subtitleColor || "#c49a6c",
        align: layout.align,
        fontWeight: template?.subtitleWeight || "500",
        opacity: 1,
        visible: !!subtitleText,
        zIndex: 10,
      },
      {
        id: "title",
        type: "text",
        role: "title",
        text: titleText,
        ...layout.title,
        fontFamily: template?.titleFont || "Cormorant Garamond, Georgia, serif",
        fontSize: template?.titleSize ?? 88,
        color: template?.titleColor || "#f7f1e8",
        align: layout.align,
        fontWeight: template?.titleWeight || "700",
        opacity: 1,
        visible: true,
        zIndex: 20,
      },
      {
        id: `orn-${template?.id || "guided"}`,
        type: "ornament",
        glyph: accentGlyph,
        ...layout.ornament,
        color: template?.subtitleColor || "#c49a6c",
        fontSize: template?.ornamentSize ?? 52,
        opacity: 0.9,
        visible: !!showOrnament,
        zIndex: 15,
      },
      {
        id: "author",
        type: "text",
        role: "author",
        text: authorText,
        ...layout.author,
        fontFamily: template?.authorFont || "Libre Baskerville, Georgia, serif",
        fontSize: template?.authorSize ?? 28,
        color: template?.authorColor || "#f7f1e8",
        align: layout.align,
        fontWeight: template?.authorWeight || "600",
        opacity: 1,
        visible: !!authorText,
        zIndex: 30,
      },
    ],
  };
  return {
    ...draftCover,
    editorMode: "generated",
    templateId: template?.id || "editorial-night",
    displayMode: "artwork",
    composition,
    bgColor: template?.bgColor || "#18181b",
    titleText,
    titleFont: template?.titleFont || "Cormorant Garamond, Georgia, serif",
    titleSize: template?.titleSize ?? 88,
    titleColor: template?.titleColor || "#f7f1e8",
    subtitleText,
    subtitleFont: template?.subtitleFont || "Libre Baskerville, Georgia, serif",
    subtitleSize: template?.subtitleSize ?? 26,
    subtitleColor: template?.subtitleColor || "#c49a6c",
    authorText,
    authorFont: template?.authorFont || "Libre Baskerville, Georgia, serif",
    authorSize: template?.authorSize ?? 28,
    authorColor: template?.authorColor || "#f7f1e8",
  };
}

function MindMapNode({ data, selected }) {
  const meta = getMindmapMeta(data.kind);
  return (
    <div className={cx("mindmap-node-card", `mindmap-node-card--${meta.tone}`, selected && "is-selected")} style={{ "--node-accent": data.color || meta.color }}>
      <Handle type="target" position={Position.Left} className="mindmap-node-handle" />
      <div className="mindmap-node-card-header">
        <span className={cx("mindmap-node-pill", `mindmap-node-pill--${meta.tone}`)}>{meta.label}</span>
      </div>
      <strong>{data.name}</strong>
      <p>{data.description || "Ajoutez une note rapide pour enrichir ce nœud."}</p>
      <Handle type="source" position={Position.Right} className="mindmap-node-handle" />
    </div>
  );
}

function MindmapDropdown({ label, primary, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="mindmap-dropdown" ref={ref}>
      <button type="button" className={primary ? "btn-primary mm-add-btn" : "mindmap-action-btn"} onClick={() => setOpen(v => !v)}>{label}</button>
      {open && <div className="mindmap-dropdown-menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

function ConnectionsPage() {
  const { projectSlug } = useParams();
  const [project, setProject] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [nodeDraft, setNodeDraft] = useState(null);
  const [edgeDraft, setEdgeDraft] = useState(null);
  const [quickLinkDraft, setQuickLinkDraft] = useState({ fromNodeId: "", toNodeId: "", label: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [showLabels, setShowLabels] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [importFeedback, setImportFeedback] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const nodeTypes = useMemo(() => ({ mindmap: MindMapNode }), []);
  const defaultEdgeOptions = useMemo(() => ({
    type: "smoothstep",
    animated: false,
    style: { stroke: "rgba(196, 154, 108, 0.55)", strokeWidth: 2.2 },
    labelStyle: { fill: "#b0aaa2", fontSize: 11, fontWeight: 600 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(196, 154, 108, 0.7)" },
  }), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pp, mp] = await Promise.all([
        apiFetch(`/api/projects/${projectSlug}/`),
        apiFetch(`/api/projects/${projectSlug}/map/`),
      ]);
      setProject(pp.project);
      setNodes((mp.nodes || []).map(buildMindmapNode));
      setEdges((mp.connections || []).map(conn => buildMindmapEdge(conn, true)).filter(edge => edge.source !== "node-null" && edge.target !== "node-null"));
      setLoading(false);
    } catch (e) { setError(extractErrorMessage(e)); setLoading(false); }
  }, [projectSlug, setEdges, setNodes]);

  useEffect(() => { load(); }, [load]);
  const selectedNode = nodes.find(node => node.id === selectedNodeId);
  const selectedEdge = edges.find(edge => edge.id === selectedEdgeId);

  const visibleNodes = useMemo(
    () => nodes.filter(node => (sourceFilter === "all" || (node.data.kind || "custom") === sourceFilter) && nodeMatchesSearch(node, deferredSearchQuery)),
    [deferredSearchQuery, nodes, sourceFilter],
  );

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges
      .map(edge => ({ ...edge, label: showLabels ? (edge.data?.label || edge.label || "") : "" }))
      .filter(edge => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [edges, showLabels, visibleNodeIds],
  );

  useEffect(() => {
    if (selectedNode) {
      const selectedMeta = getMindmapMeta(selectedNode.data.kind);
      setNodeDraft({
        id: selectedNode.data.id,
        name: selectedNode.data.name,
        description: selectedNode.data.description || "",
        kind: selectedNode.data.kind || "custom",
        color: selectedNode.data.color || selectedMeta.color,
      });
      setQuickLinkDraft({ fromNodeId: selectedNode.data.id, toNodeId: "", label: "", notes: "" });
    }
  }, [selectedNode]);

  useEffect(() => {
    if (selectedEdge) {
      setEdgeDraft({
        id: selectedEdge.data.id,
        fromNodeId: selectedEdge.data.fromNodeId,
        toNodeId: selectedEdge.data.toNodeId,
        label: selectedEdge.data.label || "",
        notes: selectedEdge.data.notes || "",
      });
    }
  }, [selectedEdge]);

  const syncNode = (node) => {
    setNodes(current => current.map(item => item.id === `node-${node.id}` ? buildMindmapNode(node) : item));
  };

  const syncEdge = (connection) => {
    setEdges(current => current.map(item => item.id === `edge-${connection.id}` ? buildMindmapEdge(connection, true) : item));
  };

  const addNode = async (kind = "idea") => {
    try {
      const meta = getMindmapMeta(kind);
      const r = await apiFetch(`/api/projects/${projectSlug}/map/nodes/`, {
        method: "POST",
        body: {
          name: kind === "scene" ? "Nouvelle scène" : kind === "theme" ? "Nouveau thème" : kind === "idea" ? "Nouvelle idée" : "Nouveau nœud",
          description: "",
          kind,
          color: meta.color,
          positionX: 180 + nodes.length * 12,
          positionY: 140 + nodes.length * 10,
        },
      });
      setNodes(current => [...current, buildMindmapNode(r.node)]);
      setSelectedNodeId(`node-${r.node.id}`);
      setSelectedEdgeId(null);
    } catch (e) { setError(extractErrorMessage(e)); }
  };

  const importNodes = async (sourceType) => {
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/map/import/`, { method: "POST", body: { sourceType } });
      const created = (r.nodes || []).map(buildMindmapNode);
      setNodes(current => dedupeMindmapNodes([...current, ...created]));
      const importedKind = NODE_KIND_FROM_SOURCE[sourceType] || "custom";
      setImportFeedback(created.length ? `${created.length} ${MINDMAP_SOURCE_META[sourceType].label.toLowerCase()} réussis.` : `Aucun élément supplémentaire à importer.`);
      setSourceFilter(importedKind);
    } catch (e) { setError(extractErrorMessage(e)); }
  };

  const saveNode = async () => {
    if (!nodeDraft) return;
    setSaving(true);
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/map/nodes/${nodeDraft.id}/`, {
        method: "PATCH",
        body: { name: nodeDraft.name, description: nodeDraft.description, kind: nodeDraft.kind, color: nodeDraft.color },
      });
      syncNode(r.node);
      setNodeDraft({
        id: r.node.id,
        name: r.node.name,
        description: r.node.description || "",
        kind: r.node.kind || "custom",
        color: r.node.color || getMindmapMeta(r.node.kind).color,
      });
    } catch (e) { setError(extractErrorMessage(e)); }
    setSaving(false);
  };

  const duplicateNode = async () => {
    if (!nodeDraft) return;
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/map/nodes/`, {
        method: "POST",
        body: {
          name: `${nodeDraft.name} copie`,
          description: nodeDraft.description,
          kind: nodeDraft.kind,
          color: nodeDraft.color,
          positionX: (selectedNode?.position?.x || 160) + 60,
          positionY: (selectedNode?.position?.y || 120) + 40,
        },
      });
      setNodes(current => [...current, buildMindmapNode(r.node)]);
      setSelectedNodeId(`node-${r.node.id}`);
    } catch (e) { setError(extractErrorMessage(e)); }
  };

  const saveEdge = async () => {
    if (!edgeDraft) return;
    setSaving(true);
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/connections/${edgeDraft.id}/`, {
        method: "PATCH",
        body: {
          fromNodeId: edgeDraft.fromNodeId,
          toNodeId: edgeDraft.toNodeId,
          label: edgeDraft.label,
          notes: edgeDraft.notes,
        },
      });
      syncEdge(r.connection);
      setEdgeDraft({
        id: r.connection.id,
        fromNodeId: r.connection.fromNodeId,
        toNodeId: r.connection.toNodeId,
        label: r.connection.label || "",
        notes: r.connection.notes || "",
      });
    } catch (e) { setError(extractErrorMessage(e)); }
    setSaving(false);
  };

  const deleteNode = async (nodeId) => {
    try {
      const nodePk = nodeId.replace("node-", "");
      const r = await apiFetch(`/api/projects/${projectSlug}/map/nodes/${nodePk}/`, { method: "DELETE" });
      setNodes(current => current.filter(item => item.id !== nodeId));
      setEdges((r.connections || []).map(conn => buildMindmapEdge(conn, true)).filter(edge => edge.source !== "node-null" && edge.target !== "node-null"));
      setSelectedNodeId(null);
    } catch (e) { setError(extractErrorMessage(e)); }
  };

  const deleteEdge = async (edgeId) => {
    try {
      const edgePk = edgeId.replace("edge-", "");
      const r = await apiFetch(`/api/projects/${projectSlug}/connections/${edgePk}/`, { method: "DELETE" });
      setEdges((r.connections || []).map(conn => buildMindmapEdge(conn, true)).filter(edge => edge.source !== "node-null" && edge.target !== "node-null"));
      setSelectedEdgeId(null);
    } catch (e) { setError(extractErrorMessage(e)); }
  };

  const onConnect = useCallback(async (params) => {
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/connections/`, {
        method: "POST",
        body: {
          fromNodeId: Number((params.source || "").replace("node-", "")),
          toNodeId: Number((params.target || "").replace("node-", "")),
          label: "",
          notes: "",
        },
      });
      setEdges(current => addEdge(buildMindmapEdge(r.connection, true), current));
      setSelectedEdgeId(`edge-${r.connection.id}`);
      setSelectedNodeId(null);
    } catch (e) { setError(extractErrorMessage(e)); }
  }, [projectSlug, setEdges]);

  const createQuickLink = async () => {
    if (!quickLinkDraft.fromNodeId || !quickLinkDraft.toNodeId) return;
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/connections/`, {
        method: "POST",
        body: quickLinkDraft,
      });
      setEdges(current => addEdge(buildMindmapEdge(r.connection, true), current));
      setSelectedEdgeId(`edge-${r.connection.id}`);
      setSelectedNodeId(null);
      setQuickLinkDraft(current => ({ ...current, toNodeId: "", label: "", notes: "" }));
    } catch (e) { setError(extractErrorMessage(e)); }
  };

  const onNodeDragStop = useCallback(async (_evt, node) => {
    try {
      const r = await apiFetch(`/api/projects/${projectSlug}/map/nodes/${node.data.id}/`, {
        method: "PATCH",
        body: { positionX: Math.round(node.position.x), positionY: Math.round(node.position.y) },
      });
      syncNode(r.node);
    } catch (e) { setError(extractErrorMessage(e)); }
  }, [projectSlug, setNodes]);

  const autoArrange = useCallback(async () => {
    const grouped = new Map(MINDMAP_LAYOUT_ORDER.map(key => [key, []]));
    nodes.forEach(node => {
      const key = grouped.has(node.data.kind) ? node.data.kind : "custom";
      grouped.get(key).push(node);
    });
    const positionedNodes = [];
    let column = 0;
    MINDMAP_LAYOUT_ORDER.forEach(type => {
      const bucket = grouped.get(type) || [];
      bucket.forEach((node, index) => {
        positionedNodes.push({
          nodeId: node.id,
          dataId: node.data.id,
          position: { x: 120 + column * 270, y: 120 + index * 150 },
        });
      });
      if (bucket.length) column += 1;
    });
    if (!positionedNodes.length) return;
    const persistableNodes = positionedNodes.filter(item => Number.isFinite(item.dataId) && item.dataId > 0);
    setNodes(current => current.map(node => {
      const next = positionedNodes.find(item => item.nodeId === node.id);
      return next ? { ...node, position: next.position } : node;
    }));
    if (!persistableNodes.length) {
      setImportFeedback("Organisation appliquée localement.");
      return;
    }
    const results = await Promise.allSettled(
      persistableNodes.map(item => apiFetch(`/api/projects/${projectSlug}/map/nodes/${item.dataId}/`, {
        method: "PATCH",
        body: { positionX: item.position.x, positionY: item.position.y },
      })),
    );
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) {
      setImportFeedback(`Organisation appliquée, mais ${failed.length} position${failed.length > 1 ? "s" : ""} n’ont pas pu être enregistrées. ${extractErrorMessage(failed[0].reason)}`);
      return;
    }
    setImportFeedback("Carte organisée.");
  }, [nodes, projectSlug, setNodes]);

  if (loading) return <LoadingScreen />;
  if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />;

  return (
    <AppLayout currentProjectSlug={project.slug}>
      <div className="mindmap-fullpage mindmap-fullpage--flow">
        <div className="mindmap-topbar">
          <div className="mindmap-topbar-title">
            <span className="section-label">Carte Mentale</span>
            <span className="mindmap-topbar-project">{project.title}</span>
          </div>
          <div className="mindmap-topbar-right">
            {importFeedback && <span className="mindmap-status-chip">{importFeedback}</span>}
            <div className="mindmap-topbar-actions">
              <MindmapDropdown label="+ Ajouter" primary>
                {MINDMAP_KIND_OPTIONS.map(opt => (
                  <button key={opt.value} type="button" className="mindmap-dropdown-item" onClick={() => addNode(opt.value)}>
                    <span className="mindmap-dropdown-dot" style={{ background: opt.color }} />
                    {opt.label}
                  </button>
                ))}
              </MindmapDropdown>
              <MindmapDropdown label="Importer">
                <button type="button" className="mindmap-dropdown-item" onClick={() => importNodes("characters")}>Personnages</button>
                <button type="button" className="mindmap-dropdown-item" onClick={() => importNodes("places")}>Lieux</button>
                <button type="button" className="mindmap-dropdown-item" onClick={() => importNodes("chapters")}>Chapitres</button>
              </MindmapDropdown>
              <button type="button" className="mindmap-action-btn mindmap-action-btn--ghost" onClick={autoArrange}>Organiser</button>
            </div>
          </div>
        </div>

        <div className="mindmap-canvas-area">
          <div className="mindmap-flow-wrap">
            <ReactFlow
              nodes={visibleNodes}
              edges={visibleEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeDragStop={onNodeDragStop}
              onNodeClick={(_evt, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
              onEdgeClick={(_evt, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
              onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
              connectionMode={ConnectionMode.Loose}
              connectionLineType={ConnectionLineType.SmoothStep}
              defaultEdgeOptions={defaultEdgeOptions}
              snapToGrid={snapToGrid}
              snapGrid={[20, 20]}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              panOnScroll
              panOnDrag={[1, 2]}
              elevateNodesOnSelect
              fitViewOptions={{ padding: 0.18 }}
              nodeTypes={nodeTypes}
              proOptions={{ hideAttribution: true }}
              fitView
            >
              <Panel position="top-left" className="mindmap-panel">
                <div className="mindmap-panel-block">
                  <div className="mindmap-panel-label">Recherche</div>
                  <input className="input mindmap-search-input" placeholder="Filtrer la carte…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                </div>
                <div className="mindmap-panel-block">
                  <div className="mindmap-panel-label">Vue</div>
                  <div className="mindmap-filter-row">
                    <button type="button" className={cx("mindmap-filter-chip", sourceFilter === "all" && "is-active")} onClick={() => setSourceFilter("all")}>Tout</button>
                    {MINDMAP_LAYOUT_ORDER.map(type => (
                      <button key={type} type="button" className={cx("mindmap-filter-chip", sourceFilter === type && "is-active")} onClick={() => setSourceFilter(type)}>
                        {getMindmapMeta(type).shortLabel}
                      </button>
                    ))}
                  </div>
                </div>
              </Panel>
              <Background color="rgba(255,255,255,0.06)" gap={20} variant={BackgroundVariant.Dots} />
            </ReactFlow>
          </div>

          {nodes.length === 0 && (
            <div className="mindmap-empty">
              <div className="mindmap-empty-icon">⬡</div>
              <p>Carte vide. Cliquez <strong>+ Idée</strong> pour commencer.</p>
              <p className="mindmap-empty-hint">{t("mindmap.emptyHint")}</p>
              <button type="button" className="btn-primary" onClick={() => addNode("idea")}>+ Idée</button>
            </div>
          )}

          {selectedNode && nodeDraft && (
            <div className="mindmap-info-panel">
              <div className="mindmap-info-header">
                <span className="mindmap-info-title">Nœud</span>
                <button type="button" className="mm-panel-close" onClick={() => setSelectedNodeId(null)}>×</button>
              </div>
              <Field label="Nom"><input className="input" value={nodeDraft.name} onChange={e => setNodeDraft(current => ({ ...current, name: e.target.value }))} /></Field>
              <div className="form-grid">
                <Field label="Type">
                  <select
                    className="input"
                    value={nodeDraft.kind}
                    onChange={e => setNodeDraft(current => {
                      const nextKind = e.target.value;
                      const previousMeta = getMindmapMeta(current.kind);
                      const shouldAdoptPreset = !current.color || current.color.toLowerCase() === previousMeta.color.toLowerCase();
                      return {
                        ...current,
                        kind: nextKind,
                        color: shouldAdoptPreset ? getMindmapMeta(nextKind).color : current.color,
                      };
                    })}
                  >
                    {MINDMAP_KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </Field>
                <Field label="Couleur">
                  <div className="cover-color-row">
                    <input type="color" className="cover-color-native" value={nodeDraft.color} onChange={e => setNodeDraft(current => ({ ...current, color: e.target.value }))} />
                    <input className="input cover-color-text" value={nodeDraft.color} onChange={e => setNodeDraft(current => ({ ...current, color: e.target.value }))} />
                  </div>
                </Field>
              </div>
              <Field label="Description"><textarea className="input textarea" rows="4" value={nodeDraft.description} onChange={e => setNodeDraft(current => ({ ...current, description: e.target.value }))} /></Field>
              {selectedNode.data.sourceType && <div className="inline-note">Importé depuis {selectedNode.data.sourceType} #{selectedNode.data.sourceId}</div>}
              <div className="mindmap-inline-form">
                <Field label="Créer un lien vers">
                  <select className="input" value={quickLinkDraft.toNodeId} onChange={e => setQuickLinkDraft(current => ({ ...current, toNodeId: parseNodeId(e.target.value) }))}>
                    <option value="">Choisir un nœud…</option>
                    {nodes.filter(node => node.data.id !== nodeDraft.id).map(node => <option key={node.data.id} value={node.data.id}>{node.data.name}</option>)}
                  </select>
                </Field>
                <Field label="Libellé du lien"><input className="input" value={quickLinkDraft.label} onChange={e => setQuickLinkDraft(current => ({ ...current, label: e.target.value }))} /></Field>
                <Field label="Note du lien"><input className="input" value={quickLinkDraft.notes} onChange={e => setQuickLinkDraft(current => ({ ...current, notes: e.target.value }))} placeholder="Conflit, alliance, cause, piste…" /></Field>
                <button type="button" className="mm-btn-secondary" onClick={createQuickLink}>Créer le lien</button>
              </div>
              <div className="mindmap-info-actions">
                <button type="button" className="mm-btn-secondary" onClick={saveNode} disabled={saving}>Sauvegarder</button>
                <button type="button" className="mm-btn-secondary" onClick={duplicateNode}>Dupliquer</button>
                <button type="button" className="mm-delete-btn" onClick={() => deleteNode(selectedNode.id)}>Supprimer</button>
              </div>
            </div>
          )}

          {selectedEdge && edgeDraft && (
            <div className="mindmap-info-panel">
              <div className="mindmap-info-header">
                <span className="mindmap-info-title">Lien</span>
                <button type="button" className="mm-panel-close" onClick={() => setSelectedEdgeId(null)}>×</button>
              </div>
              <Field label="De">
                <select className="input" value={edgeDraft.fromNodeId} onChange={e => setEdgeDraft(current => ({ ...current, fromNodeId: Number(e.target.value) }))}>
                  {nodes.map(node => <option key={node.data.id} value={node.data.id}>{node.data.name}</option>)}
                </select>
              </Field>
              <Field label="Vers">
                <select className="input" value={edgeDraft.toNodeId} onChange={e => setEdgeDraft(current => ({ ...current, toNodeId: Number(e.target.value) }))}>
                  {nodes.map(node => <option key={node.data.id} value={node.data.id}>{node.data.name}</option>)}
                </select>
              </Field>
              <Field label="Libellé"><input className="input" value={edgeDraft.label} onChange={e => setEdgeDraft(current => ({ ...current, label: e.target.value }))} /></Field>
              <Field label="Notes"><textarea className="input textarea" rows="3" value={edgeDraft.notes} onChange={e => setEdgeDraft(current => ({ ...current, notes: e.target.value }))} /></Field>
              <div className="mindmap-info-actions">
                <button type="button" className="mm-btn-secondary" onClick={saveEdge} disabled={saving}>Sauvegarder</button>
                <button type="button" className="mm-delete-btn" onClick={() => deleteEdge(selectedEdge.id)}>Supprimer</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

/* ─── Research / Matter ─── */
function ResearchPage() { const { projectSlug } = useParams(); const { project, items: notes, loading, error, load, save, remove } = useCrudPage(projectSlug, "research", "notes"); const [form, setForm] = useState({ id: null, title: "", content: "", category: "", sourceUrl: "", pinned: false }); const resetForm = () => setForm({ id: null, title: "", content: "", category: "", sourceUrl: "", pinned: false }); const submit = async (e) => { e.preventDefault(); await save(form); resetForm(); }; if (loading) return <LoadingScreen />; if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />; return (<AppLayout currentProjectSlug={project.slug}><PageLayout title="Documentation" subtitle="Recherche"><div className="content-grid content-grid--wide"><section className="surface"><form className="stack-form" onSubmit={submit}><Field label="Titre"><input className="input" value={form.title} onChange={e => setForm(c => ({ ...c, title: e.target.value }))} /></Field><Field label="Contenu"><textarea className="input textarea" rows="6" value={form.content} onChange={e => setForm(c => ({ ...c, content: e.target.value }))} /></Field><div className="form-grid"><Field label="Catégorie"><input className="input" value={form.category} onChange={e => setForm(c => ({ ...c, category: e.target.value }))} /></Field><Field label="URL"><input className="input" value={form.sourceUrl} onChange={e => setForm(c => ({ ...c, sourceUrl: e.target.value }))} /></Field></div><label className="checkbox-row"><input type="checkbox" checked={form.pinned} onChange={e => setForm(c => ({ ...c, pinned: e.target.checked }))} /><span>Épingler</span></label><Btn variant="primary" type="submit">{form.id ? "Modifier" : "Ajouter"}</Btn></form></section><section className="surface"><div className="surface-header"><div><h2>{notes.length} notes</h2></div></div><div className="list-surface">{notes.map(n => <div key={n.id} className="list-row"><div className="list-row-topline"><strong>{n.pinned ? "📌 " : ""}{n.title}</strong><div className="mini-actions"><button type="button" onClick={() => setForm({ id: n.id, title: n.title, content: n.content, category: n.category, sourceUrl: n.sourceUrl, pinned: n.pinned })}>✎</button><button type="button" onClick={() => remove(n.id)}>×</button></div></div><p>{n.content.length > 150 ? n.content.slice(0, 150) + "..." : n.content}</p></div>)}</div></section></div></PageLayout></AppLayout>); }

function MatterPage() { const { projectSlug } = useParams(); const { project, items: sections, loading, error, load, save, remove } = useCrudPage(projectSlug, "front-back-matter", "sections"); const [form, setForm] = useState({ id: null, sectionType: "dedication", title: "", content: "", position: 0 }); const resetForm = () => setForm({ id: null, sectionType: "dedication", title: "", content: "", position: 0 }); const submit = async (e) => { e.preventDefault(); await save(form); resetForm(); }; if (loading) return <LoadingScreen />; if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />; const types = [["dedication","Dédicace"],["preface","Préface"],["foreword","Avant-propos"],["prologue","Prologue"],["epilogue","Épilogue"],["afterword","Postface"],["appendix","Annexe"],["acknowledgments","Remerciements"],["author_note","Note auteur"]]; return (<AppLayout currentProjectSlug={project.slug}><PageLayout title="Liminaire + Annexe" subtitle="Sections"><div className="content-grid content-grid--wide"><section className="surface"><form className="stack-form" onSubmit={submit}><div className="form-grid"><Field label="Type"><select className="input" value={form.sectionType} onChange={e => setForm(c => ({ ...c, sectionType: e.target.value }))}>{types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field><Field label="Titre"><input className="input" value={form.title} onChange={e => setForm(c => ({ ...c, title: e.target.value }))} /></Field></div><Field label="Contenu"><textarea className="input textarea" rows="8" value={form.content} onChange={e => setForm(c => ({ ...c, content: e.target.value }))} /></Field><Btn variant="primary" type="submit">{form.id ? "Modifier" : "Ajouter"}</Btn></form></section><section className="surface"><div className="surface-header"><div><h2>{sections.length} sections</h2></div></div><div className="list-surface">{sections.map(s => <div key={s.id} className="list-row"><div className="list-row-topline"><strong>{s.title}</strong><div className="mini-actions"><button type="button" onClick={() => setForm({ id: s.id, sectionType: s.sectionType, title: s.title, content: s.content, position: s.position })}>✎</button><button type="button" onClick={() => remove(s.id)}>×</button></div></div><p>{s.sectionTypeDisplay}</p></div>)}</div></section></div></PageLayout></AppLayout>); }

/* ─── Export ─── */
function ExportPage() {
  const { projectSlug } = useParams();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [exportError, setExportError] = useState("");
  const iframeRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await apiFetch(`/api/projects/${projectSlug}/`);
      setProject(p.project);
      setLoading(false);
      loadPreview();
    } catch (e) { setError(extractErrorMessage(e)); setLoading(false); }
  }, [projectSlug]);

  useEffect(() => { load(); }, [load]);

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const p = await apiFetch(`/api/projects/${projectSlug}/export/?format=html&preview=1`);
      setPreviewHtml(p.content || "");
    } catch {
      setPreviewHtml("<p style='padding:2em;color:#888;font-family:sans-serif'>Aperçu indisponible</p>");
    }
    setPreviewLoading(false);
  };

  useEffect(() => {
    if (!previewHtml || !iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    doc.open(); doc.write(previewHtml); doc.close();
  }, [previewHtml]);

  const doExport = async (fmt) => {
    setExporting(fmt);
    setExportError("");
    try {
      if (fmt === "html") {
        const p = await apiFetch(`/api/projects/${projectSlug}/export/?format=html`);
        if (p.error) throw new Error(p.error);
        const b = new Blob([p.content], { type: "text/html" });
        const u = URL.createObjectURL(b);
        const a = document.createElement("a"); a.href = u; a.download = `${p.title || projectSlug}.html`; a.click();
        URL.revokeObjectURL(u);
      } else if (fmt === "epub" || fmt === "pdf") {
        const r = await fetch(`/api/projects/${projectSlug}/export/?format=${fmt}`, {
          credentials: "same-origin",
          headers: { "X-CSRFToken": getCsrfToken() },
        });
        if (!r.ok) {
          let msg = `Erreur ${r.status}`;
          try { const j = await r.json(); msg = j.error || msg; } catch {}
          throw new Error(msg);
        }
        const b = await r.blob();
        const u = URL.createObjectURL(b);
        const a = document.createElement("a"); a.href = u; a.download = `${projectSlug}.${fmt}`; a.click();
        URL.revokeObjectURL(u);
      } else {
        const p = await apiFetch(`/api/projects/${projectSlug}/export/?format=text`);
        if (p.error) throw new Error(p.error);
        const b = new Blob([p.content], { type: "text/plain" });
        const u = URL.createObjectURL(b);
        const a = document.createElement("a"); a.href = u; a.download = `${p.title || projectSlug}.txt`; a.click();
        URL.revokeObjectURL(u);
      }
    } catch (e) { setExportError(extractErrorMessage(e)); }
    setExporting("");
  };

  if (loading) return <LoadingScreen />;
  if (error || !project) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />;

  const tw = project.stats.totalWordCount;

  return (
    <AppLayout currentProjectSlug={project.slug}>
      <PageLayout title="Exporter" subtitle={t("book.exportSubtitle")}>
        <div className="export-layout">
          <div className="export-sidebar">
            <section className="surface">
              <div className="surface-header"><div><h2>{project.title}</h2></div></div>
              <div className="metric-stack">
                <div className="metric-pill"><span>Mots</span><strong>{tw.toLocaleString("fr-FR")}</strong></div>
                <div className="metric-pill"><span>Pages est.</span><strong>~{pages(tw)}</strong></div>
                <div className="metric-pill"><span>Chapitres</span><strong>{project.stats.chapterCount}</strong></div>
              </div>
            </section>
            <section className="surface">
              <div className="section-label" style={{ marginBottom: "10px" }}>Format</div>
              <div style={{ display: "grid", gap: "7px" }}>
                <Btn variant="primary" onClick={() => doExport("pdf")} disabled={!!exporting}>
                  <IconDownload />{exporting === "pdf" ? " Génération…" : " PDF (livre)"}
                </Btn>
                <Btn onClick={() => doExport("epub")} disabled={!!exporting}>
                  <IconDownload />{exporting === "epub" ? " Génération…" : " EPUB"}
                </Btn>
                <Btn onClick={() => doExport("html")} disabled={!!exporting}>
                  <IconDownload />{exporting === "html" ? " Génération…" : " HTML"}
                </Btn>
                <Btn onClick={() => doExport("text")} disabled={!!exporting}>
                  <IconDownload />{exporting === "text" ? " Génération…" : " Texte brut"}
                </Btn>
              </div>
              {exportError && <div className="inline-error" style={{ marginTop: "10px" }}>{exportError}</div>}
            </section>
          </div>
          <div className="export-preview">
            <div className="export-preview-header">
              <div className="section-label">{t("book.previewLabel")}</div>
              <Btn onClick={loadPreview} disabled={previewLoading}>{previewLoading ? "…" : "Actualiser"}</Btn>
            </div>
            <div className="export-preview-frame">
              {previewLoading
                ? <div style={{ display: "grid", placeItems: "center", height: "100%" }}><div className="spinner" /></div>
                : <iframe ref={iframeRef} className="export-preview-iframe" title="Aperçu" sandbox="allow-same-origin" />
              }
            </div>
          </div>
        </div>
      </PageLayout>
    </AppLayout>
  );
}

/* ─── Cover Designer ─── */
const DEFAULT_COVER_TEMPLATE_ID = "editorial-night";
const COVER_TEMPLATES = [
  {
    id: "editorial-night",
    label: "Editorial Night",
    description: "Sobre, littéraire, centré sur le titre.",
    bgColor: "#18181b",
    titleColor: "#f8f5ef",
    subtitleColor: "#c79c5d",
    authorColor: "#efe6da",
    titleFont: "Cormorant Garamond, Georgia, serif",
    subtitleFont: "Libre Baskerville, Georgia, serif",
    authorFont: "Libre Baskerville, Georgia, serif",
    titleSize: 92,
    subtitleSize: 26,
    authorSize: 30,
    overlayColor: "#09090b",
    overlayOpacity: 0.26,
    accentGlyph: "✦",
    layout: {
      align: "center",
      subtitle: { x: 12, y: 12, w: 76, h: 8 },
      title: { x: 10, y: 30, w: 80, h: 22 },
      ornament: { x: 43, y: 63, w: 14, h: 8 },
      author: { x: 18, y: 84, w: 64, h: 8 },
    },
  },
  {
    id: "paper-bloom",
    label: "Paper Bloom",
    description: "Clair, éditorial, très roman de librairie.",
    bgColor: "#f3ece1",
    titleColor: "#2f261f",
    subtitleColor: "#965d34",
    authorColor: "#43352c",
    titleFont: "Cormorant Garamond, Georgia, serif",
    subtitleFont: "Libre Baskerville, Georgia, serif",
    authorFont: "Libre Baskerville, Georgia, serif",
    titleSize: 88,
    subtitleSize: 24,
    authorSize: 28,
    overlayColor: "#efe5d9",
    overlayOpacity: 0.1,
    accentGlyph: "⁂",
    layout: {
      align: "center",
      subtitle: { x: 13, y: 14, w: 74, h: 7 },
      title: { x: 12, y: 33, w: 76, h: 20 },
      ornament: { x: 44, y: 61, w: 12, h: 7 },
      author: { x: 20, y: 84, w: 60, h: 8 },
    },
  },
  {
    id: "ember-line",
    label: "Ember Line",
    description: "Plus graphique, avec une colonne de texte assumée.",
    bgColor: "#2d1716",
    titleColor: "#fdf0dc",
    subtitleColor: "#f4a261",
    authorColor: "#f7e7d1",
    titleFont: "Lora, Georgia, serif",
    subtitleFont: "DM Sans, Arial, sans-serif",
    authorFont: "DM Sans, Arial, sans-serif",
    titleSize: 82,
    subtitleSize: 22,
    authorSize: 24,
    overlayColor: "#160808",
    overlayOpacity: 0.34,
    accentGlyph: "◆",
    layout: {
      align: "left",
      subtitle: { x: 11, y: 16, w: 56, h: 7 },
      title: { x: 11, y: 30, w: 58, h: 24 },
      ornament: { x: 11, y: 62, w: 12, h: 7 },
      author: { x: 11, y: 84, w: 56, h: 7 },
    },
  },
  {
    id: "fjord-ink",
    label: "Fjord Ink",
    description: "Atmosphérique, froid, parfait pour une image.",
    bgColor: "#10202b",
    titleColor: "#e8f3f7",
    subtitleColor: "#7fc6d8",
    authorColor: "#d7e8ee",
    titleFont: "Libre Baskerville, Georgia, serif",
    subtitleFont: "DM Sans, Arial, sans-serif",
    authorFont: "DM Sans, Arial, sans-serif",
    titleSize: 84,
    subtitleSize: 22,
    authorSize: 24,
    overlayColor: "#09131b",
    overlayOpacity: 0.32,
    accentGlyph: "∞",
    layout: {
      align: "center",
      subtitle: { x: 14, y: 15, w: 72, h: 7 },
      title: { x: 14, y: 34, w: 72, h: 18 },
      ornament: { x: 44, y: 58, w: 12, h: 7 },
      author: { x: 20, y: 84, w: 60, h: 7 },
    },
  },
];

function InspectorField({ label, children }) {
  return (
    <div className="cover-inspector-field">
      <div className="cover-inspector-field-label">{label}</div>
      {children}
    </div>
  );
}

function getCoverTemplate(templateId) {
  return COVER_TEMPLATES.find(template => template.id === templateId) || COVER_TEMPLATES[0];
}

function inferTemplateId(cover) {
  if (!cover) return DEFAULT_COVER_TEMPLATE_ID;
  if (cover.templateId && COVER_TEMPLATES.some(template => template.id === cover.templateId)) return cover.templateId;
  const matched = COVER_TEMPLATES.find(template => template.bgColor === cover.bgColor || template.titleFont === cover.titleFont);
  return matched?.id || DEFAULT_COVER_TEMPLATE_ID;
}

function CoverDesignerPage() {
  const { projectSlug } = useParams();
  const [project, setProject] = useState(null);
  const [cover, setCover] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");
  const [error, setError] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_COVER_TEMPLATE_ID);
  const [cropEditorOpen, setCropEditorOpen] = useState(false);
  const backgroundUploadRef = useRef(null);
  const customUploadRef = useRef(null);
  const cropperRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const selectedTemplate = useMemo(() => getCoverTemplate(selectedTemplateId), [selectedTemplateId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pp, cv] = await Promise.all([
        apiFetch(`/api/projects/${projectSlug}/`),
        apiFetch(`/api/projects/${projectSlug}/cover/`),
      ]);
      setProject(pp.project);
      setCover({ ...cv.cover, projectTitle: pp.project.title });
      setSelectedTemplateId(inferTemplateId(cv.cover));
      setLoading(false);
    } catch (e) { setError(extractErrorMessage(e)); setLoading(false); }
  }, [projectSlug]);

  useEffect(() => { load(); }, [load]);

  const saveCover = useCallback(async (payload) => {
    setSaving(true);
    setSaveState("Enregistrement…");
    try {
      const cv = await apiFetch(`/api/projects/${projectSlug}/cover/`, { method: "POST", body: payload });
      setSelectedTemplateId(inferTemplateId(cv.cover));
      setCover(current => ({ ...current, ...cv.cover, projectTitle: current?.projectTitle || project?.title }));
      setSaveState("Sauvegardé ✓");
      setTimeout(() => setSaveState(""), 1800);
    } catch (e) { setSaveState(extractErrorMessage(e)); }
    setSaving(false);
  }, [projectSlug, project?.title]);

  const queueCoverSave = useCallback((payload, immediate = false) => {
    pendingSaveRef.current = payload;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    if (immediate) {
      saveCover(payload);
      pendingSaveRef.current = null;
      return;
    }
    saveTimeoutRef.current = setTimeout(() => {
      if (pendingSaveRef.current) saveCover(pendingSaveRef.current);
      pendingSaveRef.current = null;
    }, 500);
  }, [saveCover]);

  const clearQueuedSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    pendingSaveRef.current = null;
  }, []);

  useEffect(() => () => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
  }, []);

  const syncGeneratedCover = useCallback((patch = {}, options = {}) => {
    setCover(current => {
      if (!current) return current;
      const template = options.template || selectedTemplate;
      const nextCover = buildGeneratedCoverPayload({ ...current, ...patch, editorMode: "generated" }, template);
      queueCoverSave(nextCover, options.immediate);
      return { ...current, ...nextCover };
    });
  }, [queueCoverSave, selectedTemplate]);

  const applyTemplate = (template) => {
    setSelectedTemplateId(template.id);
    syncGeneratedCover({ templateId: template.id }, { immediate: true, template });
  };

  const uploadBackground = async (file) => {
    clearQueuedSave();
    const fd = new FormData();
    fd.append("image", file);
    fd.append("target", "background");
    setSaveState("Téléversement…");
    try {
      const cv = await apiFetch(`/api/projects/${projectSlug}/cover/upload-image/`, { method: "POST", body: fd });
      setSelectedTemplateId(inferTemplateId(cv.cover));
      setCover({ ...cv.cover, projectTitle: project?.title });
      setSaveState("Image ajoutée ✓");
      setTimeout(() => setSaveState(""), 1800);
    } catch (e) { setSaveState(extractErrorMessage(e)); }
  };

  const uploadCustomCover = async (file) => {
    clearQueuedSave();
    const fd = new FormData();
    fd.append("image", file);
    fd.append("target", "custom");
    setSaveState("Téléversement…");
    try {
      const cv = await apiFetch(`/api/projects/${projectSlug}/cover/upload-image/`, { method: "POST", body: fd });
      setCover({ ...cv.cover, projectTitle: project?.title });
      setSaveState("Couverture importée ✓");
      setTimeout(() => setSaveState(""), 1800);
    } catch (e) { setSaveState(extractErrorMessage(e)); }
  };

  const removeBackgroundImage = async () => {
    clearQueuedSave();
    try {
      const cv = await apiFetch(`/api/projects/${projectSlug}/cover/`, { method: "POST", body: { removeCoverImage: true } });
      const nextPayload = buildGeneratedCoverPayload({ ...cv.cover, projectTitle: project?.title }, selectedTemplate);
      const saved = await apiFetch(`/api/projects/${projectSlug}/cover/`, { method: "POST", body: nextPayload });
      setCropEditorOpen(false);
      setCover({ ...saved.cover, projectTitle: project?.title });
    } catch (e) { setSaveState(extractErrorMessage(e)); }
  };

  const removeCustomCover = async () => {
    clearQueuedSave();
    try {
      const cv = await apiFetch(`/api/projects/${projectSlug}/cover/`, { method: "POST", body: { removeCustomCover: true } });
      const nextPayload = buildGeneratedCoverPayload({ ...cv.cover, projectTitle: project?.title, editorMode: "generated" }, selectedTemplate);
      const saved = await apiFetch(`/api/projects/${projectSlug}/cover/`, { method: "POST", body: nextPayload });
      setCover({ ...saved.cover, projectTitle: project?.title });
      setSaveState("Couverture personnalisée retirée");
      setTimeout(() => setSaveState(""), 1800);
    } catch (e) { setSaveState(extractErrorMessage(e)); }
  };

  const switchEditorMode = async (nextMode) => {
    if (!cover || nextMode === cover.editorMode) return;
    clearQueuedSave();
    if (nextMode === "generated") {
      const nextPayload = buildGeneratedCoverPayload({ ...cover, editorMode: "generated" }, selectedTemplate);
      saveCover(nextPayload);
      setCover(current => current ? { ...current, ...nextPayload } : current);
      return;
    }
    setSaving(true);
    setSaveState("Enregistrement…");
    try {
      const cv = await apiFetch(`/api/projects/${projectSlug}/cover/`, {
        method: "POST",
        body: { editorMode: "upload", displayMode: "full" },
      });
      setCover(current => ({ ...current, ...cv.cover, projectTitle: current?.projectTitle || project?.title }));
      setSaveState("Sauvegardé ✓");
      setTimeout(() => setSaveState(""), 1800);
    } catch (e) {
      setSaveState(extractErrorMessage(e));
    }
    setSaving(false);
  };

  const backgroundLayer = cover?.composition?.layers?.find(layer => layer.type === "background");
  const ornamentLayer = cover?.composition?.layers?.find(layer => layer.type === "ornament");
  const editorMode = cover?.editorMode === "upload" ? "upload" : "generated";
  const backgroundImageUrl = backgroundLayer?.imageUrl || cover?.coverImageUrl || "";
  const backgroundCrop = getBackgroundCropDraft(cover, backgroundLayer);
  const restoreCropperState = useCallback(() => {
    const cropper = cropperRef.current?.cropper || cropperRef.current;
    if (!cropper || !backgroundImageUrl) return;
    const imageData = cropper.getImageData();
    if (!imageData?.naturalWidth || !imageData?.naturalHeight) return;
    cropper.reset();
    cropper.setAspectRatio(COVER_ASPECT_RATIO);
    cropper.setDragMode("move");
    cropper.setData({
      x: (backgroundCrop.cropX / 100) * imageData.naturalWidth,
      y: (backgroundCrop.cropY / 100) * imageData.naturalHeight,
      width: (backgroundCrop.cropWidth / 100) * imageData.naturalWidth,
      height: (backgroundCrop.cropHeight / 100) * imageData.naturalHeight,
    });
    cropper.rotateTo(backgroundCrop.rotation || 0);
    cropper.scaleX(backgroundCrop.flipX || 1);
    cropper.scaleY(backgroundCrop.flipY || 1);
  }, [
    backgroundCrop.cropHeight,
    backgroundCrop.cropWidth,
    backgroundCrop.cropX,
    backgroundCrop.cropY,
    backgroundCrop.flipX,
    backgroundCrop.flipY,
    backgroundCrop.rotation,
    backgroundImageUrl,
  ]);

  const applyCropEdits = () => {
    const cropper = cropperRef.current?.cropper || cropperRef.current;
    if (!cropper) return;
    const data = cropper.getData(true);
    const imageData = cropper.getImageData();
    if (!imageData?.naturalWidth || !imageData?.naturalHeight) return;
    syncGeneratedCover({
      backgroundCropX: clamp((data.x / imageData.naturalWidth) * 100, 0, 99, 0),
      backgroundCropY: clamp((data.y / imageData.naturalHeight) * 100, 0, 99, 0),
      backgroundCropWidth: clamp((data.width / imageData.naturalWidth) * 100, 1, 100, 100),
      backgroundCropHeight: clamp((data.height / imageData.naturalHeight) * 100, 1, 100, 100),
      backgroundRotation: clamp(data.rotate ?? backgroundCrop.rotation, -180, 180, 0),
      backgroundFlipX: data.scaleX === -1 ? -1 : 1,
      backgroundFlipY: data.scaleY === -1 ? -1 : 1,
    }, { immediate: true });
    setCropEditorOpen(false);
  };

  if (loading) return <LoadingScreen />;
  if (error || !cover) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />;

  return (
    <AppLayout currentProjectSlug={project.slug}>
      <div className="cover-designer-shell cover-designer-shell--guided">
        <div className="cover-designer-topbar">
          <div className="cover-topbar-title">
            <span className="cover-topbar-project">{project.title}</span>
            <span className="cover-topbar-sep">—</span>
            <span className="cover-topbar-view">{editorMode === "upload" ? "Couverture personnalisée" : "Couverture générée"}</span>
          </div>
          <div className="cover-topbar-actions">
            <Link className="btn-ghost" to={`/projects/${project.slug}/export`}>Exporter</Link>
            {saveState && <span className="cover-save-state">{saveState}</span>}
          </div>
        </div>

        <div className="cover-designer-body cover-designer-body--guided">
          <aside className="cover-guided-panel">
            <div className="cover-guided-section">
              <div className="cover-guided-section-label">Mode</div>
              <div className="cover-mode-switch">
                <button type="button" className={cx("cover-mode-card", editorMode === "generated" && "is-active")} onClick={() => switchEditorMode("generated")}>
                  <strong>Couverture générée</strong>
                  <small>Texte, modèle, image de fond recadrable.</small>
                </button>
                <button type="button" className={cx("cover-mode-card", editorMode === "upload" && "is-active")} onClick={() => switchEditorMode("upload")}>
                  <strong>Couverture importée</strong>
                  <small>Utiliser une image finale exactement comme à l’export.</small>
                </button>
              </div>
            </div>

            {editorMode === "generated" ? (
              <>
                <div className="cover-guided-section">
                  <div className="cover-guided-section-label">Modèles</div>
                  <div className="cover-theme-grid">
                    {COVER_TEMPLATES.map(template => (
                      <button key={template.id} type="button" className={cx("cover-theme-card", selectedTemplateId === template.id && "is-active")} onClick={() => applyTemplate(template)}>
                        <span className={cx("cover-theme-swatch", `cover-theme-swatch--${template.id}`)} aria-hidden />
                        <strong>{template.label}</strong>
                        <small>{template.description}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cover-guided-note">
                  Le modèle pilote la mise en page, la palette et la typographie. Vous ne gérez plus les calques à la main: vous choisissez un style, vous remplissez le texte, puis vous recadrez l’image si besoin.
                </div>
              </>
            ) : (
              <div className="cover-upload-card">
                <strong>Image finale</strong>
                <p>Importez une couverture terminée. Elle sera utilisée telle quelle pour l’aperçu export, le HTML, le PDF et l’EPUB.</p>
                <button type="button" className="btn-secondary" onClick={() => customUploadRef.current?.click()}><IconUpload /> Importer une couverture</button>
                <input ref={customUploadRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; if (file) uploadCustomCover(file); e.target.value = ""; }} />
              </div>
            )}
          </aside>

          <section className="cover-guided-preview">
            <div className="cover-preview-card">
              <div className="cover-preview-card__label">{saving ? "Rendu en cours…" : "Aperçu"}</div>
              <div className="cover-preview-stage">
                {editorMode === "upload" ? (
                  cover.customCoverUrl
                    ? <img src={cover.customCoverUrl} alt="Couverture personnalisée" className="cover-rendered-preview-img" />
                    : (
                      <div className="cover-preview-empty">
                        <strong>Ajoutez une couverture finale</strong>
                        <span>Cette image sera utilisée sans transformation à l’export.</span>
                      </div>
                    )
                ) : (
                  cover.renderedCoverUrl
                    ? <img key={cover.renderedCoverUrl} src={cacheBustMediaUrl(cover.renderedCoverUrl)} alt="Couverture" className="cover-rendered-preview-img" style={saving ? { opacity: 0.45, transition: "opacity 0.15s" } : { transition: "opacity 0.15s" }} />
                    : (
                      <div className="cover-preview-empty">
                        <strong>{saving ? "Rendu en cours…" : "Aucun rendu"}</strong>
                        <span>La couverture s’affichera dès que le rendu sera terminé.</span>
                      </div>
                    )
                )}
              </div>
            </div>

            <div className="cover-preview-meta">
              <div>
                <span className="section-label">Couverture</span>
                <strong>{cover.titleText || project.title}</strong>
              </div>
              <span className="status-badge status-badge--accent">{saving ? "Synchronisation…" : "Prêt"}</span>
            </div>
          </section>

          <aside className="cover-guided-panel cover-guided-panel--inspector">
            {editorMode === "generated" ? (
              <>
                <div className="cover-guided-section">
                  <div className="cover-guided-section-label">Texte</div>
                  <div className="stack-form">
                    <InspectorField label="Sous-titre">
                      <input className="input" value={cover.subtitleText || ""} onChange={e => syncGeneratedCover({ subtitleText: e.target.value })} placeholder="Collection, promesse, mention…" />
                    </InspectorField>
                    <InspectorField label="Titre">
                      <textarea className="input textarea" rows="3" value={cover.titleText || ""} onChange={e => syncGeneratedCover({ titleText: e.target.value })} />
                    </InspectorField>
                    <InspectorField label="Auteur">
                      <input className="input" value={cover.authorText || ""} onChange={e => syncGeneratedCover({ authorText: e.target.value })} />
                    </InspectorField>
                  </div>
                </div>

                <div className="cover-guided-section">
                  <div className="cover-guided-section-label">Image de fond</div>
                  <div className="stack-form">
                    <div className="button-row">
                      <button type="button" className="btn-secondary" onClick={() => backgroundUploadRef.current?.click()}><IconUpload /> Ajouter une image</button>
                      <button type="button" className="btn-secondary" onClick={() => setCropEditorOpen(true)} disabled={!backgroundImageUrl}>Recadrer</button>
                      <button type="button" className="btn-ghost" onClick={removeBackgroundImage} disabled={!backgroundImageUrl}>Retirer</button>
                    </div>
                    <div className="cover-image-note">
                      {backgroundImageUrl
                        ? "Le recadrage garde le format exact de la couverture et prend en charge déplacement, zoom, rotation et miroir."
                        : "Ajoutez une image si vous voulez enrichir le modèle avec une photo ou une texture."}
                    </div>
                    <label className="checkbox-row">
                      <input type="checkbox" checked={ornamentLayer?.visible !== false} onChange={e => syncGeneratedCover({ showOrnament: e.target.checked }, { immediate: true })} />
                      <span>Afficher l’ornement du modèle</span>
                    </label>
                    <input ref={backgroundUploadRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; if (file) uploadBackground(file); e.target.value = ""; }} />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="cover-guided-section">
                  <div className="cover-guided-section-label">Couverture personnalisée</div>
                  <div className="stack-form">
                    <button type="button" className="btn-secondary" onClick={() => customUploadRef.current?.click()}><IconUpload /> Remplacer l’image</button>
                    <button type="button" className="btn-ghost" onClick={removeCustomCover} disabled={!cover.customCoverUrl}>Revenir au générateur</button>
                    <div className="cover-image-note">
                      Importez ici un visuel final prêt à l’emploi. InkRise ne lui ajoute ni titre, ni texte, ni recadrage.
                    </div>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
        {cropEditorOpen && backgroundImageUrl && (
          <div className="cover-crop-modal" role="dialog" aria-modal="true" aria-label="Editer l’image de couverture">
            <div className="cover-crop-modal__backdrop" onClick={() => setCropEditorOpen(false)} />
            <div className="cover-crop-modal__dialog">
              <div className="cover-crop-modal__header">
                <div>
                  <div className="section-label">Image de couverture</div>
                  <strong>Recadrer le fond</strong>
                </div>
                <button type="button" className="btn-ghost" onClick={() => setCropEditorOpen(false)}>Fermer</button>
              </div>
              <div className="cover-crop-modal__body">
                <div className="cover-cropper-wrap">
                  <Cropper
                    key={backgroundImageUrl}
                    ref={cropperRef}
                    src={backgroundImageUrl}
                    aspectRatio={COVER_ASPECT_RATIO}
                    initialAspectRatio={COVER_ASPECT_RATIO}
                    viewMode={1}
                    guides
                    responsive
                    background={false}
                    autoCropArea={1}
                    dragMode="move"
                    toggleDragModeOnDblclick={false}
                    cropBoxResizable
                    cropBoxMovable
                    checkOrientation={false}
                    ready={restoreCropperState}
                  />
                </div>
                <div className="cover-crop-toolbar">
                  <button
                    type="button"
                    className="mindmap-action-btn"
                    onClick={() => {
                      const cropper = cropperRef.current?.cropper || cropperRef.current;
                      cropper?.zoom(0.1);
                    }}
                  >
                    Zoom +
                  </button>
                  <button
                    type="button"
                    className="mindmap-action-btn"
                    onClick={() => {
                      const cropper = cropperRef.current?.cropper || cropperRef.current;
                      cropper?.zoom(-0.1);
                    }}
                  >
                    Zoom -
                  </button>
                  <button
                    type="button"
                    className="mindmap-action-btn"
                    onClick={() => {
                      const cropper = cropperRef.current?.cropper || cropperRef.current;
                      cropper?.rotate(-90);
                    }}
                  >
                    Rotation -
                  </button>
                  <button
                    type="button"
                    className="mindmap-action-btn"
                    onClick={() => {
                      const cropper = cropperRef.current?.cropper || cropperRef.current;
                      cropper?.rotate(90);
                    }}
                  >
                    Rotation +
                  </button>
                  <button
                    type="button"
                    className="mindmap-action-btn"
                    onClick={() => {
                      const cropper = cropperRef.current?.cropper || cropperRef.current;
                      const data = cropper?.getData(true);
                      cropper?.scaleX(data?.scaleX === -1 ? 1 : -1);
                    }}
                  >
                    Miroir H
                  </button>
                  <button
                    type="button"
                    className="mindmap-action-btn"
                    onClick={() => {
                      const cropper = cropperRef.current?.cropper || cropperRef.current;
                      const data = cropper?.getData(true);
                      cropper?.scaleY(data?.scaleY === -1 ? 1 : -1);
                    }}
                  >
                    Miroir V
                  </button>
                  <button type="button" className="mindmap-action-btn mindmap-action-btn--ghost" onClick={restoreCropperState}>Réinitialiser</button>
                </div>
              </div>
              <div className="cover-crop-modal__footer">
                <button type="button" className="btn-ghost" onClick={() => setCropEditorOpen(false)}>Annuler</button>
                <button type="button" className="btn-primary" onClick={applyCropEdits}>Appliquer</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}

/* ─── Stats (Writing Velocity) ─── */
function StatsPage() {
  const { projectSlug } = useParams();
  const [payload, setPayload] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [goalForm, setGoalForm] = useState({ targetWordCount: 50000, dailyTarget: 1000, deadline: "" }); const [goalSaved, setGoalSaved] = useState("");
  const load = useCallback(async () => { setLoading(true); try { const p = await apiFetch(`/api/projects/${projectSlug}/stats/`); setPayload(p); setGoalForm({ targetWordCount: p.goal.targetWordCount, dailyTarget: p.goal.dailyTarget, deadline: p.goal.deadline || "" }); setLoading(false); } catch (e) { setError(extractErrorMessage(e)); setLoading(false); } }, [projectSlug]);
  useEffect(() => { load(); }, [load]);
  const saveGoal = async () => { try { const p = await apiFetch(`/api/projects/${projectSlug}/stats/goal/`, { method: "POST", body: goalForm }); setGoalSaved("Sauvé"); setPayload(c => ({ ...c, goal: p.goal })); } catch (e) { setGoalSaved(extractErrorMessage(e)); } };
  if (loading) return <LoadingScreen />;
  if (error || !payload) return <ErrorState message={error} action={<Btn onClick={load}>Réessayer</Btn>} />;
  const { project, revisions, goal, overview } = payload;
  const tw = project.stats.totalWordCount;
  const ts = project.stats.totalCharacterCount ?? 0;
  const progress = goal.targetWordCount > 0 ? Math.min(100, Math.round((tw / goal.targetWordCount) * 100)) : 0;
  const chapters = project.chapters || [];
  const maxWords = Math.max(...chapters.map(c => c.wordCount), 1);
  const continueChapterId = overview?.continueChapterId || project.continueChapterId || chapters[0]?.id;
  const latestRevision = revisions[0];
  const averageChapterWords = chapters.length ? Math.round(tw / chapters.length) : 0;
  const deadlineText = goal.deadline ? new Date(goal.deadline).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "Aucune";

  return (
    <AppLayout currentProjectSlug={project.slug}>
      <PageLayout title={project.title} subtitle="Cockpit du projet">
        <div className="project-home-hero surface">
          <div className="project-home-hero-cover">
            {project.cover?.thumbnailUrl ? <img src={project.cover.thumbnailUrl} alt="" /> : <div className="project-home-cover-fallback" style={{ "--book-accent": project.accentColor }} />}
          </div>
          <div className="project-home-hero-copy">
            <div className="section-label">{project.genre || t("book.genreFallback")}</div>
            <h2>{project.logline || t("book.cockpitTagline")}</h2>
            <p>Dernière activité : {formatLongWhen(overview?.lastActivityAt || project.lastActivityAt)}</p>
            <div className="project-home-progress">
              <div className="project-home-progress-bar"><span style={{ width: `${progress}%` }} /></div>
              <div className="project-home-progress-meta">
                <strong>{progress}%</strong>
                <span>{tw.toLocaleString("fr-FR")} / {goal.targetWordCount.toLocaleString("fr-FR")} mots</span>
              </div>
            </div>
          </div>
          <div className="project-home-hero-actions">
            <Link className="btn-primary" to={continueChapterId ? `/projects/${project.slug}/workspace/${continueChapterId}` : `/projects/${project.slug}/workspace`}>Continuer</Link>
            <Link className="btn-secondary" to={`/projects/${project.slug}/cover`}>Couverture</Link>
            <Link className="btn-secondary" to={`/projects/${project.slug}/export`}>Exporter</Link>
            <Link className="btn-secondary" to={`/projects/${project.slug}/connections`}>Carte mentale</Link>
          </div>
        </div>

        <div className="project-home-grid">
          <section className="surface">
            <div className="surface-header">
              <div>
                <div className="section-label">{t("book.healthSection")}</div>
                <h2>Répartition des chapitres</h2>
              </div>
            </div>
            <div className="project-home-metrics">
              <div className="project-home-metric"><span>Total mots</span><strong>{tw.toLocaleString("fr-FR")}</strong></div>
              <div className="project-home-metric"><span>Total signes</span><strong title="Caractères dans le texte (espaces compris), selon la même règle qu’à l’enregistrement.">{ts.toLocaleString("fr-FR")}</strong></div>
              <div className="project-home-metric"><span>Chapitres</span><strong>{project.stats.chapterCount}</strong></div>
              <div className="project-home-metric"><span>Moyenne / chapitre</span><strong>{averageChapterWords.toLocaleString("fr-FR")}</strong></div>
              <div className="project-home-metric"><span>Pages estimées</span><strong>{pages(tw)}</strong></div>
            </div>
            <div className="chart-bars chart-bars--project-home">
              {chapters.map(ch => (
                <div key={ch.id} className="chart-bar-col">
                  <div className="chart-bar" style={{ height: `${Math.max(6, (ch.wordCount / maxWords) * 100)}%` }} />
                  <span className="chart-bar-label">{ch.title}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="surface">
            <div className="surface-header">
              <div>
                <div className="section-label">Action rapide</div>
                <h2>Postes du studio</h2>
              </div>
            </div>
            <div className="project-home-actions-grid">
              <Link className="project-home-action-card" to={continueChapterId ? `/projects/${project.slug}/workspace/${continueChapterId}` : `/projects/${project.slug}/workspace`}><strong>Continuer l’écriture</strong><span>Reprendre au dernier chapitre actif.</span></Link>
              <Link className="project-home-action-card" to={`/projects/${project.slug}/structure`}><strong>Structure</strong><span>Voir les chapitres incomplets et l’équilibre global.</span></Link>
              <Link className="project-home-action-card" to={`/projects/${project.slug}/connections`}><strong>Carte mentale</strong><span>Relier idées, scènes, personnages et lieux.</span></Link>
              <Link className="project-home-action-card" to={`/projects/${project.slug}/cover`}><strong>Couverture</strong><span>Composer la jaquette et préparer l’export.</span></Link>
            </div>
          </section>

          <section className="surface">
            <div className="surface-header">
              <div>
                <div className="section-label">Objectifs</div>
                <h2>Cadence et échéance</h2>
              </div>
              {goalSaved && <span className="status-badge status-badge--accent">{goalSaved}</span>}
            </div>
            <div className="stack-form">
              <div className="form-grid">
                <Field label="Objectif total"><input className="input" type="number" value={goalForm.targetWordCount} onChange={e => setGoalForm(c => ({ ...c, targetWordCount: Number(e.target.value) }))} /></Field>
                <Field label="Objectif quotidien"><input className="input" type="number" value={goalForm.dailyTarget} onChange={e => setGoalForm(c => ({ ...c, dailyTarget: Number(e.target.value) }))} /></Field>
              </div>
              <Field label="Deadline"><input className="input" type="date" value={goalForm.deadline} onChange={e => setGoalForm(c => ({ ...c, deadline: e.target.value }))} /></Field>
              <div className="project-home-goal-meta">
                <span>Échéance : {deadlineText}</span>
                <span className={cx("status-badge", overview?.overdue && "status-badge--danger")}>{overview?.overdue ? "En retard" : "Dans les temps"}</span>
              </div>
              <Btn variant="primary" onClick={saveGoal}>Sauvegarder</Btn>
            </div>
          </section>

          <section className="surface">
            <div className="surface-header">
              <div>
                <div className="section-label">Activité</div>
                <h2>Révisions récentes</h2>
              </div>
            </div>
            <div className="list-surface">
              {revisions.map(revision => (
                <div key={revision.id} className="list-row">
                  <div className="list-row-topline">
                    <strong>{revision.chapterTitle}</strong>
                    <small>{formatWhen(revision.createdAt)}</small>
                  </div>
                  <p>{revision.wordCount.toLocaleString("fr-FR")} mots · {revision.source}</p>
                </div>
              ))}
              {!revisions.length && <div className="inline-note">Aucune révision récente.</div>}
            </div>
          </section>

          <section className="surface">
            <div className="surface-header">
              <div>
                <div className="section-label">État projet</div>
                <h2>Indicateurs</h2>
              </div>
            </div>
            <div className="project-home-status-stack">
              <div className="velocity-bottom-stat"><div className="stat-label">Dernière session</div><strong>{latestRevision ? formatWhen(latestRevision.createdAt) : "—"}</strong></div>
              <div className="velocity-bottom-stat"><div className="stat-label">Chapitres à finir</div><strong>{overview?.incompleteChapterCount ?? 0}</strong></div>
              <div className="velocity-bottom-stat"><div className="stat-label">Couverture</div><strong>{overview?.coverReady ? "Prête" : "À composer"}</strong></div>
              <div className="velocity-bottom-stat"><div className="stat-label">Caractères</div><strong>{project.stats.totalCharacterCount.toLocaleString("fr-FR")}</strong></div>
            </div>
          </section>
        </div>
      </PageLayout>
    </AppLayout>
  );
}

/* ─── Profile / Help ─── */
function ProfilePage() {
  const { refreshSession, session } = useSession();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    penName: "",
    bio: "",
    defaultFontFamily: "serif",
    defaultFontSize: 18,
    defaultLineHeight: 1.8,
    defaultContentWidth: 820,
    uiTheme: "system",
    uiAccent: "",
  });

  useEffect(() => {
    apiFetch("/api/profile/")
      .then(p => {
        setForm({
          penName: p.profile.penName || "",
          bio: p.profile.bio || "",
          defaultFontFamily: p.profile.defaultFontFamily,
          defaultFontSize: p.profile.defaultFontSize,
          defaultLineHeight: p.profile.defaultLineHeight,
          defaultContentWidth: p.profile.defaultContentWidth,
          uiTheme: p.profile.uiTheme || "system",
          uiAccent: p.profile.uiAccent || "",
        });
        setLoading(false);
      })
      .catch(e => {
        setError(extractErrorMessage(e));
        setLoading(false);
      });
  }, []);

  const submit = async e => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/profile/", {
        method: "POST",
        body: {
          pen_name: form.penName,
          bio: form.bio,
          default_font_family: form.defaultFontFamily,
          default_font_size: form.defaultFontSize,
          default_line_height: form.defaultLineHeight,
          default_content_width: form.defaultContentWidth,
          ui_theme: form.uiTheme,
          ui_accent: form.uiAccent.trim() || "",
        },
      });
      await refreshSession();
      applyUserTheme({ uiTheme: form.uiTheme, uiAccent: form.uiAccent.trim() || null });
      setSaving(false);
    } catch (e) {
      setError(extractErrorMessage(e));
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen />;
  return (
    <AppLayout>
      <PageLayout title="Compte et préférences" subtitle="Profil, apparence, livre par défaut">
        <div className="profile-page-grid">
          <section className="surface">
            <div className="surface-header"><h2>Identité</h2></div>
            <form className="stack-form stack-form--wide" onSubmit={submit}>
              <Field label="Nom de plume"><input className="input" value={form.penName} onChange={e => setForm(c => ({ ...c, penName: e.target.value }))} /></Field>
              <Field label="Bio"><textarea className="input textarea" rows="4" value={form.bio} onChange={e => setForm(c => ({ ...c, bio: e.target.value }))} /></Field>
              <div className="divider" />
              <div className="section-label" style={{ marginBottom: 8 }}>Apparence</div>
              <Field label="Thème" hint="« Système » suit le réglage macOS / Windows.">
                <select className="input" value={form.uiTheme} onChange={e => setForm(c => ({ ...c, uiTheme: e.target.value }))}>
                  <option value="system">Système (par défaut)</option>
                  <option value="dark">Sombre</option>
                  <option value="light">Clair</option>
                </select>
              </Field>
              <Field label="Couleur d’accent" hint="Laisser vide pour la teinte du thème. Format #RRGGBB.">
                <div className="profile-accent-row">
                  <input className="input" value={form.uiAccent} onChange={e => setForm(c => ({ ...c, uiAccent: e.target.value }))} placeholder="#c49a6c" maxLength={7} spellCheck={false} />
                  <button type="button" className="btn-ghost" onClick={() => setForm(c => ({ ...c, uiAccent: "" }))}>Par défaut</button>
                </div>
              </Field>
              <div className="divider" />
              <div className="section-label" style={{ marginBottom: 8 }}>Nouveaux projets (valeurs par défaut)</div>
              <div className="form-grid">
                <Field label="Police livre"><select className="input" value={form.defaultFontFamily} onChange={e => setForm(c => ({ ...c, defaultFontFamily: e.target.value }))}><option value="serif">Serif</option><option value="sans">Sans</option><option value="mono">Mono</option></select></Field>
                <Field label="Taille (px)"><input className="input" type="number" min={12} max={32} value={form.defaultFontSize} onChange={e => setForm(c => ({ ...c, defaultFontSize: Number(e.target.value) }))} /></Field>
              </div>
              <div className="form-grid">
                <Field label="Interligne"><input className="input" type="number" step="0.05" min={1.2} max={2.5} value={form.defaultLineHeight} onChange={e => setForm(c => ({ ...c, defaultLineHeight: Number(e.target.value) }))} /></Field>
                <Field label="Largeur colonne (px)"><input className="input" type="number" min={480} max={1200} step={10} value={form.defaultContentWidth} onChange={e => setForm(c => ({ ...c, defaultContentWidth: Number(e.target.value) }))} /></Field>
              </div>
              {error && <div className="inline-error">{error}</div>}
              <Btn variant="primary" type="submit" disabled={saving}>{saving ? "Enregistrement…" : "Enregistrer les préférences"}</Btn>
            </form>
          </section>
          <aside className="surface profile-security-card">
            <div className="surface-header"><h2>Sécurité</h2></div>
            <p className="text-secondary" style={{ fontSize: 13, lineHeight: 1.5 }}>Pour changer votre mot de passe, utilisez le lien envoyé par e-mail (valable un court moment).</p>
            <a className="btn-secondary" href="/accounts/password_reset/" style={{ display: "inline-flex", justifyContent: "center", width: "100%" }}>Réinitialiser le mot de passe</a>
            {session.user?.isStaff && (
              <>
                <div className="divider" style={{ margin: "16px 0" }} />
                <div className="section-label" style={{ marginBottom: 8 }}>Équipe</div>
                <a className="btn-secondary" href="/studio-console/" style={{ display: "inline-flex", justifyContent: "center", width: "100%" }}>Console équipe</a>
                <p className="inline-note" style={{ marginTop: 8 }}>Compteurs, raccourcis admin et inscriptions récentes.</p>
              </>
            )}
            <p className="inline-note" style={{ marginTop: 12 }}>Déconnexion depuis le menu en bas à gauche du studio.</p>
          </aside>
        </div>
      </PageLayout>
    </AppLayout>
  );
}

function HelpPage() {
  const sections = [
    { l: "Workspace", title: "Organisation", items: ["Dashboard avec vos projets.", "Éditeur avec chapitres et outils.", "Dictionnaire, personnages, lieux dédiés."] },
    { l: "Écriture", title: "Outils", items: ["Sauvegarde auto.", "Résumé, notes, thésaurus, correcteur.", "Images via la barre d'outils."] },
    { l: "Export", title: t("help.exportSectionTitle"), items: t("help.exportBullets") },
  ];
  return (
    <AppLayout>
      <PageLayout title="Aide" subtitle="Guide">
        <div className="help-grid">
          {sections.map(s => (
            <section key={s.l} className="surface">
              <div className="surface-header">
                <div>
                  <div className="section-label">{s.l}</div>
                  <h2>{s.title}</h2>
                </div>
              </div>
              <ul className="bullet-list">{s.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
            </section>
          ))}
        </div>
      </PageLayout>
    </AppLayout>
  );
}

/* ─── Routes ─── */
function AppRoutes() {
  return (<Routes>
    <Route path="/" element={<HomeRedirect />} />
    <Route path="/login" element={<PublicOnly><LoginPage /></PublicOnly>} />
    <Route path="/register" element={<PublicOnly><RegisterPage /></PublicOnly>} />
    <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
    <Route path="/projects/new" element={<RequireAuth><ProjectFormPage mode="create" /></RequireAuth>} />
    <Route path="/projects/:projectSlug/edit" element={<RequireAuth><ProjectFormPage mode="edit" /></RequireAuth>} />
    <Route path="/projects/:projectSlug/workspace" element={<RequireAuth><WorkspacePage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/workspace/:chapterId" element={<RequireAuth><WorkspacePage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/dictionary" element={<RequireAuth><DictionaryPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/characters" element={<RequireAuth><CharactersPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/places" element={<RequireAuth><PlacesPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/structure" element={<RequireAuth><StructurePage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/connections" element={<RequireAuth><ConnectionsPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/research" element={<RequireAuth><ResearchPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/matter" element={<RequireAuth><MatterPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/cover" element={<RequireAuth><CoverDesignerPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/export" element={<RequireAuth><ExportPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/stats" element={<RequireAuth><StatsPage /></RequireAuth>} />
    <Route path="/projects/:projectSlug/search" element={<RequireAuth><SearchPage /></RequireAuth>} />
    <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
    <Route path="/help" element={<RequireAuth><HelpPage /></RequireAuth>} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>);
}

function App() {
  const sessionState = useSessionProvider();
  return <SessionContext.Provider value={sessionState}><BrowserRouter><AppRoutes /></BrowserRouter></SessionContext.Provider>;
}

createRoot(document.getElementById("root")).render(<App />);
