import "./index.css";
import React, { createContext, useContext, useReducer, useEffect, useState, useRef, useCallback, useLayoutEffect, ReactNode, memo } from 'react';
import ReactDOM from 'react-dom/client';
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

const TEST_MODE = import.meta.env.DEV;

// Automatically route to port 6328 in development to prevent Vite from swallowing the request and returning 404
const API_BASE = (import.meta.env.VITE_API_BASE_URL || (import.meta.env.DEV ? 'http://localhost:6328/api' : '/api')).replace(/\/$/, '');
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

declare global { interface Window { google: any; turnstile: any; } }

const cn = (...i: ClassValue[]) => twMerge(clsx(i));

export type ChunkMode = 'auto' | 'manual';

export interface ModelDef { id: string; name: string; }
export interface TierConfig { max_instances: number; max_episodes: number; max_episode_length: number; max_lore_length: number; max_profile_length: number; storage_mb: number; retention_days: number | null; auto_summaries: boolean; sharing: string; full_sharing: boolean; branches: boolean; priority_processing: boolean; bulk_import: boolean; }
export interface UserProfile { id: number; email: string; created_at: string; credits: number; credits_total: number; credits_reset_at: string | null; subscription_tier: string; subscription_started_at: string | null; subscription_ends_at: string | null; billing_cycle: string; credit_addon: string | null; is_verified: boolean; phone_verified?: boolean; masked_phone?: string | null; free_grant_status?: string | null; can_use_hosted_credits?: boolean; next_step?: 'email_verify' | 'phone_verify' | 'ready' | 'blocked'; is_in_plus_trial: boolean; plus_trial_days_remaining: number; plus_trial_days_used: number; trial_finished_today?: boolean; content_expires_at: string | null; pending_deletion_at?: string | null; is_admin: boolean; tier_config: TierConfig; archived_instances?: { id: string; name: string }[]; downgrade_message?: string; is_downgrade?: boolean; chunk_selection_mode?: ChunkMode; }
export interface Message { id: string; role: 'user' | 'ai' | 'assistant'; content: string; reasoning?: string; meta?: any; }
export interface Episode { id: string; name: string; description?: string; context: string; }
export interface Show { id: string; name: string; description: string; lore: string; profile: string; episodes: Episode[]; settings?: { default_chunk_mode?: ChunkMode; }; }
export interface InstanceSummary { episodeName: string; summary: string; timestamp: string; }
export interface Instance { id: string; showId: string; showName: string; currentEpisodeIndex: number; messages: Message[]; lastPlayed: string; lore: string; profile: string; episodes: Episode[]; summaryHistory: InstanceSummary[]; is_archived?: boolean; is_owner?: boolean; sharing?: 'private'|'read_only'|'full'; creator_tier?: string; current_chunk_id?: number; settings?: { chunk_mode?: ChunkMode; }; }
export interface ChunkInfo { index: number; preview: string; length: number; played: boolean; full_text?: string; }
export interface ChunkData { episodeIndex: number; episodeName: string; currentChunkId: number; totalChunks: number; chunks: ChunkInfo[]; playedSegments: number[]; }
export interface ChunkSummaryItem { index: number; summary: string; preview: string; played: boolean; full_text?: string; }
export interface ChunkSelectionPayload { needs_chunk_selection: true; episode_name: string; episode_index: number; current_chunk: number; summaries: ChunkSummaryItem[]; }
export interface Settings { model: string; chunkSelectionMode: ChunkMode; colorTheme: 'purple' | 'cyan' | 'green' | 'amber' | 'mono' | 'red'; appearance: 'dark' | 'light'; enablePerspective: boolean; hasSeenTutorial: boolean; }
export interface TierChangeNotification { type: 'upgrade' | 'downgrade'; fromTier: string; toTier: string; message?: string; archivedInstances?: { id: string; name: string }[]; isTrialActivated?: boolean; trialDaysRemaining?: number; }

export interface AppState {
  view: 'home' | 'auth' | 'app' | 'shared';
  tutorialOpen: boolean;
  sharedId: string | null;
  authMode: 'login' | 'register' | 'verify' | 'phone';
  token: string | null;
  userProfile: UserProfile | null;
  activePanel: string;
  shows: Show[];
  instances: Instance[];
  currentInstance: Instance | null;
  messages: Message[];
  isGenerating: boolean;
  streamingText: string;
  streamingReasoning: string;
  streamingMeta: { selectedChunk?: number; totalChunks?: number; mode?: string; selectionReason?: string } | null;
  settings: Settings;
  editingShow: Show | null | undefined;
  lore: string;
  profile: string;
  availableModels: ModelDef[];
  upgradePrompt: { isOpen: boolean; title: string; message: string; feature?: string; showCredits?: boolean; } | null;
  tierChangeNotification: TierChangeNotification | null;
  billingPageOpen: boolean;
}

function CloseIcon({ size = 12 }: { size?: number }) { return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>); }
function SettingsIcon({ size = 16 }: { size?: number }) { return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 1 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>); }
function UserIcon({ size = 16 }: { size?: number }) { return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>); }
function CreditIcon({ size = 16 }: { size?: number }) { return (<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>); }
const CloseButton = memo(({ onClick, large }: { onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; large?: boolean; }) => (<button onClick={onClick} className={cn("close-btn", large && "close-btn-lg")}><CloseIcon size={large ? 14 : 12} /></button>));
const ParaDivider = memo(() => (<div className="para-divider my-2"><div className="para-divider-shard" /><div className="para-divider-center" /><div className="para-divider-shard" /></div>));
const ParaProgress = memo(({ current, total }: { current: number; total: number; }) => (<div className="para-progress">{Array.from({ length: total }, (_, i) => (<div key={i} className={cn("para-progress-seg", i < current && "para-progress-seg-fill")} />))}</div>));
const TierBadge = memo(({ tier, trial, clickable = false, onClick }: { tier: string; trial?: boolean; clickable?: boolean; onClick?: () => void; }) => { const effectiveTier = trial ? 'Plus' : tier; return (<div className={cn("tier-badge", `tier-badge-${effectiveTier.toLowerCase()}`, clickable && "cursor-pointer hover:scale-105 transition-transform")} onClick={clickable ? onClick : undefined}>{trial ? 'PLUS TRIAL' : tier.toUpperCase()}</div>); });

function ChunkModeBadge({ mode }: { mode: ChunkMode }) {
  const labels: Record<ChunkMode, string> = { auto: 'AUTO', manual: 'MANUAL' };
  const colors: Record<ChunkMode, string> = { auto: 'var(--accent)', manual: '#f59e0b' };
  return (
    <div className="para-badge" style={{ borderColor: colors[mode], color: colors[mode] }}>
      <span>{labels[mode]}</span>
    </div>
  );
}

export class APIService {
  private ac: AbortController | null = null;
  private token: string | null = null;
  private cache = new Map<string, { data: any; expiry: number }>();
  private CACHE_TTL = 30000;
  private base = API_BASE;

  getToken() { return this.token; }
  setToken(t: string | null) { this.token = t; }
  getHeaders(withJson = false) { return { ...(withJson ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}) }; }
  private async hr(r: Response) {
    if (!r.ok) {
      let payload;
      try {
        payload = await r.json();
      } catch {
        const fallbackError = r.status === 404 
          ? `Backend API Not Found (404). Ensure the Python server is running on port 6328.` 
          : r.statusText;
        payload = { error: fallbackError };
      }
      const err = new Error(payload.error || 'API Error') as Error & { code?: string; payload?: any };
      err.code = payload.code;
      err.payload = payload;
      throw err;
    }
    return r.json();
  }
  private async request(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers || {});
    if (this.token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${this.token}`);
    const response = await fetch(url, { ...init, headers, credentials: 'include' });
    if (retry && response.status === 401) {
      const payload = await response.clone().json().catch(() => ({}));
      if (payload.code === 'token_expired' || payload.code === 'invalid_token' || payload.code === 'missing_token') {
        const refreshed = await this.refreshSession(true);
        if (refreshed?.token) return this.request(url, init, false);
        this.setToken(null);
        window.dispatchEvent(new CustomEvent('auth-error', { detail: payload.error || 'Session expired' }));
        throw new Error('SESSION_EXPIRED');
      }
    }
    return response;
  }
  private getCache<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (item && Date.now() < item.expiry) return item.data as T;
    this.cache.delete(key);
    return null;
  }
  private setCache(key: string, data: any) { this.cache.set(key, { data, expiry: Date.now() + this.CACHE_TTL }); }

  stop() { if (this.ac) { this.ac.abort(); this.ac = null; } }
  async refreshSession(silent = false) {
    try {
      const response = await fetch(`${this.base}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!response.ok) {
        this.setToken(null);
        if (!silent) window.dispatchEvent(new CustomEvent('auth-error', { detail: 'Session expired' }));
        return null;
      }
      const data = await response.json();
      this.setToken(data.token || null);
      return data;
    } catch {
      this.setToken(null);
      return null;
    }
  }
  async verifyEmail(email: string, code: string) { const r = await this.hr(await this.request(`${this.base}/auth/verify`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ email, code }) }, false)); this.setToken(r.token || null); return r; }
  async login(email: string, password: string, turnstileToken?: string) { const r = await this.hr(await this.request(`${this.base}/auth/login`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ email, password, turnstile_token: turnstileToken || '' }) }, false)); this.setToken(r.token || null); return r; }
async register(email: string, password: string, turnstileToken: string, tosAccepted: boolean) { const r = await this.hr(await this.request(`${this.base}/auth/register`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ email, password, turnstile_token: turnstileToken, tos_accepted: tosAccepted }) }, false)); if (r.token) this.setToken(r.token); return r; }  async googleAuth(credential: string, turnstileToken: string) { const r = await this.hr(await this.request(`${this.base}/auth/google`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ credential, turnstile_token: turnstileToken }) }, false)); this.setToken(r.token || null); return r; }
  async resendCode(email: string) { return this.hr(await this.request(`${this.base}/auth/resend-code`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ email }) }, false)); }
  async phoneStart(phoneNumber: string, turnstileToken?: string) { return this.hr(await this.request(`${this.base}/auth/phone/start`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ phone_number: phoneNumber, turnstile_token: turnstileToken || '' }) })); }
  async phoneVerify(phoneNumber: string, code: string) { return this.hr(await this.request(`${this.base}/auth/phone/verify`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ phone_number: phoneNumber, code }) })); }
  async getMe() { return this.hr(await this.request(`${this.base}/auth/me`, { headers: this.getHeaders() })); }
  async getCredits() { return this.hr(await this.request(`${this.base}/credits`, { headers: this.getHeaders() })); }
  async logout() { try { await fetch(`${this.base}/auth/logout`, { method: 'POST', credentials: 'include' }); } finally { this.setToken(null); } }
  async getModels(): Promise<ModelDef[]> { const cached = this.getCache<ModelDef[]>('models'); if (cached) return cached; const r = await this.request(`${this.base}/models`, { headers: this.getHeaders() }); const data = r.ok ? await r.json() :[]; if (data.length) this.setCache('models', data); return data; }
  async getShows(): Promise<Show[]> { const cached = this.getCache<Show[]>('shows'); if (cached) return cached; const r = await this.request(`${this.base}/shows`, { headers: this.getHeaders() }); const data = r.ok ? await r.json() :[]; this.setCache('shows', data); return data; }
  async createShow(d: Partial<Show>, onProgress?: (msg: string) => void): Promise<Show> { const result = await this.streamSaveShow(`${this.base}/shows`, 'POST', d, onProgress); this.cache.delete('shows'); return result; }
  async updateShow(id: string, d: Partial<Show>, onProgress?: (msg: string) => void): Promise<Show> { return this.streamSaveShow(`${this.base}/shows/${id}`, 'PUT', d, onProgress); }
  async deleteShow(id: string) { await this.request(`${this.base}/shows/${id}`, { method: 'DELETE', headers: this.getHeaders() }); this.cache.delete('shows'); }

  private async streamSaveShow(url: string, method: string, d: any, onProgress?: (msg: string) => void): Promise<Show> {
    const r = await this.request(url, { method, headers: this.getHeaders(true), body: JSON.stringify(d) });
    if (!r.ok) await this.hr(r);
    const reader = r.body?.getReader(); if (!reader) throw new Error('No stream body');
    const dec = new TextDecoder(); let buf = ''; let finalShow = null;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          const p = JSON.parse(l);
          if (p.type === 'progress') { if (onProgress) onProgress(p.data.message); }
          else if (p.type === 'complete') { finalShow = p.show; }
          else if (p.type === 'error') { throw new Error(p.message); }
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    }
    if (!finalShow) throw new Error('Incomplete response');
    return finalShow as Show;
  }

  async getInstances(): Promise<Instance[]> { const cached = this.getCache<Instance[]>('instances'); if (cached) return cached; const r = await this.request(`${this.base}/instances?include_archived=true`, { headers: this.getHeaders() }); const data = r.ok ? await r.json() :[]; this.setCache('instances', data); return data; }
  async createInstance(showId: string) { const result = await this.hr(await this.request(`${this.base}/instances`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ showId }) })); this.cache.delete('instances'); return result; }
  async updateInstance(id: string, d: Partial<Instance>) { return this.hr(await this.request(`${this.base}/instances/${id}`, { method: 'PUT', headers: this.getHeaders(true), body: JSON.stringify(d) })); }
  async deleteInstance(id: string) { await this.request(`${this.base}/instances/${id}`, { method: 'DELETE', headers: this.getHeaders() }); this.cache.delete('instances'); }
  async unarchiveInstance(id: string) { return this.hr(await this.request(`${this.base}/instances/${id}/unarchive`, { method: 'POST', headers: this.getHeaders() })); }
  async updateSharing(id: string, sharing: string) { return this.hr(await this.request(`${this.base}/instances/${id}/share`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ sharing }) })); }
  async getSharedInstance(id: string) { const r = await this.request(`${this.base}/shared/instances/${id}`, { headers: this.getHeaders() }); if (!r.ok) throw new Error('Shared instance not found or private'); return r.json(); }
  async exportInstance(instId: string, format: 'json' | 'markdown' | 'txt' = 'markdown'): Promise<boolean> {
    const ext = format === 'markdown' ? 'md' : format;
    const r = await this.request(`${this.base}/instances/${instId}/export?format=${format}`, {
        headers: this.getHeaders()
    });
    if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(err.error || 'Export failed');
    }
    const blob = await r.blob();
    const contentDisposition = r.headers.get('Content-Disposition');
    let filename = `chat_${instId.slice(0, 8)}.${ext}`;
    if (contentDisposition) {
        const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match && match[1]) {
            filename = decodeURIComponent(match[1].replace(/['"]/g, ''));
        }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
}

async exportSharedInstance(instId: string, format: 'json' | 'markdown' | 'txt' = 'markdown'): Promise<boolean> {
    const ext = format === 'markdown' ? 'md' : format;
    const r = await this.request(`${this.base}/shared/instances/${instId}/export?format=${format}`, {
        headers: this.getHeaders()
    });
    if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(err.error || 'Export failed');
    }
    const blob = await r.blob();
    const contentDisposition = r.headers.get('Content-Disposition');
    let filename = `chat_${instId.slice(0, 8)}.${ext}`;
    if (contentDisposition) {
        const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (match && match[1]) {
            filename = decodeURIComponent(match[1].replace(/['"]/g, ''));
        }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
}
  async branchInstance(id: string, messageId: string) { return this.hr(await this.request(`${this.base}/instances/${id}/branch`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ message_id: messageId }) })); }
  async advanceInstance(id: string, summary: string) { return this.hr(await this.request(`${this.base}/instances/${id}/advance`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ summary }) })); }
  async summarizeText(text: string) { return this.hr(await this.request(`${this.base}/summarize`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ text }) })); }
  async generateLore(showName: string, description: string, episodes: Episode[]) { 
    return this.hr(await this.request(`${this.base}/shows/generate-lore`, { 
      method: 'POST', 
      headers: this.getHeaders(true), 
      body: JSON.stringify({ showName, description, episodes }) 
    })); 
  }
  async getInstanceChunks(instId: string): Promise<ChunkData> { return this.hr(await this.request(`${this.base}/instances/${instId}/chunks`, { headers: this.getHeaders() })); }
  async selectChunk(instId: string, chunkId: number) { return this.hr(await this.request(`${this.base}/instances/${instId}/select-chunk`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ chunkId }) })); }

  async updateEnvSettings(s: any) {
    await this.request(`${this.base}/settings`, { method: 'PUT', headers: this.getHeaders(true), body: JSON.stringify({ model: s.model, chunk_selection_mode: s.chunkSelectionMode }) });
  }
  async getEnvSettings() {
    const r = await this.request(`${this.base}/settings`, { headers: this.getHeaders() });
    if (r.ok) { const d = await r.json(); return { model: d.model, chunkSelectionMode: (d.chunk_selection_mode || 'auto') as ChunkMode }; }
    return {};
  }
  async updateSubscriptionTier(tier: string, cycle: string = 'monthly'): Promise<any> { const r = await this.hr(await this.request(`${this.base}/subscription/upgrade`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ tier, cycle }) })); if (r.url) { window.location.href = r.url; return new Promise(() => {}); } return r; }
  async purchaseCreditPack(packId: string): Promise<any> { const r = await this.hr(await this.request(`${this.base}/subscription/buy-credits`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify({ pack: packId }) })); if (r.url) { window.location.href = r.url; return new Promise(() => {}); } return r; }
  async getContentStatus() { return this.hr(await this.request(`${this.base}/content/status`, { headers: this.getHeaders(true) })); }
  async recoverContent() { return this.hr(await this.request(`${this.base}/content/recover`, { method: 'POST', headers: this.getHeaders() })); }
  async getAdminStats() { return this.hr(await this.request(`${this.base}/admin/stats`, { headers: this.getHeaders() })); }
  async runAdminCleanup() { return this.hr(await this.request(`${this.base}/admin/run-cleanup`, { method: 'POST', headers: this.getHeaders(true) })); }

  async *chat(req: { message: string; model: string; instanceId: string; chunkMode?: ChunkMode; forceChunk?: number; }): AsyncGenerator<any> {
    this.ac = new AbortController();
    try {
      const payload: any = { message: req.message, model: req.model, instanceId: req.instanceId, chunkMode: req.chunkMode || 'auto' };
      if (req.forceChunk !== undefined) payload.forceChunk = req.forceChunk;

      const r = await this.request(`${this.base}/chat`, { method: 'POST', headers: this.getHeaders(true), body: JSON.stringify(payload), signal: this.ac.signal });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'Stream error' }));
        const streamErr = new Error(err.error || `HTTP ${r.status}`) as Error & { code?: string };
        streamErr.code = err.code;
        throw streamErr;
      }

      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const json = await r.json();
        if (json.needs_chunk_selection) { yield { type: 'chunk_selection', data: json as ChunkSelectionPayload }; return; }
        throw new Error(json.error || 'Unexpected JSON from chat endpoint');
      }

      const reader = r.body?.getReader(); if (!reader) throw new Error('No body');
      const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); const lines = buf.split('\n'); buf = lines.pop() || '';
        for (const l of lines) {
          if (l.startsWith('data: ')) {
            const d = l.slice(6); if (d.trim() === '[DONE]') return;
            try {
              const p = JSON.parse(d);
              if (p.meta) yield { type: 'meta', data: p.meta };
              else if (p.reasoning !== undefined) yield { type: 'reasoning', data: p.reasoning };
              else if (p.token !== undefined) yield { type: 'token', data: p.token };
              else if (p.error) yield { type: 'error', data: p.error };
            } catch { yield { type: 'token', data: d }; }
          }
        }
      }
    } catch (e) { throw e; } finally { this.ac = null; }
  }
}
export const api = new APIService();

const STORAGE_KEY = 'cristol-web';
const defaultSettings: Settings = { model: '', chunkSelectionMode: 'auto', colorTheme: 'mono', appearance: 'dark', enablePerspective: true, hasSeenTutorial: false };

const getInitState = (): AppState => {
  let s = defaultSettings;
  try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) { const p = JSON.parse(saved); if (p.settings) s = { ...defaultSettings, ...p.settings }; } } catch { }
  const path = window.location.pathname;
  let view: any = 'home';
  let sharedId = null;
  if (path.startsWith('/share/')) { view = 'shared'; sharedId = path.split('/')[2]; }
  return { view, sharedId, authMode: 'login', token: null, userProfile: null, activePanel: 'instances', messages:[], currentInstance: null, isGenerating: false, streamingText: '', streamingReasoning: '', streamingMeta: null, settings: s, lore: '', profile: '', shows:[], instances:[], editingShow: undefined, availableModels:[], upgradePrompt: null, tierChangeNotification: null, billingPageOpen: false, tutorialOpen: false };
};

export type Action =
  | { type: 'SET_VIEW'; payload: AppState['view'] } | { type: 'SET_AUTH_MODE'; payload: AppState['authMode'] }
  | { type: 'SET_TOKEN'; payload: string | null } | { type: 'SET_USER_PROFILE'; payload: UserProfile | null }
  | { type: 'SET_SHOWS'; payload: Show[] } | { type: 'ADD_SHOW'; payload: Show } | { type: 'UPDATE_SHOW'; payload: Show } | { type: 'REMOVE_SHOW'; payload: string }
  | { type: 'SET_INSTANCES'; payload: Instance[] } | { type: 'ADD_INSTANCE'; payload: Instance } | { type: 'UPDATE_INSTANCE'; payload: Instance } | { type: 'REMOVE_INSTANCE'; payload: string } | { type: 'SET_CURRENT_INSTANCE'; payload: Instance | null }
  | { type: 'PATCH_CURRENT_INSTANCE'; payload: Partial<Instance> }
  | { type: 'ADD_MESSAGE'; payload: Message } | { type: 'UPDATE_MESSAGE'; payload: { id: string; content: string } } | { type: 'DELETE_MESSAGE'; payload: string } | { type: 'SET_MESSAGES'; payload: Message[] }
  | { type: 'SET_GENERATING'; payload: boolean } | { type: 'SET_STREAMING_TEXT'; payload: string } | { type: 'SET_STREAMING_REASONING'; payload: string } | { type: 'SET_STREAMING_META'; payload: AppState['streamingMeta'] }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<Settings> } | { type: 'SET_EDITING_SHOW'; payload: Show | null | undefined } | { type: 'SET_AVAILABLE_MODELS'; payload: ModelDef[] }
  | { type: 'SET_UPGRADE_PROMPT'; payload: any } | { type: 'SET_TIER_CHANGE_NOTIFICATION'; payload: TierChangeNotification | null } | { type: 'SET_BILLING_PAGE_OPEN'; payload: boolean } | { type: 'SET_TUTORIAL_OPEN'; payload: boolean };

export function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_VIEW': return { ...state, view: action.payload };
    case 'SET_AUTH_MODE': return { ...state, authMode: action.payload };
    case 'SET_TOKEN': return { ...state, token: action.payload };
    case 'SET_USER_PROFILE': return { ...state, userProfile: action.payload };
    case 'SET_SHOWS': return { ...state, shows: action.payload };
    case 'ADD_SHOW': return { ...state, shows: [...state.shows, action.payload] };
    case 'UPDATE_SHOW': return { ...state, shows: state.shows.map(s => s.id === action.payload.id ? action.payload : s) };
    case 'REMOVE_SHOW': return { ...state, shows: state.shows.filter(s => s.id !== action.payload) };
    case 'SET_INSTANCES': {
      const updatedCurrent = state.currentInstance
        ? action.payload.find(i => i.id === state.currentInstance?.id) || state.currentInstance
        : null;
      return {
        ...state,
        instances: action.payload,
        currentInstance: updatedCurrent,
        messages: updatedCurrent ? updatedCurrent.messages : state.messages
      };
    }
    case 'ADD_INSTANCE': return { ...state, instances:[action.payload, ...state.instances] };
    case 'UPDATE_INSTANCE': { const isCurrent = state.currentInstance?.id === action.payload.id; return { ...state, instances: state.instances.map(i => i.id === action.payload.id ? action.payload : i), currentInstance: isCurrent ? action.payload : state.currentInstance, lore: isCurrent ? action.payload.lore : state.lore, profile: isCurrent ? action.payload.profile : state.profile, messages: isCurrent ? action.payload.messages : state.messages }; }
    case 'REMOVE_INSTANCE': return { ...state, instances: state.instances.filter(i => i.id !== action.payload), currentInstance: state.currentInstance?.id === action.payload ? null : state.currentInstance };
    case 'SET_CURRENT_INSTANCE': return { ...state, currentInstance: action.payload, messages: action.payload ? action.payload.messages :[], lore: action.payload ? action.payload.lore : '', profile: action.payload ? action.payload.profile : '' };
    case 'PATCH_CURRENT_INSTANCE': {
      if (!state.currentInstance) return state;
      // SAFETY: Prevent patching the wrong instance if user switched chats during async sync
      if (action.payload.id && state.currentInstance.id !== action.payload.id) return state;
      
      const patch = { ...action.payload };
      delete (patch as any).messages;
      const patched = { ...state.currentInstance, ...patch };
      return {
        ...state,
        currentInstance: patched,
        instances: state.instances.map(i => i.id === patched.id ? { ...i, ...patch } : i),
        lore: patch.lore !== undefined ? patch.lore : state.lore,
        profile: patch.profile !== undefined ? patch.profile : state.profile,
      };
    }
    case 'ADD_MESSAGE': { const m =[...state.messages, action.payload]; return { ...state, messages: m, currentInstance: state.currentInstance ? { ...state.currentInstance, messages: m } : null, instances: state.instances.map(i => i.id === state.currentInstance?.id ? { ...i, messages: m } : i) }; }
    case 'UPDATE_MESSAGE': { const m = state.messages.map(x => x.id === action.payload.id ? { ...x, content: action.payload.content } : x); return { ...state, messages: m, currentInstance: state.currentInstance ? { ...state.currentInstance, messages: m } : null, instances: state.instances.map(i => i.id === state.currentInstance?.id ? { ...i, messages: m } : i) }; }
    case 'DELETE_MESSAGE': { const m = state.messages.filter(x => x.id !== action.payload); return { ...state, messages: m, currentInstance: state.currentInstance ? { ...state.currentInstance, messages: m } : null, instances: state.instances.map(i => i.id === state.currentInstance?.id ? { ...i, messages: m } : i) }; }
    case 'SET_MESSAGES': { return { ...state, messages: action.payload, currentInstance: state.currentInstance ? { ...state.currentInstance, messages: action.payload } : null, instances: state.instances.map(i => i.id === state.currentInstance?.id ? { ...i, messages: action.payload } : i) }; }
    case 'SET_GENERATING': return { ...state, isGenerating: action.payload };
    case 'SET_STREAMING_TEXT': return { ...state, streamingText: action.payload };
    case 'SET_STREAMING_REASONING': return { ...state, streamingReasoning: action.payload };
    case 'SET_STREAMING_META': return { ...state, streamingMeta: action.payload };
    case 'UPDATE_SETTINGS': {
      const ns = { ...state.settings, ...action.payload };
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: ns }));
      return { ...state, settings: ns };
    }
    case 'SET_EDITING_SHOW': return { ...state, editingShow: action.payload };
    case 'SET_AVAILABLE_MODELS': return { ...state, availableModels: action.payload };
    case 'SET_UPGRADE_PROMPT': return { ...state, upgradePrompt: action.payload };
    case 'SET_TIER_CHANGE_NOTIFICATION': return { ...state, tierChangeNotification: action.payload };
    case 'SET_BILLING_PAGE_OPEN': return { ...state, billingPageOpen: action.payload };
    case 'SET_TUTORIAL_OPEN': return { ...state, tutorialOpen: action.payload };
    default: return state;
  }
}

export const AppContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action>; } | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const[state, dispatch] = useReducer(appReducer, undefined, getInitState);
  const initRef = useRef<Set<string>>(new Set());
  useEffect(() => { const h = () => { dispatch({ type: 'SET_TOKEN', payload: null }); dispatch({ type: 'SET_USER_PROFILE', payload: null }); dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'login' }); }; window.addEventListener('auth-error', h); return () => window.removeEventListener('auth-error', h); },[]);
  useEffect(() => {
    let active = true;
    api.refreshSession(true).then(session => {
      if (!active || !session?.token) return;
      dispatch({ type: 'SET_TOKEN', payload: session.token });
      if (session.profile) dispatch({ type: 'SET_USER_PROFILE', payload: session.profile });
      const skippedPhone = sessionStorage.getItem('cristol_skipped_phone') === 'true';
      if ((session.next_step || session.profile?.next_step) === 'phone_verify' && !skippedPhone && !window.location.pathname.startsWith('/share/')) {
        dispatch({ type: 'SET_VIEW', payload: 'auth' });
        dispatch({ type: 'SET_AUTH_MODE', payload: 'phone' });
      } else if (!window.location.pathname.startsWith('/share/')) {
        dispatch({ type: 'SET_VIEW', payload: 'app' });
      }
    }).catch(() => {});
    return () => { active = false; };
  },[]);
  useEffect(() => {
    const initKey = `init:${state.token ?? 'none'}`;
    if (state.token && !initRef.current.has(initKey)) {
      initRef.current.add(initKey);
      Promise.allSettled([
        api.getMe(),
        api.getEnvSettings(),
        api.getShows(),
        api.getInstances(),
        api.getModels()
      ]).then(([userR, envR, showsR, instancesR, modelsR]) => {
        if (userR.status === 'fulfilled') {
          dispatch({ type: 'SET_USER_PROFILE', payload: userR.value });
          const skippedPhone = sessionStorage.getItem('cristol_skipped_phone') === 'true';
          if (userR.value.next_step === 'phone_verify' && !skippedPhone && state.view !== 'shared') {
            dispatch({ type: 'SET_VIEW', payload: 'auth' });
            dispatch({ type: 'SET_AUTH_MODE', payload: 'phone' });
          } else if (state.view !== 'shared') {
            dispatch({ type: 'SET_VIEW', payload: 'app' });
          }
        }
        if (envR.status === 'fulfilled') { const env = envR.value; const p: Partial<Settings> = {}; if (env.model) p.model = env.model; if (env.chunkSelectionMode) p.chunkSelectionMode = env.chunkSelectionMode; if (Object.keys(p).length > 0) dispatch({ type: 'UPDATE_SETTINGS', payload: p }); }
        if (showsR.status === 'fulfilled' && state.view !== 'shared') dispatch({ type: 'SET_SHOWS', payload: showsR.value });
        if (instancesR.status === 'fulfilled' && state.view !== 'shared') dispatch({ type: 'SET_INSTANCES', payload: instancesR.value });
        if (modelsR.status === 'fulfilled') dispatch({ type: 'SET_AVAILABLE_MODELS', payload: modelsR.value });
      });
    }
  },[state.token, state.view]);
  return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp() { const c = useContext(AppContext); if (!c) throw new Error('useApp must be within AppProvider'); return c; }

function useKeyboardShortcuts() {
  const { state, dispatch } = useApp();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName; const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) { switch (e.key.toLowerCase()) { case 's': e.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-settings')); return; case 'p': e.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-profile')); return; case 'n': e.preventDefault(); dispatch({ type: 'SET_EDITING_SHOW', payload: null }); return; } }
      if (e.key === 'Escape') { window.dispatchEvent(new CustomEvent('close-modal')); return; }
      if (isInput) return;
      if (e.ctrlKey || e.metaKey) { switch (e.key.toLowerCase()) { case 'e': e.preventDefault(); window.dispatchEvent(new CustomEvent('toggle-finish-episode')); return; } }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [state, dispatch]);
}

export function ConfirmModal({ isOpen, title, message, onConfirm, onCancel, confirmText = "CONFIRM", cancelText = "CANCEL", isDanger = false }: { isOpen: boolean; title: string; message: string; onConfirm: () => void; onCancel: () => void; confirmText?: string; cancelText?: string; isDanger?: boolean; }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onCancel} />
      <div className="relative w-full max-w-sm bezel-frame p-6 space-y-5 animate-fade-in-scale para-corner-tl para-corner-br">
        <div className="flex items-center justify-between"><div className={cn("para-badge", isDanger ? "para-badge-danger" : "para-badge-glow")}><span>{title}</span></div><CloseButton onClick={onCancel} /></div>
        <ParaDivider />
        <div className="text-center py-4 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{message}</div>
        <div className="flex gap-2"><button onClick={() => { onConfirm(); onCancel(); }} className={cn("para-btn flex-1 py-3", isDanger ? "para-btn-danger" : "para-btn-primary")}><span>{confirmText}</span></button><button onClick={onCancel} className="para-btn py-3"><span>{cancelText}</span></button></div>
      </div>
    </div>
  );
}

export function ChunkPickerPanel({
  isOpen,
  payload,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  payload: ChunkSelectionPayload | null;
  onConfirm: (chunkIndex: number) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<number>(0);
  const itemRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (isOpen && payload) {
      setSelected(payload.current_chunk);
      setTimeout(() => {
        itemRefs.current[payload.current_chunk]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 10);
    }
  },[isOpen, payload]);

  if (!isOpen || !payload) return null;

  const totalChunks = payload.summaries.length;

  return (
    <div className="absolute inset-0 z-[160] flex" style={{ pointerEvents: 'all' }}>
      <div
        className="flex-1"
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        onClick={onCancel}
      />
      <div
        className="flex flex-col overflow-hidden animate-slide-in-right"
        style={{
          width: 'min(520px, 55vw)',
          minWidth: 320,
          background: 'var(--surface-2)',
          borderLeft: '2px solid rgba(0,0,0,0.6)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.6)',
        }}
      >
        <div className="bezel-toolbar px-4 py-3 flex items-center justify-between shrink-0 para-header" style={{ borderBottom: '1px solid rgba(0,0,0,0.5)' }}>
          <div className="flex items-center gap-2">
            <div className="bezel-led animate-led-pulse" />
            <h2 className="text-xs font-bold tracking-widest text-emboss uppercase">WHERE TO START?</h2>
            <div className="para-badge ml-1"><span>{totalChunks} CHUNK{totalChunks !== 1 ? 'S' : ''}</span></div>
          </div>
          <CloseButton onClick={onCancel} large />
        </div>

        <div className="px-4 py-2 shrink-0" style={{ background: 'var(--surface-1)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}>
          <div className="text-[9px] tracking-widest font-bold uppercase" style={{ color: 'var(--text-dim)' }}>{payload.episode_name}</div>
          <div className="text-[9px] mt-0.5" style={{ color: 'var(--accent)' }}>
            Current location: chunk {payload.current_chunk + 1} of {totalChunks} — confirm or pick another
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
          {payload.summaries.map((item) => {
            const isSelected = item.index === selected;
            const isCurrentLoc = item.index === payload.current_chunk;
            return (
              <button
                key={item.index}
                ref={(el) => { itemRefs.current[item.index] = el; }}
                onClick={() => setSelected(item.index)}
                className={cn(
                  'w-full text-left transition-all relative',
                  isSelected ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]',
                  item.played && !isSelected && 'opacity-60'
                )}
                style={{
                  borderBottom: '1px solid rgba(0,0,0,0.3)',
                  borderLeft: isSelected ? '3px solid var(--accent)' : '3px solid transparent',
                }}
              >
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-bold" style={{ color: isSelected ? 'var(--accent)' : 'var(--text-dim)' }}>
                      {String(item.index + 1).padStart(2, '0')}
                    </span>
                    {item.played && <span className="text-[8px] font-bold" style={{ color: '#22c55e' }}>DONE</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isCurrentLoc && (
                      <div className="para-badge" style={{ borderColor: 'var(--accent)', color: 'var(--accent)', fontSize: '7px' }}><span>CURRENT</span></div>
                    )}
                    {isSelected && !isCurrentLoc && (
                      <div className="para-badge-glow para-badge" style={{ fontSize: '7px' }}><span>SELECTED</span></div>
                    )}
                  </div>
                </div>

                <div className="px-4 pb-3">
                  <pre
                    className="text-[11px] leading-relaxed whitespace-pre-wrap break-words"
                    style={{
                      fontFamily: 'var(--font-story, sans-serif)',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {item.full_text || item.summary}
                  </pre>
                </div>
              </button>
            );
          })}
        </div>

        <div className="bezel-statusbar px-4 py-3 flex items-center justify-between gap-3 shrink-0" style={{ borderTop: '2px solid rgba(0,0,0,0.5)' }}>
          <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>
            Starting at chunk {selected + 1} of {totalChunks}
          </div>
          <div className="flex gap-2">
            <button onClick={onCancel} className="para-btn py-2"><span>CANCEL</span></button>
            <button onClick={() => onConfirm(selected)} className="para-btn para-btn-primary py-2 px-6"><span>START HERE ▶</span></button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChunkNavigatorPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
  const { state, dispatch } = useApp();
  const [chunkData, setChunkData] = useState<ChunkData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (isOpen && state.currentInstance) {
      setLoading(true); setError(null);
      api.getInstanceChunks(state.currentInstance.id)
        .then((data) => {
          setChunkData(data);
          setTimeout(() => {
            const cur = data.currentChunkId ?? 0;
            itemRefs.current[cur]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }, 10);
        })
        .catch(e => setError(e.message))
        .finally(() => setLoading(false));
    }
  },[isOpen, state.currentInstance?.id]);

  if (!isOpen) return null;

  const handleSelect = async (chunkId: number) => {
    if (!state.currentInstance || selecting !== null || state.settings.chunkSelectionMode !== 'manual') return;
    setSelecting(chunkId);
    try {
      await api.selectChunk(state.currentInstance.id, chunkId);
      const updated = { ...state.currentInstance, current_chunk_id: chunkId } as Instance;
      dispatch({ type: 'UPDATE_INSTANCE', payload: updated });
      dispatch({ type: 'SET_CURRENT_INSTANCE', payload: updated });
      if (chunkData) setChunkData({ ...chunkData, currentChunkId: chunkId });
    } catch (e: any) { setError(e.message); } finally { setSelecting(null); }
  };

  const currentChunkId = chunkData?.currentChunkId ?? state.currentInstance?.current_chunk_id ?? 0;
  const isManual = state.settings.chunkSelectionMode === 'manual';
  const totalChunks = chunkData?.totalChunks ?? 0;

  return (
    <div className="absolute inset-0 z-[150] flex" style={{ pointerEvents: 'all' }}>
      <div
        className="flex-1"
        style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
        onClick={onClose}
      />
      <div
        className="flex flex-col overflow-hidden animate-slide-in-right"
        style={{
          width: 'min(520px, 55vw)',
          minWidth: 320,
          background: 'var(--surface-2)',
          borderLeft: '2px solid rgba(0,0,0,0.6)',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.6)',
        }}
      >
        <div className="bezel-toolbar px-4 py-3 flex items-center justify-between shrink-0 para-header">
          <div className="flex items-center gap-2">
            <div className="bezel-led animate-led-pulse" />
            <h2 className="text-xs font-bold tracking-widest text-emboss uppercase">CHUNK NAVIGATOR</h2>
            {chunkData && <div className="para-badge ml-1"><span>{totalChunks} CHUNK{totalChunks !== 1 ? 'S' : ''}</span></div>}
            <ChunkModeBadge mode={state.settings.chunkSelectionMode} />
          </div>
          <CloseButton onClick={onClose} large />
        </div>

        <div className="px-4 py-2 shrink-0" style={{ background: 'var(--surface-1)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}>
          <div className="text-[9px] tracking-widest font-bold uppercase" style={{ color: 'var(--text-dim)' }}>
            {chunkData ? `Episode: ${chunkData.episodeName} · On chunk ${currentChunkId + 1} of ${totalChunks}` : 'Loading...'}
          </div>
          {!isManual && (
            <div className="text-[9px] mt-1" style={{ color: '#f59e0b' }}>
              ⚠ Switch to MANUAL mode in Settings → AI Engine to pin chunks.
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
          {loading && (
            <div className="flex items-center justify-center h-32">
              <div className="text-[10px] tracking-widest blink" style={{ color: 'var(--accent)' }}>LOADING CHUNKS...</div>
            </div>
          )}
          {error && <div className="text-[11px] font-bold text-center py-8" style={{ color: '#ef4444' }}>⚠ {error}</div>}
          {chunkData && !loading && chunkData.chunks.map((chunk, i) => {
            const isCurrent = i === currentChunkId;
            const isPlayed = chunkData.playedSegments.includes(i);
            const isSelecting = selecting === i;
            return (
              <button
                key={i}
                ref={(el) => { itemRefs.current[i] = el; }}
                onClick={() => handleSelect(i)}
                disabled={selecting !== null || !isManual}
                className={cn(
                  'w-full text-left transition-all relative',
                  isCurrent ? 'bg-[var(--surface-3)]' : isManual ? 'hover:bg-[var(--surface-2)] cursor-pointer' : 'cursor-default',
                  isPlayed && !isCurrent && 'opacity-60'
                )}
                style={{
                  borderBottom: '1px solid rgba(0,0,0,0.3)',
                  borderLeft: isCurrent ? '3px solid var(--accent)' : '3px solid transparent',
                }}
              >
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px] font-bold" style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-dim)' }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {isPlayed && <span className="text-[8px] font-bold" style={{ color: '#22c55e' }}>DONE</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isSelecting && <span className="text-[9px] animate-pulse" style={{ color: 'var(--accent)' }}>SETTING...</span>}
                    {isCurrent && !isSelecting && <div className="para-badge-glow para-badge"><span>CURRENT</span></div>}
                    {isManual && !isCurrent && !isSelecting && (
                      <span className="text-[8px] opacity-50" style={{ color: 'var(--accent)' }}>CLICK TO SELECT</span>
                    )}
                    <span className="text-[8px] font-mono" style={{ color: 'var(--text-dim)' }}>
                      {chunk.length.toLocaleString()} chars
                    </span>
                  </div>
                </div>

                <div className="px-4 pb-3">
                  <pre
                    className="text-[11px] leading-relaxed whitespace-pre-wrap break-words"
                    style={{
                      fontFamily: 'var(--font-story, sans-serif)',
                      color: isCurrent ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {chunk.full_text || chunk.preview}
                  </pre>
                </div>
              </button>
            );
          })}
        </div>

        <div className="bezel-statusbar px-4 py-3 flex items-center justify-between shrink-0" style={{ borderTop: '2px solid rgba(0,0,0,0.5)' }}>
          <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>
            {chunkData && `${chunkData.playedSegments.length} / ${totalChunks} chunks visited`}
          </div>
          <button onClick={onClose} className="para-btn"><span>CLOSE</span></button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (<div className="bezel-well p-4 flex flex-col justify-between" style={color ? { borderTopColor: color } : {}}><div className="text-[10px] tracking-widest text-engrave mb-2 uppercase" style={color ? { color } : {}}>{label}</div><div className="text-2xl font-bold truncate" style={{ color: color || 'var(--text-primary)' }}>{value}</div></div>);
}
function SimpleBarChart({ data, title, color }: { data: { date: string, count: number }[], title: string, color: string }) {
  const max = Math.max(...data.map(d => d.count), 1);
  return (<div className="bezel-well p-4 flex flex-col h-48"><div className="text-[10px] tracking-widest text-engrave mb-4 uppercase">{title}</div><div className="flex-1 flex items-end gap-2">{data.map((d, i) => (<div key={i} className="flex-1 flex flex-col items-center gap-1 group relative h-full justify-end"><div className="absolute -top-6 opacity-0 group-hover:opacity-100 text-[10px] bg-[var(--surface-3)] px-1.5 py-0.5 rounded transition-opacity whitespace-nowrap z-10" style={{ color: 'var(--text-primary)' }}>{d.count}</div><div className="w-full rounded-t-sm transition-all duration-300 hover:brightness-125" style={{ height: `${Math.max((d.count / max) * 100, 2)}%`, backgroundColor: color }} /><div className="text-[8px] text-[var(--text-muted)] rotate-45 origin-left truncate w-8 mt-1">{d.date.slice(5)}</div></div>))}</div></div>);
}

export function AdminDashboardModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
  const[stats, setStats] = useState<any>(null); const [loading, setLoading] = useState(false); const[results, setResults] = useState<any>(null);
  useEffect(() => { if (isOpen) { api.getAdminStats().then(setStats).catch(console.error); setResults(null); } },[isOpen]);
  if (!isOpen) return null;
  const handleCleanup = async () => { setLoading(true); try { const res = await api.runAdminCleanup(); setResults(res.results); api.getAdminStats().then(setStats).catch(console.error); } catch (err: any) {  } finally { setLoading(false); } };
  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-6xl bezel-frame animate-fade-in-scale max-h-[90vh] flex flex-col">
        <div className="bezel-toolbar flex items-center justify-between px-5 py-3 para-header shrink-0"><div className="flex items-center gap-2"><div className="bezel-led animate-led-pulse" /><h2 className="text-sm font-bold tracking-widest text-emboss uppercase" style={{ color: '#ef4444' }}>ADMIN DASHBOARD</h2>{stats && <div className="para-badge ml-2" style={{ borderColor: '#ef4444', color: '#ef4444' }}><span>LIVE ANALYTICS</span></div>}</div><CloseButton onClick={onClose} large /></div>
        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
          {!stats ? (<div className="flex items-center justify-center h-48"><div className="text-[10px] tracking-widest blink text-emboss">GATHERING TELEMETRY...</div></div>) : (
            <div className="space-y-4 animate-fade-in">
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
                <StatCard label="TOTAL USERS" value={stats.users} /><StatCard label="DAU / MAU" value={`${stats.dau} / ${stats.mau}`} color="#06b6d4" /><StatCard label="UPGRADE RATE" value={`${stats.upgrade_percentage}%`} color="#a855f7" /><StatCard label="ESTIMATED MRR" value={`$${stats.mrr}`} color="#22c55e" /><StatCard label="CHURN (30d)" value={`${stats.downgrades_30d} drops`} color="#f59e0b" /><StatCard label="TOTAL SHOWS" value={stats.shows} /><StatCard label="TOTAL SAVES" value={stats.instances} /><StatCard label="TOTAL AI CHATS" value={stats.total_chats} /><StatCard label="UPGRADES (30d)" value={stats.upgrades_30d} color="#22c55e" /><StatCard label="AVG CREDITS/USER" value={stats.avg_credits} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4"><SimpleBarChart data={stats.signups_7d} title="New Signups (Last 7 Days)" color="#06b6d4" /><SimpleBarChart data={stats.credits_used_7d} title="Credits Burned (Last 7 Days)" color="#a855f7" /></div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
                <div className="bezel-well p-4 lg:col-span-2"><div className="text-[10px] tracking-widest text-engrave mb-4 uppercase">TIER DISTRIBUTION</div><div className="space-y-3">{['Free', 'Basic', 'Plus', 'Pro'].map((tier) => { const count = stats.tier_distribution[tier] || 0; const percentage = stats.users > 0 ? (count / stats.users) * 100 : 0; return (<div key={tier} className="flex items-center justify-between text-[11px]"><div className="w-16"><TierBadge tier={tier} /></div><div className="flex-1 mx-4 h-1.5 bg-[var(--surface-3)] overflow-hidden border border-[var(--border-color)]"><div className="h-full transition-all duration-500" style={{ width: `${percentage}%`, backgroundColor: tier === 'Free' ? '#888' : tier === 'Pro' ? '#f59e0b' : 'var(--accent)' }} /></div><span className="w-12 text-right font-mono" style={{ color: 'var(--text-primary)' }}>{count} ({percentage.toFixed(0)}%)</span></div>); })}</div></div>
                <div className="bezel-raised p-4 space-y-4 flex flex-col justify-between" style={{ borderColor: 'rgba(239, 68, 68, 0.3)' }}>
                  <div><div className="flex items-center justify-between mb-2"><div className="text-[11px] font-bold tracking-wider uppercase" style={{ color: '#ef4444' }}>CONTENT RETENTION SWEEP</div><div className="para-badge-danger para-badge"><span>{stats.pending_cleanup} READY</span></div></div><div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Permanently deletes inactive content for users whose pending deletion timer has expired.</div></div>
                  <button onClick={handleCleanup} disabled={loading} className="para-btn para-btn-danger w-full py-3"><span>{loading ? 'RUNNING SWEEP...' : 'EXECUTE CLEANUP NOW'}</span></button>
                  {results && (<div className="p-3 text-[10px] font-mono rounded bezel-well" style={{ color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)' }}>Sweep complete. Processed {results.users_processed} users.<br />Warning emails sent: {results.warnings_sent}.<br />Deleted {results.shows_deleted} shows, {results.instances_deleted} saves.</div>)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TierChangeNotificationPanel() {
  const { state, dispatch } = useApp(); const notification = state.tierChangeNotification; if (!notification) return null;
  const isUpgrade = notification.type === 'upgrade'; const hasArchived = notification.archivedInstances && notification.archivedInstances.length > 0; const hasTrial = notification.isTrialActivated;
  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center" style={{ background: 'var(--surface-1)' }}>
      <div className="w-full max-w-lg bezel-frame p-8 animate-fade-in-scale">
        <div className="text-center mb-6"><div className="text-5xl mb-4" style={{ color: isUpgrade ? '#22c55e' : '#f59e0b' }}>{isUpgrade ? '⬆' : '⬇'}</div><h2 className="text-xl font-bold tracking-wider text-emboss mb-2" style={{ color: 'var(--text-primary)' }}>{isUpgrade ? 'UPGRADE COMPLETE' : 'PLAN CHANGED'}</h2><div className="flex items-center justify-center gap-3"><TierBadge tier={notification.fromTier} /><span style={{ color: 'var(--text-dim)' }}>→</span><TierBadge tier={notification.toTier} /></div></div>
        <ParaDivider />
        {hasTrial && (<div className="my-6 p-4 bezel-well" style={{ background: 'rgba(168, 85, 247, 0.1)', border: '1px solid rgba(168, 85, 247, 0.3)' }}><div className="flex items-center gap-2 mb-3"><span className="text-xl"></span><span className="text-sm font-bold" style={{ color: '#a855f7' }}>PLUS TRIAL ACTIVATED</span></div><div className="text-[12px] space-y-2" style={{ color: 'var(--text-secondary)' }}><p>For the next <strong style={{ color: '#a855f7' }}>{notification.trialDaysRemaining} active days</strong>, you'll experience Plus features.</p><p className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>After the trial, these features will revert to Basic tier limits.</p></div></div>)}
        {hasArchived && (<div className="my-6 p-4 bezel-well" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)' }}><div className="flex items-center gap-2 mb-3"><span className="text-xl">⚠</span><span className="text-sm font-bold" style={{ color: '#f59e0b' }}>INSTANCES ARCHIVED</span></div><div className="text-[11px] mb-3" style={{ color: 'var(--text-secondary)' }}>{notification.message}</div><div className="space-y-1">{notification.archivedInstances!.map(inst => (<div key={inst.id} className="text-[10px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}><span style={{ color: '#f59e0b' }}>•</span><span>"{inst.name}" — now read-only</span></div>))}</div></div>)}
        {!hasArchived && !hasTrial && (<div className="my-6 text-center"><div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Your subscription has been updated successfully.</div></div>)}
        <div className="mt-6"><button onClick={() => dispatch({ type: 'SET_TIER_CHANGE_NOTIFICATION', payload: null })} className="para-btn para-btn-primary w-full py-3"><span>CONTINUE</span></button></div>
      </div>
    </div>
  );
}

export function ShareModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
  const { state, dispatch } = useApp(); const[sharing, setSharing] = useState<'private' | 'read_only' | 'full'>('private'); const[loading, setLoading] = useState(false);
  useEffect(() => { if (isOpen && state.currentInstance) setSharing(state.currentInstance.sharing || 'private'); }, [isOpen, state.currentInstance]);
  if (!isOpen || !state.currentInstance) return null;
  const handleSave = async () => {
    setLoading(true);
    try { await api.updateSharing(state.currentInstance!.id, sharing); const updated = { ...state.currentInstance, sharing } as Instance; dispatch({ type: 'UPDATE_INSTANCE', payload: updated }); dispatch({ type: 'SET_CURRENT_INSTANCE', payload: updated }); onClose(); }
    catch (err: any) { if (err.message?.includes('Plus tier') || err.message?.includes('tier')) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'UPGRADE REQUIRED', message: err.message } }); setSharing('private'); } } finally { setLoading(false); }
  };
  const link = `${window.location.origin}/share/${state.currentInstance.id}`;
  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-sm bezel-frame p-6 animate-fade-in-scale space-y-5">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><div className="bezel-led animate-led-pulse" /><h2 className="text-sm font-bold tracking-widest text-emboss uppercase">SHARE INSTANCE</h2></div><CloseButton onClick={onClose} /></div>
        <ParaDivider />
        <div className="space-y-3">
          <label className="flex items-center gap-3 p-3 bezel-well cursor-pointer hover:border-[var(--accent)] transition-colors"><input type="radio" name="sharing" checked={sharing === 'private'} onChange={() => setSharing('private')} /><div><div className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Private</div><div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>Only you can access this.</div></div></label>
          <label className="flex items-center gap-3 p-3 bezel-well cursor-pointer hover:border-[var(--accent)] transition-colors"><input type="radio" name="sharing" checked={sharing === 'read_only'} onChange={() => setSharing('read_only')} /><div><div className="text-[11px] font-bold" style={{ color: 'var(--text-primary)' }}>Read-Only Link</div><div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>Anyone with the link can read or embed.</div></div></label>
          <label className="flex items-center gap-3 p-3 bezel-well cursor-pointer hover:border-[var(--accent)] transition-colors"><input type="radio" name="sharing" checked={sharing === 'full'} onChange={() => setSharing('full')} /><div><div className="text-[11px] font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>Full Collaboration <TierBadge tier="Plus" trial={state.userProfile?.is_in_plus_trial} /></div><div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>Anyone with the link can chat.</div></div></label>
        </div>
        {sharing !== 'private' && (<div className="mt-4 space-y-2 animate-fade-in"><div className="text-[9px] font-bold tracking-widest text-engrave uppercase" style={{ color: 'var(--text-dim)' }}>SHARE LINK</div><div className="flex gap-2"><input readOnly value={link} className="input-field flex-1 text-[10px] font-mono" /><button onClick={(e) => { navigator.clipboard.writeText(link); e.currentTarget.innerText = 'COPIED!'; }} className="para-btn para-btn-sm">COPY</button></div></div>)}
        <div className="flex gap-2 mt-4"><button onClick={handleSave} disabled={loading} className="para-btn para-btn-primary flex-1 py-3"><span>{loading ? 'SAVING...' : 'SAVE'}</span></button><button onClick={onClose} className="para-btn flex-1 py-3"><span>CANCEL</span></button></div>
      </div>
    </div>
  );
}

export function SubscriptionModal({ isOpen, onClose, initialTab = 'plans' }: { isOpen: boolean; onClose: () => void; initialTab?: 'plans' | 'credits'; }) {
  const { state, dispatch } = useApp(); const [loading, setLoading] = useState(false); const[selectedTier, setSelectedTier] = useState<string | null>(null); const [billingCycle] = useState<'monthly' | 'annual'>('monthly'); const [error, setError] = useState<string | null>(null); const[purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null); const [tab, setTab] = useState<'plans' | 'credits'>('plans');
  const currentTier = state.userProfile?.subscription_tier || 'Free'; const isInTrial = state.userProfile?.is_in_plus_trial; const trialDaysLeft = state.userProfile?.plus_trial_days_remaining || 0; const isPaid = currentTier !== 'Free';
  const tiers =[
    { name: 'Free', price_monthly: 0, price_annual: 0, credits: 75, instances: 1, episodes: 3, retention: '30 days', features:['Manual summaries', 'Read-only sharing', '30-day retention'] },
    { name: 'Basic', price_monthly: 7.99, price_annual: 79.99, credits: 200, instances: 2, episodes: 5, retention: '6 months', features:['3-day Plus trial included', 'Read-only sharing', '6-month retention'] },
    { name: 'Plus', price_monthly: 19.99, price_annual: 199.99, credits: 600, instances: 5, episodes: 15, retention: '1 year', features:['Auto summaries', 'Full collaboration sharing', '1-year retention'] },
    { name: 'Pro', price_monthly: 34.99, price_annual: 349.99, credits: 1200, instances: 20, episodes: 45, retention: 'Infinite', features:['All Plus features', 'Instance branches', 'Priority processing', 'Bulk import', 'Infinite retention'] }
  ];
  const creditPacks =[{ id: 'small', name: 'Small Pack', credits: 150, price: 3.99 }, { id: 'medium', name: 'Medium Pack', credits: 400, price: 9.99 }, { id: 'large', name: 'Large Pack', credits: 900, price: 19.99 }];
  const tierOrder =['Free', 'Basic', 'Plus', 'Pro']; const currentIndex = tierOrder.indexOf(currentTier);
  useEffect(() => { const h = () => { if (isOpen) onClose(); }; window.addEventListener('close-modal', h); return () => window.removeEventListener('close-modal', h); }, [isOpen, onClose]);
  useEffect(() => { if (isOpen) { setError(null); setPurchaseSuccess(null); setTab(initialTab); } }, [isOpen, initialTab]);
  if (!isOpen) return null;
  const handleTierChange = async (tierName: string) => {
    const fromTier = currentTier; const toIndex = tierOrder.indexOf(tierName); const isDowngrade = toIndex < currentIndex;
    setLoading(true); setSelectedTier(tierName); setError(null);
    try {
      const updatedProfile = await api.updateSubscriptionTier(tierName, billingCycle); if (!updatedProfile) return;
      dispatch({ type: 'SET_USER_PROFILE', payload: updatedProfile });
      try { const instances = await api.getInstances(); dispatch({ type: 'SET_INSTANCES', payload: instances }); } catch {}
      const notification: TierChangeNotification = { type: isDowngrade ? 'downgrade' : 'upgrade', fromTier, toTier: tierName, message: updatedProfile.downgrade_message, archivedInstances: updatedProfile.archived_instances, isTrialActivated: tierName === 'Basic' && updatedProfile.is_in_plus_trial, trialDaysRemaining: updatedProfile.plus_trial_days_remaining };
      onClose(); dispatch({ type: 'SET_TIER_CHANGE_NOTIFICATION', payload: notification });
    } catch (err: any) { setError(err.message || 'Failed to change tier'); } finally { setLoading(false); setSelectedTier(null); }
  };
  const handleBuyCreditPack = async (packId: string) => {
    setLoading(true); setPurchaseSuccess(null); setError(null);
    try { const result = await api.purchaseCreditPack(packId); if (!result) return; if (result.success) { const profile = await api.getMe(); dispatch({ type: 'SET_USER_PROFILE', payload: profile }); setPurchaseSuccess(`Added ${result.credits_added} credits!`); setTimeout(() => setPurchaseSuccess(null), 3000); } } catch (err: any) { setError(err.message || 'Purchase failed'); } finally { setLoading(false); }
  };
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-4xl bezel-frame animate-fade-in-scale overflow-hidden max-h-[90vh] flex flex-col">
        <div className="bezel-toolbar flex items-center justify-between px-5 py-3 para-header shrink-0"><div className="flex items-center gap-3 relative z-10"><div className="bezel-led animate-led-pulse" /><h2 className="text-sm font-bold tracking-wider text-emboss" style={{ color: 'var(--text-primary)' }}>STORE</h2><TierBadge tier={currentTier} trial={isInTrial} />{isInTrial && (<div className="text-[10px] font-bold ml-2" style={{ color: 'var(--accent)' }}>({trialDaysLeft} DAYS REMAINING)</div>)}</div><CloseButton onClick={onClose} large /></div>
        <div className="flex px-4 py-2 gap-1" style={{ background: 'var(--surface-2)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}><button onClick={() => setTab('plans')} className={cn("para-tab flex-1", tab === 'plans' && "para-tab-active")}><span>SUBSCRIPTIONS</span></button><button onClick={() => setTab('credits')} className={cn("para-tab flex-1", tab === 'credits' && "para-tab-active")}><span>CREDIT PACKS</span></button></div>
        {error && (<div className="px-5 py-3" style={{ background: 'rgba(239, 68, 68, 0.1)', borderBottom: '1px solid rgba(239, 68, 68, 0.3)' }}><div className="text-[11px] font-bold" style={{ color: '#ef4444' }}>⚠ {error}</div></div>)}
        <div className="flex-1 overflow-y-auto p-5 custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
          {tab === 'plans' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
              {tiers.map((tier, idx) => {
                const isCurrentTier = tier.name === currentTier; const isDowngrade = idx < currentIndex; const isRecommended = tier.name === 'Plus'; const perMonth = billingCycle === 'annual' ? (tier.price_annual / 12).toFixed(2) : tier.price_monthly;
                return (
                  <div key={tier.name} className={cn("bezel-well p-4 flex flex-col relative", isCurrentTier && "!border-[var(--accent)]", isRecommended && !isCurrentTier && "!border-green-500")}>
                    {isCurrentTier && (<div className="absolute -top-2 left-1/2 -translate-x-1/2"><div className="para-badge-glow para-badge"><span>CURRENT</span></div></div>)}
                    {isRecommended && !isCurrentTier && (<div className="absolute -top-2 left-1/2 -translate-x-1/2"><div className="para-badge" style={{ background: '#22c55e', color: '#000' }}><span>RECOMMENDED</span></div></div>)}
                    <div className="text-center mb-4 pt-2"><TierBadge tier={tier.name} /><div className="mt-3"><span className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>${perMonth}</span><span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>/mo</span></div></div>
                    <ParaDivider />
                    <div className="space-y-2 flex-1 my-3">
                      <div className="flex justify-between text-[10px]"><span style={{ color: 'var(--text-muted)' }}>Credits/month</span><span className="font-bold" style={{ color: 'var(--accent)' }}>{tier.credits.toLocaleString()}</span></div>
                      <div className="flex justify-between text-[10px]"><span style={{ color: 'var(--text-muted)' }}>Max Saves</span><span className="font-bold" style={{ color: 'var(--text-primary)' }}>{tier.instances}</span></div>
                      <div className="flex justify-between text-[10px]"><span style={{ color: 'var(--text-muted)' }}>Max Episodes</span><span className="font-bold" style={{ color: 'var(--text-primary)' }}>{tier.episodes}</span></div>
                      <div className="flex justify-between text-[10px]"><span style={{ color: 'var(--text-muted)' }}>Retention</span><span className="font-bold" style={{ color: tier.retention === 'Infinite' ? '#f59e0b' : 'var(--text-primary)' }}>{tier.retention}</span></div>
                      <div className="pt-2 space-y-1">{tier.features.map((f, i) => (<div key={i} className="text-[9px] flex items-start gap-1.5"><span style={{ color: 'var(--accent)' }}>✓</span><span style={{ color: 'var(--text-secondary)' }}>{f}</span></div>))}</div>
                    </div>
                    <div className="mt-auto pt-3">
                      {isCurrentTier ? (<button disabled className="para-btn w-full py-2 opacity-50"><span>CURRENT PLAN</span></button>)
                        : isDowngrade ? (<button className="para-btn para-btn-danger w-full py-2" onClick={() => handleTierChange(tier.name)} disabled={loading}><span>{loading && selectedTier === tier.name ? 'PROCESSING...' : 'DOWNGRADE'}</span></button>)
                          : (<button className={cn("para-btn w-full py-2 para-btn-primary", loading && selectedTier === tier.name && "opacity-50")} style={isRecommended ? { background: '#22c55e', borderColor: '#22c55e' } : {}} onClick={() => handleTierChange(tier.name)} disabled={loading}><span>{loading && selectedTier === tier.name ? 'PROCESSING...' : 'UPGRADE'}</span></button>)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {tab === 'credits' && (
            <div className="animate-fade-in max-w-4xl mx-auto">
              {purchaseSuccess && (<div className="mb-6 p-4 text-center rounded bezel-raised" style={{ background: 'rgba(34, 197, 94, 0.1)', borderColor: 'rgba(34, 197, 94, 0.3)' }}><span className="text-sm font-bold" style={{ color: '#22c55e' }}>✓ {purchaseSuccess}</span></div>)}
              {!isPaid ? (<div className="text-center p-10 bezel-raised opacity-60"><div className="text-4xl mb-4"></div><div className="text-sm font-bold tracking-widest text-engrave mb-4" style={{ color: 'var(--text-muted)' }}>UPGRADE TO A PAID PLAN TO PURCHASE CREDIT PACKS</div><button onClick={() => setTab('plans')} className="para-btn para-btn-primary"><span>VIEW PLANS</span></button></div>)
                : (<div className="grid grid-cols-1 md:grid-cols-3 gap-6">{creditPacks.map(pack => (<div key={pack.id} className="bezel-well p-6 text-center flex flex-col justify-between"><div><div className="text-sm font-bold mb-2 tracking-widest text-emboss" style={{ color: 'var(--text-primary)' }}>{pack.name.toUpperCase()}</div><ParaDivider /><div className="text-4xl font-bold my-4" style={{ color: 'var(--accent)' }}>{pack.credits} <span className="text-sm" style={{ color: 'var(--text-dim)' }}>CR</span></div><div className="text-lg font-bold mb-1" style={{ color: 'var(--text-primary)' }}>${pack.price.toFixed(2)}</div></div><button onClick={() => handleBuyCreditPack(pack.id)} className="para-btn para-btn-primary w-full py-3" disabled={loading}><span>{loading ? 'PROCESSING...' : 'BUY NOW'}</span></button></div>))}</div>)}
            </div>
          )}
        </div>
        <div className="bezel-statusbar px-5 py-3 flex items-center justify-between shrink-0">
          <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>{isInTrial && `Plus trial: ${trialDaysLeft} active day(s) remaining`}</div>
          <button onClick={onClose} className="para-btn"><span>CLOSE</span></button>
        </div>
      </div>
    </div>
  );
}

export function UpgradePromptModal() {
  const { state, dispatch } = useApp(); const[showSubscription, setShowSubscription] = useState(false); const[subTab, setSubTab] = useState<'plans'|'credits'>('plans'); if (!state.upgradePrompt?.isOpen) return null;
  return (<><SubscriptionModal isOpen={showSubscription} onClose={() => { setShowSubscription(false); dispatch({ type: 'SET_UPGRADE_PROMPT', payload: null }); }} initialTab={subTab} />
    {!showSubscription && (<div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={() => dispatch({ type: 'SET_UPGRADE_PROMPT', payload: null })} />
      <div className="relative w-full max-w-md upgrade-prompt-warning p-6 space-y-5 animate-fade-in-scale">
        <div className="flex items-center justify-between"><div className="para-badge"><span>{state.upgradePrompt.title}</span></div><CloseButton onClick={() => dispatch({ type: 'SET_UPGRADE_PROMPT', payload: null })} /></div>
        <ParaDivider />
        <div className="text-center py-4"><div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{state.upgradePrompt.message}</div></div>
        <div className="flex gap-2">
          {state.upgradePrompt.showCredits && state.userProfile?.subscription_tier !== 'Free' ? (
             <button onClick={() => { setSubTab('credits'); setShowSubscription(true); }} className="para-btn para-btn-primary flex-1 py-3"><span>BUY CREDITS</span></button>
          ) : (
             <button onClick={() => { setSubTab('plans'); setShowSubscription(true); }} className="para-btn para-btn-primary flex-1 py-3"><span>VIEW PLANS</span></button>
          )}
          <button onClick={() => dispatch({ type: 'SET_UPGRADE_PROMPT', payload: null })} className="para-btn py-3"><span>LATER</span></button>
        </div>
      </div>
    </div>)}</>);
}

function UpgradeButton() {
  const { state } = useApp(); const[showSubscription, setShowSubscription] = useState(false); const tier = state.userProfile?.subscription_tier || 'Free'; const isPro = tier === 'Pro';
  return (
    <>
      <SubscriptionModal isOpen={showSubscription} onClose={() => setShowSubscription(false)} />
      {/* Add the ID here! ↓ */}
      <button 
        id="tour-upgrade-btn"
        onClick={() => setShowSubscription(true)} 
        className={cn("para-btn para-btn-sm", !isPro && "para-btn-primary animate-pulse-subtle")} 
        style={!isPro ? { background: 'linear-gradient(135deg, var(--accent), var(--accent-hover))', boxShadow: '0 0 10px var(--glow-color)' } : { borderColor: 'var(--accent)', color: 'var(--accent)' }}
      >
        <span>{isPro ? 'STORE' : '⬆ UPGRADE'}</span>
      </button>
    </>
  );
}

function BillingPage({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useApp(); const [loading, setLoading] = useState(false); const[purchaseSuccess, setPurchaseSuccess] = useState<string | null>(null);
  const p = state.userProfile; const tier = p?.subscription_tier || 'Free'; const isPaid = tier !== 'Free';
  const creditPacks =[{ id: 'small', name: 'Small Pack', credits: 150, price: 3.99 }, { id: 'medium', name: 'Medium Pack', credits: 400, price: 9.99 }, { id: 'large', name: 'Large Pack', credits: 900, price: 19.99 }];
  const pendingDate = p?.pending_deletion_at ? new Date(p.pending_deletion_at) : null; const daysLeft = pendingDate ? Math.ceil((pendingDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
  useEffect(() => { const h = () => onClose(); window.addEventListener('close-modal', h); return () => window.removeEventListener('close-modal', h); },[onClose]);
  const handleBuyCreditPack = async (packId: string) => { setLoading(true); setPurchaseSuccess(null); try { const result = await api.purchaseCreditPack(packId); if (!result) return; if (result.success) { const profile = await api.getMe(); dispatch({ type: 'SET_USER_PROFILE', payload: profile }); setPurchaseSuccess(`Added ${result.credits_added} credits!`); setTimeout(() => setPurchaseSuccess(null), 3000); } } catch {} finally { setLoading(false); } };
  const handleRecover = async () => { setLoading(true); try { await api.recoverContent(); const profile = await api.getMe(); dispatch({ type: 'SET_USER_PROFILE', payload: profile }); } catch {} finally { setLoading(false); } };
  return (
    <div className="absolute inset-0 z-[100] flex flex-col animate-fade-in-scale" style={{ background: 'var(--surface-1)' }}>
      <div className="bezel-toolbar h-12 flex items-center justify-between px-4 shrink-0 para-header"><div className="flex items-center gap-3 relative z-10"><div className="bezel-led animate-led-pulse" /><span className="text-sm font-semibold tracking-wider text-emboss uppercase" style={{ color: 'var(--text-primary)' }}>BILLING & SUBSCRIPTION</span><TierBadge tier={tier} trial={p?.is_in_plus_trial} /></div><CloseButton onClick={onClose} large /></div>
      <div className="flex-1 overflow-y-auto p-6 custom-scrollbar"><div className="max-w-4xl mx-auto space-y-6">
        {purchaseSuccess && (<div className="bezel-frame p-4 text-center" style={{ background: 'rgba(34, 197, 94, 0.1)', borderColor: 'rgba(34, 197, 94, 0.3)' }}><span className="text-sm font-bold" style={{ color: '#22c55e' }}>✓ {purchaseSuccess}</span></div>)}
        <div className="bezel-frame p-6"><div className="flex items-center justify-between mb-4"><h3 className="text-sm font-bold tracking-wider text-emboss" style={{ color: 'var(--text-primary)' }}>CURRENT PLAN</h3><TierBadge tier={tier} trial={p?.is_in_plus_trial} /></div><ParaDivider />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div className="bezel-well p-3 text-center"><div className="text-[10px] tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>CREDITS</div><div className="text-lg font-bold" style={{ color: 'var(--accent)' }}>{p?.credits || 0} / {p?.credits_total || 0}</div></div>
            <div className="bezel-well p-3 text-center"><div className="text-[10px] tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>RESET DATE</div><div className="text-sm font-mono" style={{ color: 'var(--text-primary)' }}>{p?.credits_reset_at ? new Date(p.credits_reset_at).toLocaleDateString() : 'N/A'}</div></div>
            <div className="bezel-well p-3 text-center"><div className="text-[10px] tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>BILLING CYCLE</div><div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{p?.billing_cycle?.toUpperCase() || 'N/A'}</div></div>
            <div className="bezel-well p-3 text-center"><div className="text-[10px] tracking-wider mb-1" style={{ color: 'var(--text-dim)' }}>RETENTION</div><div className="text-sm font-bold" style={{ color: tier === 'Pro' ? '#f59e0b' : 'var(--text-primary)' }}>{p?.tier_config?.retention_days ? `${p.tier_config.retention_days} days` : '∞ INFINITE'}</div></div>
          </div>
          {p?.pending_deletion_at && daysLeft !== null && (<div className="mt-4 p-3 bezel-well" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}><div className="flex justify-between items-center"><span className="text-[10px]" style={{ color: '#ef4444' }}>⚠ PENDING DELETION</span><span className="text-[11px] font-mono" style={{ color: '#ef4444' }}>{daysLeft} days left</span></div><button onClick={handleRecover} disabled={loading} className="para-btn para-btn-primary w-full mt-2 py-2" style={{ borderColor: '#ef4444', color: '#fff', background: 'rgba(239,68,68,0.2)' }}><span>RECOVER CONTENT NOW</span></button></div>)}
        </div>
        {isPaid && (<div className="bezel-frame p-6"><div className="flex items-center justify-between mb-4"><h3 className="text-sm font-bold tracking-wider text-emboss" style={{ color: 'var(--text-primary)' }}>CREDIT PACKS</h3></div><ParaDivider /><div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">{creditPacks.map(pack => (<div key={pack.id} className="bezel-well p-4 text-center"><div className="text-sm font-bold mb-2" style={{ color: 'var(--text-primary)' }}>{pack.name}</div><div className="text-2xl font-bold mb-1" style={{ color: 'var(--accent)' }}>{pack.credits}</div><div className="text-[10px] mb-3" style={{ color: 'var(--text-dim)' }}>credits</div><div className="text-sm font-bold mb-3" style={{ color: 'var(--text-primary)' }}>${pack.price.toFixed(2)}</div><button onClick={() => handleBuyCreditPack(pack.id)} className="para-btn para-btn-primary w-full py-2" disabled={loading}><span>{loading ? 'PROCESSING...' : 'BUY'}</span></button></div>))}</div></div>)}
      </div></div>
      <div className="bezel-statusbar px-5 py-3 flex items-center justify-end shrink-0"><button onClick={onClose} className="para-btn"><span>CLOSE</span></button></div>
    </div>
  );
}

export function ProfileModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
  const { state, dispatch } = useApp(); const[loading, setLoading] = useState(false);
  useEffect(() => { const h = () => { if (isOpen) onClose(); }; window.addEventListener('close-modal', h); return () => window.removeEventListener('close-modal', h); },[isOpen, onClose]);
  if (!isOpen) return null;
  const p = state.userProfile;
  const handleLogout = async () => { await api.logout(); dispatch({ type: 'SET_TOKEN', payload: null }); dispatch({ type: 'SET_USER_PROFILE', payload: null }); dispatch({ type: 'SET_VIEW', payload: 'home' }); onClose(); };
  const handleRecover = async () => { setLoading(true); try { await api.recoverContent(); const profile = await api.getMe(); dispatch({ type: 'SET_USER_PROFILE', payload: profile }); } catch {} finally { setLoading(false); } };
  const creditsRemaining = p?.credits ?? 0; const creditsTotal = p?.credits_total ?? 0; const creditsPercent = creditsTotal > 0 ? (creditsRemaining / creditsTotal) * 100 : 0;
  const isLowCredits = creditsPercent < 25 && creditsPercent > 0; const isDepleted = creditsRemaining === 0;
  const pendingDate = p?.pending_deletion_at ? new Date(p.pending_deletion_at) : null; const daysLeft = pendingDate ? Math.ceil((pendingDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-sm bezel-frame p-6 animate-fade-in-scale space-y-5">
        <div className="flex items-center justify-between"><div className="flex items-center gap-2"><div className="bezel-led animate-led-pulse" /><h2 className="text-sm font-bold tracking-widest text-emboss uppercase">USER PROFILE</h2></div><CloseButton onClick={onClose} /></div>
        <ParaDivider />
        <div className="space-y-3">
          <div className="bezel-raised p-3 space-y-2">
            <div className="flex justify-between items-center"><span className="text-[10px] tracking-widest uppercase text-engrave" style={{ color: 'var(--text-dim)' }}>Agent ID</span><span className="text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{p?.email}</span></div>
            <div className="flex justify-between items-center"><span className="text-[10px] tracking-widest uppercase text-engrave" style={{ color: 'var(--text-dim)' }}>Clearance Tier</span><div className="flex items-center gap-2"><TierBadge tier={p?.subscription_tier || 'Free'} trial={p?.is_in_plus_trial} />{p?.is_in_plus_trial && <span className="text-[9px] font-bold" style={{ color: '#a855f7' }}>{p.plus_trial_days_remaining}d left</span>}</div></div>
          </div>
          <div className="bezel-raised p-3 space-y-2">
            <div className="flex justify-between items-center"><span className="text-[10px] tracking-widest uppercase text-engrave" style={{ color: 'var(--text-dim)' }}>Available Credits</span><div className={cn("credit-indicator", isDepleted ? "credit-indicator-depleted" : isLowCredits ? "credit-indicator-low" : "")}><CreditIcon size={12} /><span className="font-bold">{creditsRemaining}</span><span className="text-[9px] opacity-50">/ {creditsTotal}</span></div></div>
            {p?.credits_reset_at && (<div className="flex justify-between items-center"><span className="text-[10px] tracking-widest uppercase text-engrave" style={{ color: 'var(--text-dim)' }}>Reset Date</span><span className="text-[9px] font-mono" style={{ color: 'var(--text-secondary)' }}>{new Date(p.credits_reset_at).toLocaleDateString()}</span></div>)}
            <div className="flex justify-between items-center"><span className="text-[10px] tracking-widest uppercase text-engrave" style={{ color: 'var(--text-dim)' }}>Phone Gate</span><span className="text-[9px] font-mono" style={{ color: p?.phone_verified ? '#22c55e' : '#f59e0b' }}>{p?.phone_verified ? (p.masked_phone || 'VERIFIED') : 'UNVERIFIED'}</span></div>
          </div>
          {p?.pending_deletion_at && daysLeft !== null && (<div className="bezel-raised p-3 space-y-2" style={{ borderColor: 'rgba(239, 68, 68, 0.3)' }}><div className="flex justify-between items-center"><span className="text-[10px]" style={{ color: '#ef4444' }}>⚠ PENDING DELETION</span><span className="text-[11px] font-mono" style={{ color: '#ef4444' }}>{daysLeft} days left</span></div><button onClick={handleRecover} disabled={loading} className="para-btn para-btn-primary w-full mt-2" style={{ borderColor: '#ef4444', color: '#fff', background: 'rgba(239,68,68,0.2)' }}><span>RECOVER CONTENT</span></button></div>)}
          {isDepleted && (<div className="upgrade-prompt-danger p-3 text-center"><div className="text-[10px] font-bold tracking-wider" style={{ color: 'var(--danger-color)' }}>⚠ CREDITS DEPLETED</div></div>)}
        </div>
        <button onClick={() => { onClose(); dispatch({ type: 'SET_TUTORIAL_OPEN', payload: true }); }} className="para-btn w-full py-3 mb-2"><span>VIEW TUTORIAL</span></button>
        <button onClick={() => { onClose(); dispatch({ type: 'SET_BILLING_PAGE_OPEN', payload: true }); }} className="para-btn para-btn-primary w-full py-3"><span>MANAGE SUBSCRIPTION</span></button>
        <button onClick={handleLogout} className="para-btn para-btn-danger w-full py-3"><span>DISCONNECT LOGOUT</span></button>
      </div>
    </div>
  );
}

export function EditShowModal({ isOpen, onClose, show }: { isOpen: boolean; onClose: () => void; show?: Show | null; }) {
  const { state, dispatch } = useApp();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [lore, setLore] = useState('');
  const [profile, setProfile] = useState('');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [activeTab, setActiveTab] = useState<string>('general');
  const [selEpId, setSelEpId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saveProgress, setSaveProgress] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<{ nn: string; ne: Episode[]; truncated?: boolean; originalCount?: number; } | null>(null);
  const [isGeneratingLore, setIsGeneratingLore] = useState(false);
  const tierConfig = state.userProfile?.tier_config;
  const currentTier = state.userProfile?.subscription_tier || 'Free';
  const isPro = currentTier === 'Pro';
  const stateRef = useRef({ name, description, lore, profile, episodes, show });

  useEffect(() => { stateRef.current = { name, description, lore, profile, episodes, show }; }, [name, description, lore, profile, episodes, show]);

  useEffect(() => {
    if (!isOpen) return;
    if (show) {
      setName(show.name); setDescription(show.description); setLore(show.lore); setProfile(show.profile); setEpisodes(show.episodes);
      setSelEpId(null); setActiveTab('general');
    } else {
      setName(''); setDescription(''); setLore(''); setProfile(''); setEpisodes([]);
      setSelEpId(null); setActiveTab('general');
    }
    const autoSaveInterval = setInterval(() => { handleSave(true); }, 3 * 60 * 1000);
    return () => clearInterval(autoSaveInterval);
  }, [isOpen, show]);

  if (!isOpen) return null;

  const handleGenerateLore = async () => {
    if (!name.trim()) { setErr("TITLE REQUIRED TO GENERATE LORE"); setActiveTab('general'); return; }
    setIsGeneratingLore(true); setErr(null);
    try {
      const res = await api.generateLore(name, description, episodes);
      setLore(res.lore);
    } catch (e: any) { setErr(e.message || "FAILED TO GENERATE LORE"); }
    finally { setIsGeneratingLore(false); }
  };

  const handleSave = async (isAutoSave = false) => {
    if (isAutoSave && isSaving) return;
    const current = stateRef.current;
    if (!isAutoSave) setErr(null);
    if (!current.name.trim()) { if (!isAutoSave) { setErr("TITLE REQUIRED"); setActiveTab('general'); } return; }
    const tierCfg = state.userProfile?.tier_config;
    if (tierCfg) {
      if (current.lore.length > tierCfg.max_lore_length) { if (!isAutoSave) setErr(`LORE LIMIT EXCEEDED`); return; }
      if (current.profile.length > tierCfg.max_profile_length) { if (!isAutoSave) setErr(`PROFILE LIMIT EXCEEDED`); return; }
      const overLimitEp = current.episodes.find(e => e.context.length > tierCfg.max_episode_length);
      if (overLimitEp) { if (!isAutoSave) setErr(`CHAPTER LIMIT EXCEEDED`); return; }
    }
    if (!isAutoSave) setIsSaving(true);
    if (!isAutoSave) setSaveProgress(null);
    try {
      const d: any = { name: current.name, description: current.description, lore: current.lore, profile: current.profile, episodes: current.episodes };
      const onProg = isAutoSave ? undefined : (msg: string) => setSaveProgress(msg);
      if (current.show) { const updated = await api.updateShow(current.show.id, d, onProg); dispatch({ type: 'UPDATE_SHOW', payload: updated }); }
      else { const created = await api.createShow(d, onProg); dispatch({ type: 'ADD_SHOW', payload: created }); dispatch({ type: 'SET_EDITING_SHOW', payload: created }); }
      api.getMe().then(p => dispatch({ type: 'SET_USER_PROFILE', payload: p })).catch(() => {});
      if (!isAutoSave) onClose();
    } catch (e: any) { if (!isAutoSave) setErr(e.message || "FAILED TO SAVE"); }
    finally { if (!isAutoSave) setIsSaving(false); setSaveProgress(null); }
  };

  const handleImport = () => {
    if (!importText.trim()) return;
    if (!isPro) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'PRO FEATURE', message: 'Bulk import is Pro-only.' } }); return; }
    const lines = importText.split('\n'); let nn = name; let ne: Episode[] = []; let cur: Partial<Episode> | null = null; let buf: string[] = [];
    for (const l of lines) {
      if (l.startsWith('# ')) nn = l.replace('# ', '').trim();
      else if (l.startsWith('## ')) { if (cur) { cur.context = buf.join('\n').trim(); ne.push(cur as Episode); } buf = []; cur = { id: Date.now().toString(), name: l.replace('## ', '').trim(), context: '' }; }
      else if (cur) buf.push(l);
    }
    if (cur) { cur.context = buf.join('\n').trim(); ne.push(cur as Episode); }
    if (ne.length > 0) {
      const maxEp = tierConfig?.max_episodes || 3;
      if (ne.length > maxEp) setPendingImport({ nn, ne, truncated: true, originalCount: ne.length });
      else setPendingImport({ nn, ne });
    }
  };

  const moveEp = (id: string, dir: 'up' | 'down') => {
    const i = episodes.findIndex(e => e.id === id);
    const ni = dir === 'up' ? i - 1 : i + 1;
    if (ni < 0 || ni >= episodes.length) return;
    const n = [...episodes]; [n[i], n[ni]] = [n[ni], n[i]]; setEpisodes(n);
  };

  const updateEp = (id: string, f: keyof Episode, v: string) => setEpisodes(episodes.map(e => e.id === id ? { ...e, [f]: v } : e));
  const activeEp = episodes.find(e => e.id === selEpId);
  const handleDrop = (e: React.DragEvent, tid: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === tid) { setDraggedId(null); setDragOverId(null); return; }
    const di = episodes.findIndex(ep => ep.id === draggedId);
    const ti = episodes.findIndex(ep => ep.id === tid);
    if (di === -1 || ti === -1) return;
    const n = [...episodes]; const [d] = n.splice(di, 1); n.splice(ti, 0, d); setEpisodes(n);
    setDraggedId(null); setDragOverId(null);
  };

  const tabs = [
    { key: 'general', label: 'GENERAL' },
    { key: 'episodes', label: 'CHAPTERS' },
    { key: 'lore', label: 'LORE' },
    { key: 'profile', label: 'PROFILE' }
  ];

  const maxEpisodes = tierConfig?.max_episodes || 3;
  const canAddEpisode = episodes.length < maxEpisodes;

  return (
    <>
      <ConfirmModal isOpen={!!pendingImport} title={pendingImport?.truncated ? "TIER LIMIT" : "OVERWRITE CHAPTERS"} message={pendingImport?.truncated ? `Parsed ${pendingImport.originalCount} episodes, limit is ${maxEpisodes}. Import first ${maxEpisodes}?` : pendingImport ? `Parsed ${pendingImport.ne.length} episodes. Replace?` : ''} confirmText={pendingImport?.truncated ? "IMPORT LIMITED" : "REPLACE"} isDanger onConfirm={() => { if (pendingImport) { const limited = pendingImport.ne.slice(0, maxEpisodes); setName(pendingImport.nn); setEpisodes(limited); setSelEpId(limited[0]?.id || null); setActiveTab('episodes'); setImportText(''); } }} onCancel={() => setPendingImport(null)} />
      <div className="absolute inset-0 z-[100] flex flex-col animate-fade-in-scale" style={{ background: 'var(--surface-1)' }}>
        <div className="bezel-toolbar h-12 flex items-center justify-between px-4 shrink-0 para-header">
          <div className="flex items-center gap-3 relative z-10">
            <div className="bezel-led animate-led-pulse" />
            <span className="text-sm font-semibold tracking-wider text-emboss uppercase" style={{ color: 'var(--text-primary)' }}>{show ? `EDIT: ${show.name}` : 'NEW BLUEPRINT'}</span>
            <div className="para-badge-glow para-badge"><span>EDITOR</span></div>
          </div>
          <CloseButton onClick={onClose} large />
        </div>
        <div className="flex-1 flex overflow-hidden">
          <div className="w-56 flex flex-col shrink-0 bezel-raised" style={{ borderRight: '2px solid rgba(0,0,0,0.5)' }}>
            <div className="p-3 space-y-1">
              <div className="text-[9px] font-bold tracking-[0.2em] text-engrave px-2 py-2" style={{ color: 'var(--text-dim)' }}>CONFIG</div>
              <div className="flex flex-col gap-1">
                {tabs.map(t => (
                  <button
                    key={t.key}
                    id={`tour-tab-${t.key}`}
                    data-tour-tab={t.key}
                    onClick={() => setActiveTab(t.key)}
                    className={cn("para-tab w-full", activeTab === t.key && "para-tab-active")}
                  >
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <ParaDivider />
            <div className="px-3 pb-2">
              <div className="flex justify-between items-center mb-2 px-1">
                <span className="text-[9px] font-bold tracking-[0.2em] text-engrave" style={{ color: 'var(--text-dim)' }}>CHAPTERS ({episodes.length}/{maxEpisodes})</span>
                <div className="flex gap-1">
                  <button onClick={() => { if (!isPro) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'PRO FEATURE', message: 'Bulk import is Pro-only.' } }); return; } setActiveTab('import'); }} className={cn("para-btn para-btn-sm", activeTab === 'import' && "para-tab-active", !isPro && "opacity-50")}><span>IMP</span></button>
                  <button id="tour-add-episode-btn" onClick={() => { if (!canAddEpisode) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'EPISODE LIMIT', message: `Limit is ${maxEpisodes}.` } }); return; } const e = { id: Date.now().toString(), name: 'New Chapter', context: '' }; setEpisodes([...episodes, e]); setSelEpId(e.id); setActiveTab('episodes'); }} className={cn("para-btn para-btn-sm", !canAddEpisode && "opacity-50")}><span>+</span></button>
                </div>
              </div>
            </div>
            {/* FIX: Added ID here for tutorial detection */}
            <div id="tour-episodes-list" className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-3 space-y-1">
              {episodes.map((ep, i) => (
                <div key={ep.id} draggable onDragStart={() => setDraggedId(ep.id)} onDragEnd={() => { setDraggedId(null); setDragOverId(null); }} onDragOver={e => { e.preventDefault(); if (ep.id !== draggedId) setDragOverId(ep.id); }} onDrop={e => handleDrop(e, ep.id)} onClick={() => { setActiveTab('episodes'); setSelEpId(ep.id); }} className={cn("w-full text-left px-2 py-2 text-[10px] cursor-grab group flex justify-between items-center transition-all select-none relative overflow-hidden", (activeTab === 'episodes' && selEpId === ep.id) ? "btn btn-pressed !border-[var(--border-color)]" : "btn btn-ghost", draggedId === ep.id && "opacity-40", dragOverId === ep.id && draggedId !== ep.id && "!border-[var(--accent)]")}>
                  {(activeTab === 'episodes' && selEpId === ep.id) && <div className="absolute left-0 top-0 bottom-0" style={{ transform: 'skewX(var(--skew))', width: '3px', background: 'var(--accent)', flexShrink: 0 }} />}
                  <div className="flex items-center gap-2 flex-1 min-w-0 ml-2"><span className="font-mono opacity-40" style={{ color: 'var(--text-dim)', fontSize: '9px' }}>{String(i + 1).padStart(2, '0')}</span><span className="truncate font-medium">{ep.name}</span></div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0"><button onClick={e => { e.stopPropagation(); moveEp(ep.id, 'up'); }} disabled={i === 0} className="btn btn-ghost btn-sm !p-0.5 disabled:opacity-20">↑</button><button onClick={e => { e.stopPropagation(); moveEp(ep.id, 'down'); }} disabled={i === episodes.length - 1} className="btn btn-ghost btn-sm !p-0.5 disabled:opacity-20">↓</button><button onClick={e => { e.stopPropagation(); setEpisodes(episodes.filter(x => x.id !== ep.id)); }} className="btn btn-ghost btn-sm !p-0.5 hover:!text-red-400">×</button></div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex-1 p-6 overflow-y-auto custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
            <div className="bezel-well p-6 h-full">
              {activeTab === 'general' && (
                <div className="max-w-2xl space-y-6 animate-fade-in">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--text-muted)' }}>Campaign Title</label>
                    <input id="tour-edit-title" value={name} onChange={e => setName(e.target.value)} maxLength={100} className="input-field w-full text-lg font-semibold" placeholder="Enter title..." />
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--text-muted)' }}>Description</label>
                    <textarea id="tour-edit-desc" value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} className="textarea-field font-story w-full h-40" placeholder="What is this story about?" />
                  </div>
                </div>
              )}
              {(activeTab === 'lore' || activeTab === 'profile') && (
                <div className="h-full flex flex-col animate-fade-in">
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-xs font-bold tracking-[0.15em] text-emboss uppercase" style={{ color: 'var(--accent)' }}>{activeTab} Data</span>
                    <div className="flex gap-2 items-center">
                      {activeTab === 'lore' && lore !== '' && (<button onClick={handleGenerateLore} disabled={isGeneratingLore || !name.trim()} className="para-btn para-btn-sm" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}><span>{isGeneratingLore ? 'GENERATING...' : 'REGENERATE'}</span></button>)}
                      <div className="para-badge"><span>MARKDOWN</span></div>
                    </div>
                  </div>
                  {activeTab === 'lore' && lore === '' && !isGeneratingLore ? (
                    <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-[var(--border-color)] rounded-lg p-6 opacity-80 hover:opacity-100 transition-opacity">
                      <div className="text-4xl mb-4 glow-text-strong" style={{ color: 'var(--accent)' }}>◈</div>
                      <div className="text-sm font-bold tracking-widest text-emboss mb-2 uppercase" style={{ color: 'var(--text-primary)' }}>No Lore Configured</div>
                      <div className="text-[10px] text-center max-w-md mb-6 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>Automatically generate world lore based on Title and Description.</div>
                      <button onClick={handleGenerateLore} className="para-btn para-btn-primary py-3 px-6"><span>AUTO-GENERATE WORLD LORE</span></button>
                      <button onClick={() => setLore(' ')} className="mt-4 text-[9px] tracking-widest hover:text-white transition-colors" style={{ color: 'var(--text-dim)' }}>OR WRITE MANUALLY</button>
                    </div>
                  ) : activeTab === 'lore' && isGeneratingLore ? (
                    <div className="flex-1 flex flex-col items-center justify-center border-2 border-[var(--border-color)] rounded-lg p-6">
                      <div className="text-4xl mb-4 animate-spin-slow glow-text-strong" style={{ color: 'var(--accent)' }}>◈</div>
                      <div className="text-sm font-bold tracking-widest text-emboss animate-pulse uppercase" style={{ color: 'var(--accent)' }}>Weaving the Universe...</div>
                    </div>
                  ) : (
                    <textarea
                      id={activeTab === 'lore' ? 'tour-lore-input' : 'tour-profile-input'}
                      value={activeTab === 'lore' ? lore : profile}
                      onChange={e => activeTab === 'lore' ? setLore(e.target.value) : setProfile(e.target.value)}
                      maxLength={activeTab === 'lore' ? (tierConfig?.max_lore_length || 20000) : (tierConfig?.max_profile_length || 20000)}
                      className="textarea-field font-story flex-1"
                      spellCheck={false}
                    />
                  )}
                </div>
              )}
              {activeTab === 'import' && (<div className="h-full flex flex-col animate-fade-in"><div className="flex items-center gap-3 mb-3"><span className="text-xs font-bold tracking-[0.15em] text-emboss uppercase" style={{ color: 'var(--accent)' }}>Bulk Import</span><TierBadge tier="Pro" /></div>{!isPro ? (<div className="flex-1 flex items-center justify-center"><div className="text-center space-y-4"><div className="text-4xl">🔒</div><div className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Pro Feature</div><button onClick={() => dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'PRO FEATURE', message: 'Upgrade to Pro.' } })} className="para-btn para-btn-primary"><span>UPGRADE</span></button></div></div>) : (<><textarea value={importText} onChange={e => setImportText(e.target.value)} maxLength={500000} className="textarea-field font-story flex-1" style={{ color: '#22c55e' }} placeholder={"# Saga\n## Ch1\n..."} /><button onClick={handleImport} className="para-btn para-btn-primary mt-4 w-full py-3"><span>PROCESS</span></button></>)}</div>)}
              {activeTab === 'episodes' && activeEp && (<div className="h-full flex flex-col animate-fade-in space-y-4"><div className="bezel-raised p-4 flex items-center justify-between para-corner-tl para-corner-br"><div className="flex-1">
                <label className="text-[9px] font-bold tracking-widest uppercase" style={{ color: 'var(--text-dim)' }}>Chapter Title</label>
                <input id="tour-episode-title" value={activeEp.name} onChange={e => updateEp(activeEp.id, 'name', e.target.value)} maxLength={100} className="input-field w-full text-lg font-semibold mt-1" />
              </div><div className="text-right ml-4 space-y-1"><div className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>POS: {episodes.findIndex(e => e.id === activeEp.id) + 1}/{episodes.length}</div><ParaProgress current={episodes.findIndex(e => e.id === activeEp.id) + 1} total={episodes.length} /></div></div><div className="flex-1 flex flex-col"><label className="text-[9px] font-bold tracking-widest uppercase mb-2" style={{ color: 'var(--text-dim)' }}>Context / Prompt</label>
                <textarea id="tour-episode-context" value={activeEp.context} onChange={e => updateEp(activeEp.id, 'context', e.target.value)} maxLength={tierConfig?.max_episode_length || 100000000} className="textarea-field font-story flex-1" placeholder="Describe the scene..." /></div></div>)}
              {activeTab === 'episodes' && !activeEp && (<div className="h-full flex items-center justify-center opacity-20"><div className="text-center"><div className="text-4xl mb-4" style={{ color: 'var(--accent)' }}>←</div><div className="tracking-widest text-sm text-emboss">SELECT A CHAPTER</div></div></div>)}
            </div>
          </div>
        </div>
        <div className="bezel-statusbar h-14 flex items-center justify-end px-5 gap-3 shrink-0">
          <div className="mr-auto text-[11px] font-mono">{err ? <span className="text-red-400 font-bold animate-blink">⚠ {err}</span> : saveProgress && !isSaving ? <span className="text-[var(--accent)] animate-pulse">{saveProgress}</span> : <span style={{ color: 'var(--text-dim)' }}>{episodes.length} chapters ready</span>}</div>
          <button onClick={onClose} disabled={isSaving} className="para-btn"><span>DISCARD</span></button>
          <button id="tour-save-blueprint-btn" onClick={() => handleSave(false)} disabled={isSaving} className={cn("para-btn para-btn-primary", isSaving && "opacity-50 min-w-[140px]")}><span>{isSaving ? (saveProgress || "SAVING...") : "SAVE"}</span></button>
        </div>
      </div>
    </>
  );
}

export function FinishEpisodeModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
  const { state, dispatch } = useApp();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'prompt' | 'edit'>('prompt');
  const [summary, setSummary] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const autoSummaries = state.userProfile?.tier_config?.auto_summaries ?? false;

  useEffect(() => { const h = () => { if (isOpen) onClose(); }; window.addEventListener('close-modal', h); return () => window.removeEventListener('close-modal', h); }, [isOpen, onClose]);
  useEffect(() => { if (isOpen) { setStep('prompt'); setSummary(''); setLoading(false); setErr(null); } }, [isOpen, state.currentInstance]);

  if (!isOpen || !state.currentInstance) return null;
  const ep = state.currentInstance.episodes[state.currentInstance.currentEpisodeIndex];
  if (!ep) return null;
  const isLast = state.currentInstance.currentEpisodeIndex >= state.currentInstance.episodes.length - 1;

  const handleGenerate = async () => {
    setErr(null);
    if (!autoSummaries) { setSummary('[Write manually — auto-summaries require Plus or higher.]'); setStep('edit'); return; }
    setLoading(true);
    try {
      const transcript = state.messages.map(m => `${m.role === 'user' ? 'USER' : 'STORY'}:\n${m.content}`).join('\n');
      if (!transcript.trim()) { setSummary('[No conversation history to summarize. Take some actions first.]'); setStep('edit'); return; }
      const res = await api.summarizeText(transcript);
      setSummary(res.summary || '[Summary generated but returned empty.]');
      setStep('edit');
    } catch (e: any) {
      console.error('Summary generation failed:', e);
      setErr(e.message || 'Summary generation failed');
      setSummary('[Failed — write manually.]');
      setStep('edit');
    }
    finally { setLoading(false); }
  };

  const handleAdvance = async () => {
    if (!state.currentInstance) return;
    setErr(null);
    setLoading(true);
    try {
      await api.advanceInstance(state.currentInstance.id, summary);
      const newHist = [...(state.currentInstance.summaryHistory || []), { episodeName: ep.name, summary, timestamp: new Date().toISOString() }];
      const newInstance = { ...state.currentInstance, currentEpisodeIndex: state.currentInstance.currentEpisodeIndex + 1, messages: [], summaryHistory: newHist };
      dispatch({ type: 'UPDATE_INSTANCE', payload: newInstance as Instance });
      dispatch({ type: 'SET_CURRENT_INSTANCE', payload: newInstance as Instance });
      onClose();
    } catch (e: any) {
      console.error('Failed to advance episode:', e);
      setErr(e.message || 'Failed to advance episode');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div id="tour-finish-modal" className="relative w-full max-w-lg bezel-frame p-6 space-y-5 animate-fade-in-scale para-corner-tl para-corner-br">
        <div className="flex items-center justify-between"><div className="para-badge-danger para-badge"><span>EPISODE COMPLETE</span></div><CloseButton onClick={onClose} /></div><ParaDivider />
        {step === 'prompt' ? (
          <div className="text-center py-2 space-y-4">
            <div className="text-xl font-bold text-emboss" style={{ color: 'var(--text-primary)' }}>"{ep.name}"</div>
            <ParaProgress current={state.currentInstance.currentEpisodeIndex + 1} total={state.currentInstance.episodes.length} />
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{isLast ? "Campaign complete." : "Proceed to next chapter?"}</div>
            {err && <div className="text-[10px] font-bold animate-blink" style={{ color: '#ef4444' }}>⚠ {err}</div>}
            {!autoSummaries && <div className="upgrade-prompt p-2 text-[10px]" style={{ color: 'var(--text-secondary)' }}>Auto-summaries require Plus or higher. Write your summary manually.</div>}
            <div className="flex gap-2 mt-4">
              <button id="tour-finish-generate-btn" onClick={handleGenerate} disabled={loading} className={cn("para-btn para-btn-primary flex-1 py-3", loading && "opacity-50")}><span>{loading ? 'GENERATING...' : (autoSummaries ? 'GENERATE SUMMARY' : 'WRITE SUMMARY')}</span></button>
              <button onClick={onClose} disabled={loading} className="para-btn py-3"><span>CANCEL</span></button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-[10px] tracking-widest font-bold uppercase" style={{ color: 'var(--accent)' }}>REVIEW SUMMARY</div>
            {err && <div className="text-[10px] font-bold animate-blink" style={{ color: '#ef4444' }}>⚠ {err}</div>}
            <textarea id="tour-finish-summary" value={summary} onChange={e => setSummary(e.target.value)} maxLength={10000} className="textarea-field font-story w-full h-48 text-sm" />
            <div className="flex gap-2">
              <button id="tour-finish-confirm-btn" onClick={handleAdvance} disabled={loading || !summary.trim()} className={cn("para-btn para-btn-danger flex-1 py-3", (loading || !summary.trim()) && "opacity-50")}><span>{loading ? 'PROCESSING...' : isLast ? 'FINISH SAGA ■' : 'CONFIRM & NEXT ▶'}</span></button>
              <button onClick={() => setStep('prompt')} disabled={loading} className="para-btn py-3"><span>BACK</span></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
  const { state, dispatch } = useApp(); const[local, setLocal] = useState<Settings>(state.settings); const [tab, setTab] = useState<'theme' | 'ai'>('theme'); const [saving, setSaving] = useState(false);
  useEffect(() => { const h = () => { if (isOpen) onClose(); }; window.addEventListener('close-modal', h); return () => window.removeEventListener('close-modal', h); },[isOpen, onClose]);
  useEffect(() => { if (isOpen) { setLocal(state.settings); setTab('theme'); } },[isOpen, state.settings]);
  if (!isOpen) return null;
  const colors: { value: Settings['colorTheme']; label: string; swatch: string }[] =[{ value: 'mono', label: 'MONO', swatch: '#888' }, { value: 'purple', label: 'PURPLE', swatch: '#a855f7' }, { value: 'cyan', label: 'CYAN', swatch: '#06b6d4' }, { value: 'green', label: 'GREEN', swatch: '#22c55e' }, { value: 'amber', label: 'AMBER', swatch: '#f59e0b' }, { value: 'red', label: 'red', swatch: '#ef4444' }];

  const chunkModeOptions: { value: ChunkMode; label: string; desc: string }[] =[
    { value: 'auto',       label: 'AUTO-NAV',       desc: 'AI selects the chunks.' },
    { value: 'manual',     label: 'MANUAL',         desc: 'Picker shown at episode start and on skip commands. Full user control.' },
  ];

  const handleSave = async () => {
    setSaving(true);
    dispatch({ type: 'UPDATE_SETTINGS', payload: local });
    await api.updateEnvSettings({ model: local.model, chunkSelectionMode: local.chunkSelectionMode });
    setSaving(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 modal-backdrop" onClick={onClose} />
      <div className="relative w-full max-w-xl bezel-frame animate-fade-in-scale overflow-hidden">
        <div className="bezel-toolbar flex items-center justify-between px-5 py-3 para-header"><div className="flex items-center gap-3 relative z-10"><div className="bezel-led animate-led-pulse" /><h2 className="text-sm font-bold tracking-wider text-emboss" style={{ color: 'var(--text-primary)' }}>SETTINGS</h2></div><CloseButton onClick={onClose} large /></div>
        <div className="flex px-4 py-2 gap-1" style={{ background: 'var(--surface-2)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}>
          {[{ k: 'theme', l: 'THEME' }, { k: 'ai', l: 'AI ENGINE' }].map(t => (<button key={t.k} onClick={() => setTab(t.k as any)} className={cn("para-tab flex-1", tab === t.k && "para-tab-active")}><span>{t.l}</span></button>))}
        </div>
        <div className="p-5 max-h-[60vh] overflow-y-auto custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
          <div className="bezel-well p-5 space-y-5">
            {tab === 'theme' && (<div className="animate-fade-in space-y-5"><div><div className="flex items-center gap-3 mb-3"><span className="text-[10px] font-bold tracking-[0.15em] text-engrave uppercase" style={{ color: 'var(--text-dim)' }}>Appearance</span></div><div className="grid grid-cols-2 gap-2">{([{ value: 'dark' as const, label: 'DARK' }, { value: 'light' as const, label: 'LIGHT' }]).map(m => (<button key={m.value} onClick={() => setLocal({ ...local, appearance: m.value })} className={cn("btn h-12 flex items-center justify-center gap-2", local.appearance === m.value && "btn-pressed !border-[var(--border-color)]")}><span className="text-[10px] tracking-widest font-bold">{m.label}</span></button>))}</div></div><ParaDivider /><div><div className="flex items-center gap-3 mb-3"><span className="text-[10px] font-bold tracking-[0.15em] text-engrave uppercase" style={{ color: 'var(--text-dim)' }}>Color Theme</span></div><div className="grid grid-cols-3 gap-2">{colors.map(c => (<button key={c.value} onClick={() => setLocal({ ...local, colorTheme: c.value })} className={cn("btn h-14 flex flex-col items-center justify-center gap-1 relative overflow-hidden", local.colorTheme === c.value && "btn-pressed !border-[var(--border-color)]")}><div className="w-4 h-4" style={{ background: c.swatch, border: '1px solid rgba(0,0,0,0.4)', boxShadow: local.colorTheme === c.value ? `0 0 6px ${c.swatch}` : 'inset 0 1px 2px rgba(0,0,0,0.3)' }} /><span className="text-[8px] tracking-widest">{c.label}</span>{local.colorTheme === c.value && <div className="absolute right-0 top-0 bottom-0 w-3 opacity-50" style={{ background: c.swatch }} />}</button>))}</div></div></div>)}
            {tab === 'ai' && (
              <div className="animate-fade-in space-y-5">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-[10px] font-bold tracking-[0.15em] text-engrave uppercase" style={{ color: 'var(--text-dim)' }}>Episode Navigation Mode</span>
                  </div>
                  <div className="text-[9px] mb-3 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    Controls how episode content is served each turn.
                  </div>
                  <div className="space-y-2">
                    {chunkModeOptions.map(opt => (
                      <button key={opt.value} onClick={() => setLocal({ ...local, chunkSelectionMode: opt.value })} className={cn("w-full text-left p-3 bezel-raised transition-all relative overflow-hidden", local.chunkSelectionMode === opt.value && "!border-[var(--accent)]")}>
                        {local.chunkSelectionMode === opt.value && <div className="para-accent absolute left-0 top-1 bottom-1" />}
                        <div className="ml-3 flex items-start justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-bold mb-0.5" style={{ color: local.chunkSelectionMode === opt.value ? 'var(--accent)' : 'var(--text-primary)' }}>{opt.label}</div>
                            <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>{opt.desc}</div>
                          </div>
                          <ChunkModeBadge mode={opt.value} />
                        </div>
                      </button>
                    ))}
                  </div>
                  {local.chunkSelectionMode === 'manual' && (<div className="mt-3 p-2 rounded text-[9px]" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', color: '#f59e0b' }}>In MANUAL mode, the picker appears at episode start and on skip commands. Use CHUNKS button to browse at any time.</div>)}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="bezel-statusbar flex gap-2 px-5 py-3"><button onClick={handleSave} disabled={saving} className={cn("para-btn para-btn-primary flex-1 py-2.5", saving && "opacity-50")}><span>{saving ? 'SAVING...' : 'SAVE'}</span></button><button onClick={onClose} className="para-btn flex-1 py-2.5"><span>CANCEL</span></button></div>
      </div>
    </div>
  );
}

function ModelSelector() {
  const { state, dispatch } = useApp(); const[open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); },[open]);
  const models = state.availableModels; const currentModel = state.settings.model; const currentName = models.find(m => m.id === currentModel)?.name || currentModel || 'Select Model';
  const selectModel = (id: string) => { dispatch({ type: 'UPDATE_SETTINGS', payload: { model: id } }); api.updateEnvSettings({ ...state.settings, model: id }); setOpen(false); };
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className={cn("para-btn para-btn-sm", open && "para-tab-active")} title="Select AI Model"><span className="flex items-center gap-1.5"><span className="text-[9px]">▼</span><span className="max-w-[120px] truncate">{currentName}</span></span></button>
      {open && (<div className="absolute top-full right-0 mt-1 z-[150] min-w-[220px] bezel-frame animate-fade-in" style={{ background: 'var(--surface-2)' }}><div className="p-1"><div className="text-[8px] tracking-widest font-bold px-3 py-1.5 text-engrave" style={{ color: 'var(--text-dim)' }}>SELECT MODEL</div>{models.map(m => (<button key={m.id} onClick={() => selectModel(m.id)} className={cn("w-full text-left px-3 py-2 text-[11px] font-medium transition-all flex items-center gap-2", m.id === currentModel ? "text-emboss" : "hover:bg-[var(--surface-3)]")} style={{ color: m.id === currentModel ? 'var(--accent)' : 'var(--text-secondary)', background: m.id === currentModel ? 'var(--surface-0)' : undefined }}>{m.id === currentModel && <div className="w-1.5 h-1.5 flex-shrink-0" style={{ background: 'var(--accent)', boxShadow: '0 0 4px var(--glow-color)' }} />}<span className="truncate">{m.name}</span></button>))}{models.length === 0 && <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>No models configured</div>}</div></div>)}
    </div>
  );
}

function ExportButton({ instanceId, isShared = false }: { instanceId: string; isShared?: boolean }) {
    const [open, setOpen] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorVisible, setErrorVisible] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (!open) return;
        const h = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [open]);

    const dismissError = () => {
        setErrorVisible(false);
        setTimeout(() => setError(null), 300);
    };

    const showError = (msg: string) => {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        setError(msg);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                setErrorVisible(true);
            });
        });
        errorTimerRef.current = setTimeout(dismissError, 3500);
    };

    const handleExport = async (format: 'json' | 'markdown' | 'txt') => {
        setExporting(true);
        setOpen(false);
        setError(null);
        try {
            if (isShared) {
                await api.exportSharedInstance(instanceId, format);
            } else {
                await api.exportInstance(instanceId, format);
            }
        } catch (e: any) {
            showError(e.message || 'EXPORT FAILED');
        } finally {
            setExporting(false);
        }
    };

    const formats: { value: 'json' | 'markdown' | 'txt'; label: string; desc: string }[] = [
        { value: 'markdown', label: 'Markdown', desc: 'Readable document (.md)' },
        { value: 'txt', label: 'Plain Text', desc: 'Simple text file (.txt)' },
        { value: 'json', label: 'JSON', desc: 'Full data with metadata (.json)' },
    ];

    return (
        <div className="relative" ref={ref}>
            <button
                onClick={() => { setOpen(!open); setError(null); }}
                className={cn("para-btn para-btn-sm", exporting && "opacity-50", open && "para-tab-active")}
                disabled={exporting}
                title="Export Chat"
            >
                <span>{exporting ? 'EXPORTING...' : '⬇ EXPORT'}</span>
            </button>
            
            {error && (
                <div 
                    onClick={dismissError} 
                    className="absolute top-full right-0 mt-1 z-[150] min-w-[220px] bezel-frame p-3 cursor-pointer transition-opacity duration-300"
                    style={{ 
                        background: 'var(--surface-2)', 
                        borderColor: 'rgba(239, 68, 68, 0.5)',
                        opacity: errorVisible ? 1 : 0 
                    }}
                >
                    <div className="text-[10px] font-bold tracking-widest" style={{ color: '#ef4444' }}>⚠ {error}</div>
                </div>
            )}
            
            {open && !error && (
                <div
                    className="absolute top-full right-0 mt-1 z-[150] min-w-[220px] bezel-frame animate-fade-in"
                    style={{ background: 'var(--surface-2)' }}
                >
                    <div className="p-1">
                        <div className="text-[8px] tracking-widest font-bold px-3 py-1.5 text-engrave" style={{ color: 'var(--text-dim)' }}>
                            EXPORT FORMAT
                        </div>
                        {formats.map(f => (
                            <button
                                key={f.value}
                                onClick={() => handleExport(f.value)}
                                className="w-full text-left px-3 py-2.5 hover:bg-[var(--surface-3)] transition-colors"
                            >
                                <div className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                                    {f.label}
                                </div>
                                <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>
                                    {f.desc}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function ChatMessage({ message, isStreaming, streamingText, streamingReasoning, onEdit, onDelete, onRegenerate, onBranch, isArchived, isOwner }: { message: Message | { id: string; role: string; content: string; reasoning?: string; meta?: any }; isStreaming?: boolean; streamingText?: string; streamingReasoning?: string; onEdit: (id: string, content: string) => void; onDelete: (id: string) => void; onRegenerate: (id: string) => void; onBranch?: (id: string) => void; isArchived?: boolean; isOwner?: boolean; }) {
  const[editing, setEditing] = useState(false); const [editContent, setEditContent] = useState(message.content);
  const isUser = message.role === 'user'; const showControls = !editing && !isArchived && isOwner !== false;
  let displayContent = isStreaming ? (streamingText || '') : (message.content || '');
  let displayReasoning = isStreaming ? (streamingReasoning || message.reasoning || '') : (message.reasoning || '');
  displayContent = displayContent.replace(/\[CHUNK_COMPLETE\]/g, '');
  if (!displayReasoning && displayContent.includes('<think>')) {
    const thinkStart = displayContent.indexOf('<think>'); const thinkEnd = displayContent.indexOf('</think>');
    if (thinkStart !== -1) { if (thinkEnd !== -1) { displayReasoning = displayContent.substring(thinkStart + 7, thinkEnd).trim(); displayContent = (displayContent.substring(0, thinkStart) + displayContent.substring(thinkEnd + 8)).trim(); } else { displayReasoning = displayContent.substring(thinkStart + 7).trim(); displayContent = displayContent.substring(0, thinkStart).trim(); } }
  }
  return (
    <div className="relative group transition-all" style={{ background: isUser ? 'var(--surface-2)' : 'var(--bg-tint)' }}>
      <div className="px-5 py-5">
        {showControls && (
          <div className="sticky top-3 float-right z-20 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 ml-2">
            {onBranch && <button onClick={() => onBranch(message.id)} disabled={isStreaming} className="para-btn para-btn-sm" title="Branch from here"><span>⑂</span></button>}
            <button onClick={() => onRegenerate(message.id)} disabled={isStreaming} className={cn("para-btn para-btn-sm", isStreaming && "opacity-30 cursor-not-allowed")}><span>↻</span></button>
            <button onClick={() => { setEditContent(message.content); setEditing(true); }} disabled={isStreaming} className={cn("para-btn para-btn-sm", isStreaming && "opacity-30 cursor-not-allowed")}><span>✎</span></button>
            <button onClick={() => onDelete(message.id)} disabled={isStreaming} className={cn("para-btn para-btn-sm para-btn-danger", isStreaming && "opacity-30 cursor-not-allowed")}><span>✕</span></button>
          </div>
        )}
        <div className={cn("text-[9px] font-bold tracking-[0.2em] mb-3 uppercase flex items-center gap-2 select-none", isUser ? 'text-engrave' : 'glow-text')}>
          <div className={cn("w-2 h-2", isUser ? "bezel-led-off" : "bezel-led animate-led-pulse")} />
          <span style={{ color: isUser ? 'var(--text-dim)' : 'var(--accent)' }}>{isUser ? 'PLAYER' : 'NARRATOR'}</span>
          {!isUser && <div className="para-badge"><span>AI</span></div>}
          {isStreaming && <span className="animate-blink" style={{ color: 'var(--accent)' }}>▋</span>}
        </div>
        {editing ? (
          <div className="space-y-3 animate-fade-in">
            <textarea value={editContent} onChange={e => setEditContent(e.target.value)} maxLength={100000} className="textarea-field w-full custom-scrollbar" style={{ height: '60vh', fontFamily: 'var(--font-sans)', fontSize: '15px', lineHeight: '1.75', color: 'var(--text-primary)' }} autoFocus />
            <div className="flex gap-2"><button onClick={() => { onEdit(message.id, editContent); setEditing(false); }} className="para-btn para-btn-primary para-btn-sm"><span>SAVE</span></button><button onClick={() => setEditing(false)} className="para-btn para-btn-sm"><span>CANCEL</span></button></div>
          </div>
        ) : (
          <div className="animate-fade-in">
            {displayReasoning && (
              <details className="mb-4 group/thought transition-all" open={false}>
                <summary className="cursor-pointer w-max text-[9px] tracking-[0.2em] font-bold text-[var(--text-dim)] flex items-center gap-2 select-none hover:text-[var(--accent)] transition-colors opacity-80 hover:opacity-100 outline-none">
                  <span className="text-[var(--accent)] transform group-open/thought:rotate-90 transition-transform">▶</span>
                  INTERNAL LOGIC {isStreaming && !displayContent ? <span className="animate-blink text-[var(--accent)]">▋</span> : ""}
                </summary>
                <div className="mt-3 p-3 bezel-well text-[11px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap opacity-90 border-l border-[var(--accent)] max-h-[300px] overflow-y-auto custom-scrollbar leading-relaxed">{displayReasoning}</div>
              </details>
            )}
            {(displayContent || (isStreaming && !displayReasoning)) && (<div className="prose-chat max-w-none"><ReactMarkdown 
  remarkPlugins={[remarkGfm]} 
  rehypePlugins={[rehypeSanitize]}
>
  {displayContent || ''}
</ReactMarkdown></div>)}
          </div>
        )}
      </div>
      <div className="bezel-separator mx-0" />
    </div>
  );
}

// ----------------------------------------------------------------------
// LANDING PAGE CONFIGURATION (Upgraded for accurate app reflection)
// ----------------------------------------------------------------------
const LANDING_CONFIG = {
  hero: {
    title: "CRISTOL",
    subtitle: "ADVANCED NARRATIVE TERMINAL",
    description: "A next-generation AI Game Master built for infinite roleplay. With persistent world blueprints, dynamic context chunking, and strict player autonomy, your saga can span a million words without the AI ever forgetting the plot.",
    primaryCTA: "SIGN UP",
    secondaryCTA: "LOG IN"
  },
  features: [
    { id: 'f1', title: "Strict Player Autonomy", icon: "⧉", desc: "Tired of the AI speaking for you? Cristol's core directive explicitly forbids the Narrator from controlling your actions or dialogue. It sets the scene, forces a choice, and waits." },
    { id: 'f2', title: "Infinite Memory Retention", icon: "∞", desc: "Never lose a memory. The system automatically condenses older messages into dense continuity briefings—retaining character dispositions, injuries, and world states forever." },
    { id: 'f3', title: "Granular Context Control", icon: "▤", desc: "Take manual control over the AI's context window. Pin critical story chunks and guide the Narrator precisely, or let the AI picker seamlessly transition scenes." },
    { id: 'f4', title: "Deep World Blueprints", icon: "◈", desc: "Generate comprehensive world rules, character voices, and species from a simple prompt. The AI rigorously obeys your custom canon and relationship ledgers." },
    { id: 'f5', title: "Reality Branching", icon: "⑂", desc: "Made a fatal error? Fork the timeline. Branch your save state from any specific message and explore alternate narrative paths without overwriting your original run." },
    { id: 'f6', title: "Multiplayer Uplink", icon: "⎇", desc: "Share your terminal via a secure read-only datalink, or grant full collaborative access to co-authors to co-pilot the story in real-time." },
  ],
  about: {
    title: "SYSTEM ORIGINS",
    subtitle: "DEFEATING CONTEXT COLLAPSE",
    content: "Cristol didn't start as a platform—it began as a personal quest for a very specific kind of escapism. I wanted to live inside the stories I loved, reimagining them in real-time. But trying to run a long-term saga on standard AI platforms always hit the same wall: 'Context Collapse.' As a roleplay session stretched into tens of thousands of words, the AI's intelligence actively dropped. The context window grew, API prices became... terrifiying to say the least, and the model suffered from memory decay, breaking the rules, and by extension, the immersion completely.\n\nThe solution wasn't to shill out for an AI model that would get worse as time went on, or stop playing, it was to build a system around it to fix the problems. Cristol wraps the LLM in a custom engine that flattens the context curve. By dynamically chunking the narrative and running rolling continuity ledgers in the background, the AI only sees exactly what it needs to render the current moment. The result? The model stays exceptionally sharp, the costs stay low, and the story never degrades.\n\nBehind the terminal interface, Cristol is a proudly Egyptian, solo-developed project. This isn't a sterile, venture-backed corporate AI—it’s an indie labor of love built by someone who just wanted to have fun and experience pure narrative joy. Cristol exists so you can establish an uplink, step into the operator's chair, and lose yourself in an infinite universe that actually remembers who you are."
  },
  pricing: [
    { name: 'Free', price: '$0', desc: 'For casual operatives.', credits: '75 CR', limits: '1 Save, 3 Chapters', features: ['Manual summaries', 'Read-only sharing', '30-day retention', 'Phone verification req.'] },
    { name: 'Basic', price: '$7.99', desc: 'For dedicated writers.', credits: '200 CR/mo', limits: '2 Saves, 5 Chapters', features: ['3-day Plus trial', 'Read-only sharing', '6-month retention'] },
    { name: 'Plus', price: '$19.99', desc: 'The optimal experience.', credits: '600 CR/mo', limits: '5 Saves, 15 Chapters', features: ['Auto rolling summaries', 'Full collaboration', '1-year retention'], recommended: true },
    { name: 'Pro', price: '$34.99', desc: 'Unrestricted access.', credits: '1200 CR/mo', limits: '20 Saves, 45 Chapters', features: ['Reality branching', 'Bulk episode import', 'Infinite retention'] }
  ],
  faq: [
    { q: "What is a 'Chunk'?", a: "A chunk is a compressed segment of your story. Instead of feeding the AI your entire history (which causes token limits and hallucinations), CRISTOL divides your chapters into chunks and dynamically feeds the most relevant ones to the AI." },
    { q: "Why does the AI never act for me?", a: "CRISTOL is programmed with a strict 'Second-Person POV' constraint. The AI acts as the world and the NPCs, but it is explicitly forbidden from writing your dialogue, thoughts, or actions. You are fully in control of your character." },
    { q: "What is 'Rolling Continuity'?", a: "Available on Plus and Pro, the system automatically runs a background AI process to summarize older chat messages into a dense, factual 'Ledger'. This keeps your character's injuries, relationships, and inventory perfectly tracked without wasting tokens." },
    { q: "How do credits work?", a: "Every interaction burns a small amount of credits depending on the AI model used and the context size. Credits reset monthly on paid plans, or you can purchase instant top-up packs in the store." }
  ]
};

// Helper for Scroll Animations
function ScrollReveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string; }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { threshold: 0.1 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={cn("transition-all duration-1000 ease-out", visible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-12 scale-95", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

// FAQ Accordion Component
function FAQItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <ScrollReveal delay={index * 100} className="bezel-raised overflow-hidden transition-all duration-300">
      <button onClick={() => setOpen(!open)} className="w-full text-left p-5 flex justify-between items-center transition-colors" style={{ background: open ? 'var(--surface-3)' : 'var(--surface-2)' }}>
        <span className="text-[11px] font-bold tracking-widest text-emboss" style={{ color: 'var(--text-primary)' }}>{q}</span>
        <span className="text-xl font-mono" style={{ color: 'var(--accent)' }}>{open ? '−' : '+'}</span>
      </button>
      <div className={cn("px-5 overflow-hidden transition-all duration-500 ease-in-out", open ? "max-h-64 py-5 opacity-100" : "max-h-0 py-0 opacity-0")} style={{ background: 'var(--surface-1)' }}>
        <p className="text-[11px] leading-relaxed font-story" style={{ color: 'var(--text-secondary)' }}>{a}</p>
      </div>
    </ScrollReveal>
  );
}


// ----------------------------------------------------------------------
// MAIN LANDING PAGE COMPONENT
// ----------------------------------------------------------------------
function LandingPage() {
  const { dispatch } = useApp();

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar w-full scroll-smooth relative" style={{ background: 'var(--surface-0)' }}>
      
      {/* NAVIGATION BAR */}
      <nav className="sticky top-0 z-50 bezel-toolbar px-6 py-3 flex items-center justify-between" style={{ background: 'var(--surface-1)' }}>
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => scrollTo('hero')}>
          <span className="text-xl glow-text-strong" style={{ color: 'var(--accent)' }}>◈</span>
          <span className="text-[12px] font-bold tracking-[0.2em] text-emboss hidden md:inline">CRISTOL</span>
        </div>
        <div className="hidden md:flex gap-6 text-[10px] tracking-widest font-bold text-engrave" style={{ color: 'var(--text-dim)' }}>
          <button onClick={() => scrollTo('features')} className="hover:text-[var(--accent)] transition-colors">FEATURES</button>
          <button onClick={() => scrollTo('about')} className="hover:text-[var(--accent)] transition-colors">ABOUT</button>
          <button onClick={() => scrollTo('pricing')} className="hover:text-[var(--accent)] transition-colors">PRICING</button>
          <button onClick={() => scrollTo('faq')} className="hover:text-[var(--accent)] transition-colors">FAQ</button>
        </div>
        <div className="flex gap-2">
          {/* LOGIN BUTTON IN NAVBAR */}
          <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'login' }); }} className="para-btn para-btn-sm py-2 px-4 hidden sm:block"><span>LOG IN</span></button>
          {/* SIGNUP BUTTON IN NAVBAR */}
          <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'register' }); }} className="para-btn para-btn-sm para-btn-primary py-2 px-4"><span>SIGN UP</span></button>
        </div>
      </nav>

      {/* HERO SECTION */}
      <section id="hero" className="min-h-[90vh] flex flex-col items-center justify-start pt-27 md:pt-36 pb-20 px-6 relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none" style={{ backgroundImage: 'radial-gradient(var(--accent) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full blur-[120px] opacity-10 pointer-events-none" style={{ background: 'var(--accent)' }} />

        <div className="text-center space-y-8 max-w-4xl relative z-10 animate-fade-in-scale">
          {/* LOGO */}
          <div className="text-7xl md:text-9xl mb-8 glow-text-strong animate-pulse-subtle" style={{ color: 'var(--accent)' }}>◈</div>
          
          {/* TITLE */}
          <h1 className="text-5xl md:text-7xl font-bold tracking-[0.3em] text-emboss leading-tight">{LANDING_CONFIG.hero.title}</h1>
          
          <div className="flex items-center justify-center gap-4 py-4">
            <div className="w-16 h-[2px]" style={{ background: 'var(--accent)', opacity: 0.5 }} />
            <p className="text-xs md:text-sm tracking-widest uppercase text-engrave" style={{ color: 'var(--accent)' }}>{LANDING_CONFIG.hero.subtitle}</p>
            <div className="w-16 h-[2px]" style={{ background: 'var(--accent)', opacity: 0.5 }} />
          </div>

          <p className="text-[12px] md:text-sm tracking-widest leading-loose max-w-2xl mx-auto" style={{ color: 'var(--text-secondary)' }}>
            {LANDING_CONFIG.hero.description}
          </p>

          <div className="pt-10 flex flex-col sm:flex-row gap-4 justify-center items-center">
            <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'register' }); }} className="para-btn para-btn-primary py-4 px-10 w-full sm:w-auto shadow-[0_0_20px_var(--glow-color)]">
              <span>{LANDING_CONFIG.hero.primaryCTA}</span>
            </button>
            <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'login' }); }} className="para-btn py-4 px-10 w-full sm:w-auto">
              <span>{LANDING_CONFIG.hero.secondaryCTA}</span>
            </button>
          </div>
        </div>
      </section>

      {/* FEATURES SECTION */}
      <section id="features" className="py-24 px-6 relative" style={{ background: 'var(--surface-1)' }}>
        <div className="max-w-6xl mx-auto">
          <ScrollReveal>
            <div className="text-center mb-16">
              <div className="text-[10px] font-bold tracking-[0.3em] text-engrave mb-2" style={{ color: 'var(--accent)' }}>SYSTEM SPECS</div>
              <h2 className="text-3xl font-bold tracking-widest text-emboss uppercase" style={{ color: 'var(--text-primary)' }}>Terminal Capabilities</h2>
              <ParaDivider />
            </div>
          </ScrollReveal>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {LANDING_CONFIG.features.map((f, i) => (
              <ScrollReveal key={f.id} delay={i * 100}>
                <div className="bezel-well p-8 h-full flex flex-col hover:-translate-y-2 transition-transform duration-300 group cursor-default" style={{ background: 'var(--surface-2)' }}>
                  <div className="text-4xl mb-6 group-hover:glow-text transition-all duration-300" style={{ color: 'var(--accent)' }}>{f.icon}</div>
                  <h3 className="text-[13px] font-bold tracking-widest text-emboss uppercase mb-3" style={{ color: 'var(--text-primary)' }}>{f.title}</h3>
                  <p className="text-[11px] leading-relaxed font-story flex-1" style={{ color: 'var(--text-secondary)' }}>{f.desc}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* ABOUT US SECTION */}
      <section id="about" className="py-24 px-6 relative" style={{ background: 'var(--surface-0)' }}>
        <div className="max-w-4xl mx-auto">
          <ScrollReveal>
            <div className="bezel-frame p-8 md:p-12 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-[var(--accent)] opacity-10 blur-3xl rounded-full" />
              <div className="flex items-center gap-4 mb-8">
                <div className="bezel-led animate-led-pulse w-4 h-4" />
                <div>
                  <h2 className="text-2xl font-bold tracking-widest text-emboss uppercase" style={{ color: 'var(--text-primary)' }}>{LANDING_CONFIG.about.title}</h2>
                  <div className="text-[9px] tracking-[0.2em] font-mono mt-1" style={{ color: 'var(--accent)' }}>{LANDING_CONFIG.about.subtitle}</div>
                </div>
              </div>
              <ParaDivider />
              <div className="mt-8 text-[13px] leading-loose font-story whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                {LANDING_CONFIG.about.content}
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* PRICING SECTION */}
      <section id="pricing" className="py-24 px-6 relative" style={{ background: 'var(--surface-1)' }}>
        <div className="max-w-6xl mx-auto">
          <ScrollReveal>
            <div className="text-center mb-16">
              <div className="text-[10px] font-bold tracking-[0.3em] text-engrave mb-2" style={{ color: 'var(--accent)' }}>CLEARANCE LEVELS</div>
              <h2 className="text-3xl font-bold tracking-widest text-emboss uppercase" style={{ color: 'var(--text-primary)' }}>Subscription Plans</h2>
              <ParaDivider />
            </div>
          </ScrollReveal>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {LANDING_CONFIG.pricing.map((tier, idx) => (
              <ScrollReveal key={tier.name} delay={idx * 150} className={cn("bezel-well p-6 flex flex-col relative transition-transform duration-300 hover:scale-[1.02]", tier.recommended && "!border-[var(--accent)]")}>
                {tier.recommended && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10">
                    <div className="para-badge shadow-[0_0_10px_var(--glow-color)]" style={{ background: 'var(--accent)', color: '#000', borderColor: 'var(--accent)' }}>
                      <span className="font-bold">RECOMMENDED</span>
                    </div>
                  </div>
                )}
                <div className="text-center mb-6 pt-2">
                  <div className="text-[14px] font-bold tracking-widest uppercase text-emboss mb-2" style={{ color: 'var(--text-primary)' }}>{tier.name}</div>
                  <div className="text-[10px] h-8" style={{ color: 'var(--text-dim)' }}>{tier.desc}</div>
                  <div className="mt-4">
                    <span className="text-3xl font-bold" style={{ color: tier.recommended ? 'var(--accent)' : 'var(--text-primary)' }}>{tier.price}</span>
                    <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>/mo</span>
                  </div>
                </div>
                <ParaDivider />
                <div className="space-y-3 flex-1 my-6">
                  <div className="flex justify-between text-[10px] border-b pb-2" style={{ borderColor: 'var(--border-color)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Credits</span>
                    <span className="font-bold" style={{ color: 'var(--accent)' }}>{tier.credits}</span>
                  </div>
                  <div className="flex justify-between text-[10px] border-b pb-2" style={{ borderColor: 'var(--border-color)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Limits</span>
                    <span className="font-bold" style={{ color: 'var(--text-primary)' }}>{tier.limits}</span>
                  </div>
                  <div className="pt-4 space-y-2">
                    {tier.features.map((f, i) => (
                      <div key={i} className="text-[10px] flex items-start gap-2">
                        <span style={{ color: 'var(--accent)' }}>✓</span>
                        <span style={{ color: 'var(--text-secondary)' }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-auto pt-4">
                  <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'register' }); }} className={cn("para-btn w-full py-3", tier.recommended ? "para-btn-primary" : "")}>
                    <span>SIGN UP NOW</span>
                  </button>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ SECTION */}
      <section id="faq" className="py-24 px-6 relative" style={{ background: 'var(--surface-0)' }}>
        <div className="max-w-3xl mx-auto">
          <ScrollReveal>
            <div className="text-center mb-16">
              <div className="text-[10px] font-bold tracking-[0.3em] text-engrave mb-2" style={{ color: 'var(--accent)' }}>KNOWLEDGE BASE</div>
              <h2 className="text-3xl font-bold tracking-widest text-emboss uppercase" style={{ color: 'var(--text-primary)' }}>Frequently Asked Questions</h2>
              <ParaDivider />
            </div>
          </ScrollReveal>
          <div className="space-y-4">
            {LANDING_CONFIG.faq.map((item, i) => (
              <FAQItem key={i} q={item.q} a={item.a} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CALL TO ACTION SECTION */}
      <section className="py-24 px-6 relative text-center" style={{ background: 'var(--surface-1)' }}>
        <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'radial-gradient(var(--accent) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        <ScrollReveal>
          <h2 className="text-4xl font-bold tracking-widest text-emboss uppercase mb-6" style={{ color: 'var(--text-primary)' }}>Ready to initialize?</h2>
          <p className="text-[12px] tracking-widest mb-10 max-w-xl mx-auto" style={{ color: 'var(--text-secondary)' }}>
            Join the network and start crafting infinite realities today.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            {/* LARGE SIGN UP BUTTON */}
            <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'register' }); }} className="para-btn para-btn-primary py-4 px-10 w-full sm:w-auto shadow-[0_0_20px_var(--glow-color)] text-[12px]">
              <span>SIGN UP FOR FREE</span>
            </button>
            {/* LARGE LOGIN BUTTON */}
            <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'login' }); }} className="para-btn py-4 px-10 w-full sm:w-auto text-[12px]">
              <span>LOG IN TO TERMINAL</span>
            </button>
          </div>
        </ScrollReveal>
      </section>

      {/* FOOTER */}
      <footer className="bezel-toolbar py-8 px-6 text-center border-t" style={{ borderColor: 'var(--border-color)' }}>
        <div className="text-[10px] font-mono tracking-widest text-engrave flex flex-col sm:flex-row items-center justify-center gap-4" style={{ color: 'var(--text-dim)' }}>
          <span>© {new Date().getFullYear()} CRISTOL TERMINAL. ALL RIGHTS RESERVED.</span>
          <span className="hidden sm:inline">|</span>
          <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="hover:text-[var(--accent)] transition-colors">RETURN TO TOP ↑</button>
        </div>
      </footer>
    </div>
  );
}

function AuthPage() {
  const { state, dispatch } = useApp();
  const[email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showTosStep, setShowTosStep] = useState(false);
  const [otp, setOtp] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const[phoneStep, setPhoneStep] = useState<'collect' | 'verify'>('collect');
  const[turnstileToken, setTurnstileToken] = useState('');
  const[notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const[loading, setLoading] = useState(false);
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetRef = useRef<string | number | null>(null);
  const isHostedFreeTierBlocked = !!(state.userProfile?.next_step === 'blocked' || state.userProfile?.free_grant_status?.startsWith('blocked_'));
  const needsTurnstile = !!(TURNSTILE_SITE_KEY && state.authMode !== 'verify' && !(state.authMode === 'phone' && phoneStep === 'verify'));

  const routeAfterAuth = useCallback((result: any) => {
    if (result?.token) dispatch({ type: 'SET_TOKEN', payload: result.token });
    else dispatch({ type: 'SET_TOKEN', payload: api.getToken() });
    if (result?.profile) dispatch({ type: 'SET_USER_PROFILE', payload: result.profile });
    const nextStep = result?.next_step || result?.profile?.next_step;
    const skippedPhone = sessionStorage.getItem('cristol_skipped_phone') === 'true';
    if (nextStep === 'phone_verify' && !skippedPhone) {
      setNotice(result?.message || 'Verify your phone number to unlock hosted credits.');
      dispatch({ type: 'SET_VIEW', payload: 'auth' });
      dispatch({ type: 'SET_AUTH_MODE', payload: 'phone' });
      return;
    }
    if (nextStep === 'blocked') {
      setNotice(result?.message || 'Hosted free-tier access is blocked on this account. Upgrade to continue.');
      dispatch({ type: 'SET_VIEW', payload: 'auth' });
      dispatch({ type: 'SET_AUTH_MODE', payload: 'phone' });
      return;
    }
    dispatch({ type: 'SET_VIEW', payload: state.sharedId ? 'shared' : 'app' });
  },[dispatch, state.sharedId]);

  useEffect(() => {
    setError('');
    if (state.authMode !== 'phone') setNotice('');
    if (state.authMode !== 'phone') {
      setPhoneStep('collect');
      setPhoneCode('');
    }
    setShowTosStep(false);
    if (state.userProfile?.masked_phone && state.authMode === 'phone') setNotice(prev => prev || `Current account phone: ${state.userProfile?.masked_phone}`);
  },[state.authMode, state.userProfile?.masked_phone]);

  useEffect(() => {
    if (state.authMode === 'verify' || state.authMode === 'phone' || !GOOGLE_CLIENT_ID) return;
    const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true; script.defer = true; document.head.appendChild(script);
    script.onload = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: async (res: any) => {
            setLoading(true);
            setError('');
            try {
              if (TURNSTILE_SITE_KEY && !turnstileToken) throw new Error('COMPLETE THE ANTI-BOT CHECK FIRST');
              const authResult = await api.googleAuth(res.credential, turnstileToken);
              routeAfterAuth(authResult);
            } catch (err: any) {
              setError(err.message || 'Google Auth Failed');
            } finally {
              setLoading(false);
              if (turnstileWidgetRef.current !== null && window.turnstile) window.turnstile.reset(turnstileWidgetRef.current);
              setTurnstileToken('');
            }
          }
        });
        const container = document.getElementById('google-btn-container');
        if (container) {
          container.innerHTML = '';
          window.google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', width: '300', text: 'continue_with' });
        }
      }
    };
    return () => { if (document.head.contains(script)) document.head.removeChild(script); };
  },[routeAfterAuth, state.authMode, turnstileToken]);

  useEffect(() => {
    if (!needsTurnstile) return;
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true; script.defer = true; document.head.appendChild(script);
    script.onload = () => {
      if (window.turnstile && turnstileRef.current) {
        turnstileRef.current.innerHTML = '';
        turnstileWidgetRef.current = window.turnstile.render(turnstileRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token: string) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
        });
      }
    };
    return () => {
      if (turnstileWidgetRef.current !== null && window.turnstile) window.turnstile.remove(turnstileWidgetRef.current);
      turnstileWidgetRef.current = null;
      if (document.head.contains(script)) document.head.removeChild(script);
    };
  }, [needsTurnstile, state.authMode, phoneStep]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');

    // Intercept register to show ToS document first
    if (state.authMode === 'register' && !showTosStep) {
      if (!email.trim()) { setError('EMAIL IS REQUIRED'); return; }
      if (!password.trim()) { setError('PASSCODE IS REQUIRED'); return; }
      if (password !== confirmPassword) { setError('PASSWORDS DO NOT MATCH'); return; }
      setShowTosStep(true);
      return;
    }

    setLoading(true);
    try {
      if (state.authMode !== 'verify' && state.authMode !== 'register') {
        if (!email.trim()) { setError('EMAIL IS REQUIRED'); setLoading(false); return; }
        if (!password.trim()) { setError('PASSCODE IS REQUIRED'); setLoading(false); return; }
      }
      if (state.authMode === 'verify' && !otp.trim()) {
        setError('6-DIGIT CODE IS REQUIRED'); setLoading(false); return;
      }

      if (state.authMode === 'verify') {
        const result = await api.verifyEmail(email, otp);
        routeAfterAuth(result);
      } else if (state.authMode === 'login') {
        const result = await api.login(email, password, turnstileToken);
        routeAfterAuth(result);
      } else if (state.authMode === 'register') {
        if (TURNSTILE_SITE_KEY && !turnstileToken) throw new Error('COMPLETE THE ANTI-BOT CHECK FIRST');
        // Automatically passes true because clicking the agree button submitted the form
        const result = await api.register(email, password, turnstileToken, true);
        if (result.require_verification) {
          setNotice(result.message || 'Verification code sent.');
          dispatch({ type: 'SET_AUTH_MODE', payload: 'verify' });
        } else {
          routeAfterAuth(result);
        }
      }
    } catch (err: any) {
      if (err.message === 'unverified' || err.payload?.require_verification) {
        setNotice(err.payload?.message || 'Check your email for the verification code.');
        dispatch({ type: 'SET_AUTH_MODE', payload: 'verify' });
      } else setError(err.message || 'Authentication Failed');
    } finally {
      setLoading(false);
      if (turnstileWidgetRef.current !== null && window.turnstile) window.turnstile.reset(turnstileWidgetRef.current);
      setTurnstileToken('');
    }
  };

  const handleResend = async () => {
    setLoading(true); setError(''); setNotice('');
    try {
      await api.resendCode(email);
      setNotice('A new verification code has been sent.');
    } catch (err: any) {
      setError(err.message || 'Failed to resend code');
    } finally {
      setLoading(false);
    }
  };

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isHostedFreeTierBlocked) return;
    setError('');
    setNotice('');
    setLoading(true);
    try {
      if (phoneStep === 'collect') {
        if (!phoneNumber.trim()) { setError('PHONE NUMBER IS REQUIRED'); setLoading(false); return; }
        if (TURNSTILE_SITE_KEY && !turnstileToken) throw new Error('COMPLETE THE ANTI-BOT CHECK FIRST');
        await api.phoneStart(phoneNumber, turnstileToken);
        setPhoneStep('verify');
      } else {
      if (!phoneCode.trim()) { setError('SMS CODE IS REQUIRED'); setLoading(false); return; }
        const result = await api.phoneVerify(phoneNumber, phoneCode);
        if (result.profile) dispatch({ type: 'SET_USER_PROFILE', payload: result.profile });
        if (result.message) setNotice(result.message);
        routeAfterAuth(result);
      }
    } catch (err: any) {
      setError(err.message || 'Phone verification failed');
    } finally {
      setLoading(false);
      if (turnstileWidgetRef.current !== null && window.turnstile && phoneStep === 'collect') window.turnstile.reset(turnstileWidgetRef.current);
      if (phoneStep === 'collect') setTurnstileToken('');
    }
  };

  const title = state.authMode === 'verify' ? 'VERIFY IDENTITY' : state.authMode === 'phone' ? (isHostedFreeTierBlocked ? 'ACCOUNT LIMITED' : 'VERIFY PHONE') : state.authMode === 'login' ? 'LOGIN' : (showTosStep ? 'TERMS OF SERVICE' : 'REGISTER');

  return (
    <div className="flex items-center justify-center h-full w-full p-4" style={{ background: 'var(--surface-1)' }}>
      <div className={cn("w-full bezel-frame p-8 animate-fade-in-scale space-y-6 font-mono flex flex-col transition-all duration-300", (state.authMode === 'register' && showTosStep) ? "max-w-2xl max-h-[95vh]" : "max-w-sm")} style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <div className="flex justify-between items-center shrink-0">
          <div className="flex items-center gap-2">
            <div className="bezel-led animate-led-pulse" />
            <h2 className="text-lg font-bold tracking-widest text-emboss uppercase">{title}</h2>
          </div>
          <button onClick={() => {
            if (state.authMode === 'verify') {
              dispatch({ type: 'SET_AUTH_MODE', payload: 'login' });
            } else if (state.authMode === 'phone') {
              sessionStorage.setItem('cristol_skipped_phone', 'true');
              dispatch({ type: 'SET_VIEW', payload: state.sharedId ? 'shared' : 'app' });
            } else {
              dispatch({ type: 'SET_VIEW', payload: state.sharedId ? 'shared' : 'home' });
            }
          }} className="close-btn"><CloseIcon size={12} /></button>
        </div>
        {state.authMode === 'phone' ? (
          <form onSubmit={handlePhoneSubmit} className="space-y-4">
            {!isHostedFreeTierBlocked ? (
              <>
                <div>
                  <label className="text-[10px] font-bold tracking-widest uppercase text-engrave block mb-1" style={{ color: 'var(--text-dim)' }}>Phone Number</label>
                  <input type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} maxLength={20} className="input-field w-full font-mono" placeholder="+1 555 123 4567" disabled={phoneStep === 'verify'} />
                </div>
                {phoneStep === 'verify' && (
              <div>
                <label className="text-[10px] font-bold tracking-widest uppercase text-engrave block mb-1" style={{ color: 'var(--text-dim)' }}>SMS Code</label>
                <input type="text" value={phoneCode} onChange={e => setPhoneCode(e.target.value)} className="input-field w-full text-center tracking-[0.5em] text-lg font-mono" placeholder="••••••" maxLength={8} />
              </div>
            )}
                {needsTurnstile && phoneStep === 'collect' && <div ref={turnstileRef} className="flex justify-center min-h-[66px]" />}
                <div className="upgrade-prompt p-3 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
              Free-tier hosted credits require phone verification to prevent abuse.
            </div>
              </>
            ) : (
              <div className="upgrade-prompt p-3 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                This account can sign in, but hosted free-tier credits are blocked. Upgrade to a paid plan to continue.
              </div>
            )}
            {notice && <div className="text-[10px] font-bold" style={{ color: '#22c55e' }}>{notice}</div>}
            {error && <div className="text-red-500 text-[10px] font-bold animate-blink">{error}</div>}
            {!isHostedFreeTierBlocked && (
              <>
                <button type="submit" disabled={loading} className="para-btn para-btn-primary w-full py-3"><span>{loading ? 'PROCESSING...' : phoneStep === 'collect' ? 'SEND CODE' : 'VERIFY PHONE'}</span></button>
                {phoneStep === 'verify' && <button type="button" onClick={() => { setPhoneStep('collect'); setTurnstileToken(''); }} className="para-btn w-full py-3"><span>CHANGE NUMBER</span></button>}
              </>
            )}
            <ParaDivider />
            <div className="space-y-2">
              <button type="button" onClick={() => {
                sessionStorage.setItem('cristol_skipped_phone', 'true');
                dispatch({ type: 'SET_VIEW', payload: state.sharedId ? 'shared' : 'app' });
              }} className="para-btn w-full py-3"><span>SKIP FOR NOW</span></button>
            </div>
            <div className="text-center mt-2"><button type="button" onClick={async () => { await api.logout(); dispatch({ type: 'SET_TOKEN', payload: null }); dispatch({ type: 'SET_USER_PROFILE', payload: null }); dispatch({ type: 'SET_AUTH_MODE', payload: 'login' }); dispatch({ type: 'SET_VIEW', payload: state.sharedId ? 'shared' : 'home' }); }} className="text-[10px] tracking-widest hover:text-white transition-colors" style={{ color: 'var(--text-dim)' }}>LOG OUT</button></div>
          </form>
        ) : (
          <>
            <form noValidate onSubmit={handleSubmit} className="space-y-4">
              {state.authMode === 'verify' ? (
                <div>
                  <label className="text-[10px] font-bold tracking-widest uppercase text-engrave block mb-1" style={{ color: 'var(--text-dim)' }}>6-Digit Code</label>
                  <div className="text-[9px] mb-2" style={{ color: 'var(--text-secondary)' }}>Sent to {email}</div>
                  <input type="text" value={otp} onChange={e => setOtp(e.target.value)} className="input-field w-full text-center tracking-[0.5em] text-lg font-mono" placeholder="••••••" maxLength={6} />
                </div>
              ) : state.authMode === 'register' && showTosStep ? (
                <div className="animate-fade-in flex flex-col min-h-0 flex-1">
                  <div className="bezel-well p-6 overflow-y-auto custom-scrollbar text-xs font-story leading-relaxed space-y-4" style={{ color: 'var(--text-secondary)', background: 'var(--surface-0)', maxHeight: '55vh' }}>
                    <p><strong>TODO</strong></p>
                  </div>
                </div>
              ) : (
                <>
                  <div><label className="text-[10px] font-bold tracking-widest uppercase text-engrave block mb-1" style={{ color: 'var(--text-dim)' }}>Email</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={120} className="input-field w-full font-mono" placeholder="user@domain.com" /></div>
                  <div><label className="text-[10px] font-bold tracking-widest uppercase text-engrave block mb-1" style={{ color: 'var(--text-dim)' }}>Passcode</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} maxLength={128} className="input-field w-full font-mono" placeholder="••••••••" /></div>
                  {state.authMode === 'register' && (<div><label className="text-[10px] font-bold tracking-widest uppercase text-engrave block mb-1" style={{ color: 'var(--text-dim)' }}>Confirm Passcode</label><input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} maxLength={128} className="input-field w-full font-mono" placeholder="••••••••" /></div>)}
                </>
              )}

              {/* Turnstile stays outside the condition so it doesn't unmount, just hides during ToS */}
              {needsTurnstile && state.authMode !== 'verify' && <div ref={turnstileRef} className={cn("flex justify-center", (state.authMode === 'register' && showTosStep) ? "hidden" : "min-h-[66px]")} />}

              {notice && <div className="text-[10px] font-bold" style={{ color: '#22c55e' }}>{notice}</div>}
              {error && <div className="text-red-500 text-[10px] font-bold animate-blink">{error}</div>}
              
              {state.authMode === 'register' && showTosStep ? (
                <div className="flex flex-col gap-3 mt-6 shrink-0">
                  <button type="submit" disabled={loading} className={cn("para-btn para-btn-primary w-full py-4", loading && "opacity-50")} style={{ height: 'auto' }}>
                    <span className="whitespace-normal leading-tight text-[11px] font-bold px-4">
                      {loading ? 'PROCESSING...' : 'I CONFIRM THAT I HAVE READ AND AGREE TO THE TERMS OF SERVICE'}
                    </span>
                  </button>
                  <button type="button" onClick={() => setShowTosStep(false)} disabled={loading} className="text-[10px] tracking-widest hover:text-[var(--text-primary)] transition-colors mt-2 text-center w-full focus:outline-none" style={{ color: 'var(--text-dim)' }}>
                    GO BACK
                  </button>
                </div>
              ) : (
                <button type="submit" disabled={loading} className="para-btn para-btn-primary w-full py-3 mt-4">
                  <span>{loading ? 'PROCESSING...' : (state.authMode === 'verify' ? 'VERIFY & CONTINUE' : (state.authMode === 'login' ? 'LOGIN' : 'CONTINUE'))}</span>
                </button>
              )}

              {state.authMode === 'verify' && (
                <div className="text-center mt-2">
                  <button type="button" onClick={handleResend} disabled={loading} className="text-[10px] tracking-widest hover:text-white transition-colors" style={{ color: 'var(--text-dim)' }}>
                    DIDN'T GET A CODE? RESEND
                  </button>
                </div>
              )}
            </form>

            {/* MOVED HIGHER: Login / Register Toggle */}
            {!(state.authMode === 'register' && showTosStep) && (
              <div className="text-center mt-2 mb-2">
                <button type="button" onClick={() => { setError(''); setNotice(''); dispatch({ type: 'SET_AUTH_MODE', payload: state.authMode === 'login' ? 'register' : 'login' }); }} className="text-[10px] tracking-widest hover:text-white transition-colors" style={{ color: 'var(--text-dim)' }}>
                  {state.authMode === 'login' ? 'NEED AN ACCOUNT? REGISTER' : (state.authMode === 'register' ? 'ALREADY HAVE AN ACCOUNT? LOGIN' : 'BACK TO LOGIN')}
                </button>
              </div>
            )}

            {/* Google Auth Block */}
            {state.authMode !== 'verify' && GOOGLE_CLIENT_ID && !(state.authMode === 'register' && showTosStep) && (
              <div className="mt-6 space-y-4">
                <div className="flex items-center gap-2 opacity-50">
                  <div className="flex-1 h-px bg-current"></div>
                  <span className="text-[10px] uppercase font-bold tracking-widest">OR</span>
                  <div className="flex-1 h-px bg-current"></div>
                </div>
                <div className="flex justify-center w-full min-h-[40px]" id="google-btn-container"></div>
                {state.authMode === 'register' && (
                  <div className="text-[8px] text-center tracking-widest" style={{ color: 'var(--text-dim)' }}>
                    BY CONTINUING WITH GOOGLE, YOU AGREE TO OUR TERMS OF SERVICE
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Sidebar() {
  const { state, dispatch } = useApp();
  const [view, setView] = useState<'play' | 'shows'>('play');
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; action: () => void; } | null>(null);
  const[showSubscription, setShowSubscription] = useState(false);
  const maxInstances = state.userProfile?.tier_config?.max_instances || 1;
  const currentInstances = state.instances.filter((i: any) => !i.is_archived).length;
  const canCreateInstance = currentInstances < maxInstances;
  return (
    <>
      <SubscriptionModal isOpen={showSubscription} onClose={() => setShowSubscription(false)} />
      <ConfirmModal isOpen={!!confirmState} title={confirmState?.title || ''} message={confirmState?.message || ''} confirmText="DELETE" isDanger onConfirm={() => confirmState?.action()} onCancel={() => setConfirmState(null)} />
      <div id="tour-sidebar" className="w-72 h-full flex flex-col z-10 relative bezel-raised" style={{ borderRight: '2px solid rgba(0,0,0,0.5)' }}>
        <div className="bezel-toolbar p-4 para-header"><div className="flex items-center gap-3 relative z-10"><div className="bezel-frame w-9 h-9 flex items-center justify-center"><span className="text-sm font-bold glow-text-strong" style={{ color: 'var(--accent)' }}>◈</span></div><div><div className="text-sm font-bold tracking-wider text-emboss" style={{ color: 'var(--text-primary)' }}>CRISTOL</div><div className="text-[8px] tracking-[0.2em] font-mono" style={{ color: 'var(--text-dim)' }}>CRISTOL TERMINAL v1.0 - BETA TESTING</div></div></div></div><div className="flex p-2 gap-1" style={{ background: 'var(--surface-2)', borderBottom: '1px solid rgba(0,0,0,0.4)' }}><button onClick={() => setView('play')} className={cn("para-tab flex-1", view === 'play' && "para-tab-active")}><span>SAVES</span></button><button id="tour-blueprints-tab" onClick={() => setView('shows')} className={cn("para-tab flex-1", view === 'shows' && "para-tab-active")}><span>BLUEPRINTS</span></button></div>
        <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar" style={{ background: 'var(--surface-1)' }}>
          <div className="bezel-well p-2 space-y-2 h-full">
            {view === 'play' && (<>
              <div className="text-[9px] font-mono px-2 py-1" style={{ color: 'var(--text-dim)' }}>{currentInstances}/{maxInstances} saves used</div>
              {state.instances.length === 0 && (<div className="text-center mt-12" style={{ color: 'var(--text-dim)' }}><div className="text-2xl opacity-30 mb-2">◇</div><div className="text-[11px] text-engrave">No active games</div></div>)}
              {state.instances.map(inst => {
                const isActive = state.currentInstance?.id === inst.id; const isArchived = inst.is_archived; const epCount = inst.episodes.length; const currentIdx = inst.currentEpisodeIndex;
                return (
                  <div key={inst.id} className="mb-2">
                    <div onClick={() => dispatch({ type: 'SET_CURRENT_INSTANCE', payload: inst })} className={cn("card p-3 group relative overflow-hidden cursor-pointer", isActive && "card-active", isArchived && "opacity-60 border-dashed")}>
                      <div className="para-stripe" />
                      <div className="flex items-start justify-between relative z-10">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2"><div className="text-[12px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{inst.showName}</div>{isArchived && (<div className="para-badge" style={{ background: 'rgba(245, 158, 11, 0.2)', color: '#f59e0b', fontSize: '7px' }}><span>ARCHIVED</span></div>)}</div>
                          <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>{currentIdx >= epCount ? (<div className="para-badge-glow para-badge"><span>COMPLETE</span></div>) : (`Ep ${currentIdx + 1}: ${inst.episodes[currentIdx]?.name}`)}</div>
                          {currentIdx < epCount && (<div className="mt-2"><ParaProgress current={currentIdx + 1} total={epCount} /></div>)}
                          <div className="text-[9px] font-mono mt-1" style={{ color: 'var(--text-dim)' }}>{inst.lastPlayed ? new Date(inst.lastPlayed).toLocaleDateString() : 'Unknown Date'}</div>
                        </div>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity"><CloseButton onClick={(e) => { e.stopPropagation(); setConfirmState({ title: isArchived ? 'DELETE ARCHIVED SAVE' : 'DELETE SAVE', message: `Delete "${inst.showName}"?`, action: async () => { await api.deleteInstance(inst.id); dispatch({ type: 'REMOVE_INSTANCE', payload: inst.id }); } }); }} /></div>
                      </div>
                    </div>
                    {isArchived && (<button onClick={async (e) => { e.stopPropagation(); try { await api.unarchiveInstance(inst.id); const res = await api.getInstances(); dispatch({ type: 'SET_INSTANCES', payload: res }); } catch (err: any) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'LIMIT REACHED', message: err.message } }); } }} className="para-btn para-btn-sm w-full mt-1" style={{ borderColor: '#f59e0b', color: '#f59e0b' }}><span>UNARCHIVE & RESTORE</span></button>)}
                  </div>
                );
              })}
            </>)}
            {view === 'shows' && (<>
              {/* Add the ID here! ↓ */}
              <button id="tour-new-blueprint-btn" onClick={() => dispatch({ type: 'SET_EDITING_SHOW', payload: null })} className="para-btn w-full py-3 mb-1" style={{ color: 'var(--accent)' }}><span>+ NEW BLUEPRINT</span></button>
              {state.shows.map((show, index) => (<div key={show.id} className="card p-3 group relative overflow-hidden"><div className="para-stripe" /><div className="flex items-start justify-between relative z-10"><div className="flex-1 min-w-0"><div className="text-[12px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{show.name}</div><div className="text-[9px] font-mono mt-1" style={{ color: 'var(--text-dim)' }}>{show.episodes.length} chapters</div></div><div className="opacity-0 group-hover:opacity-100 transition-opacity"><CloseButton onClick={(e) => { e.stopPropagation(); setConfirmState({ title: 'DELETE BLUEPRINT', message: `Delete "${show.name}"?`, action: async () => { await api.deleteShow(show.id); dispatch({ type: 'REMOVE_SHOW', payload: show.id }); } }); }} /></div></div><div className="flex gap-1.5 mt-3 relative z-10"><button onClick={() => dispatch({ type: 'SET_EDITING_SHOW', payload: show })} className="para-btn para-btn-sm flex-1"><span>EDIT</span></button><button id={index === state.shows.length - 1 ? "tour-play-btn" : undefined} onClick={async () => { if (!canCreateInstance) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'INSTANCE LIMIT', message: `Your tier allows ${maxInstances} active games.` } }); return; } try { const i = await api.createInstance(show.id); dispatch({ type: 'ADD_INSTANCE', payload: i }); dispatch({ type: 'SET_CURRENT_INSTANCE', payload: i }); setView('play'); } catch (err: any) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'INSTANCE LIMIT', message: err.message } }); } }} className={cn("para-btn para-btn-sm para-btn-primary flex-1", !canCreateInstance && "opacity-50")}><span>PLAY</span></button></div></div>))}
            </>)}
          </div>
        </div>
        <div className="bezel-statusbar px-3 py-2 flex items-center gap-2">
          <div className="bezel-led animate-led-pulse" />
          <span className="text-[8px] font-mono tracking-widest" style={{ color: 'var(--text-dim)' }}>{TEST_MODE ? 'TEST MODE' : 'ONLINE'}</span>
          <div className="flex-1" />
          <TierBadge tier={state.userProfile?.subscription_tier || 'Free'} trial={state.userProfile?.is_in_plus_trial} clickable onClick={() => setShowSubscription(true)} />
        </div>
      </div>
    </>
  );
}

function ChatArea() {
  const { state, dispatch } = useApp();
  const [input, setInput] = useState('');
  const [chunkNavOpen, setChunkNavOpen] = useState(false);
  const [pickerPayload, setPickerPayload] = useState<ChunkSelectionPayload | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string>('');
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const chunkMode = state.settings.chunkSelectionMode;
  const isChunkMode = true;

  useEffect(() => {
    if (state.currentInstance && !state.isGenerating) {
      const savedDraft = localStorage.getItem('chat_draft_' + state.currentInstance.id);
      if (savedDraft) setInput(savedDraft); else setInput('');
    }
  },[state.currentInstance?.id]);

  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => {
    if (!state.currentInstance) return;
    const interval = setInterval(() => { if (inputRef.current !== undefined) localStorage.setItem('chat_draft_' + state.currentInstance!.id, inputRef.current); }, 3 * 60 * 1000);
    return () => clearInterval(interval);
  }, [state.currentInstance?.id]);

  const onScroll = useCallback(() => { if (ref.current) { const { scrollTop, scrollHeight, clientHeight } = ref.current; atBottom.current = scrollHeight - scrollTop - clientHeight < 10; } },[]);
  useLayoutEffect(() => { if (atBottom.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; },[state.messages, state.streamingText, state.streamingReasoning]);

  const refreshProfile = useCallback(async () => { try { const p = await api.getMe(); dispatch({ type: 'SET_USER_PROFILE', payload: p }); } catch {} }, [dispatch]);
  const isOwner = state.currentInstance?.is_owner !== false;
  const sharing = state.currentInstance?.sharing || 'private';
  const isArchived = state.currentInstance?.is_archived;
  const canChat = isOwner || sharing === 'full';

  const sendToAPI = useCallback(async (msg: string, forceChunk?: number) => {
    dispatch({ type: 'SET_GENERATING', payload: true });
    dispatch({ type: 'SET_STREAMING_TEXT', payload: '' });
    dispatch({ type: 'SET_STREAMING_REASONING', payload: '' });
    dispatch({ type: 'SET_STREAMING_META', payload: null });
    const currentInstanceId = state.currentInstance?.id;
    let full = ''; let fullReasoning = '';
    let finalMeta: any = null;
    try {
      for await (const chunk of api.chat({
        message: msg, model: state.settings.model,
        instanceId: state.currentInstance?.id || '',
        chunkMode, forceChunk,
      })) {
        if (chunk.type === 'chunk_selection') {
          dispatch({ type: 'SET_GENERATING', payload: false });
          dispatch({ type: 'SET_STREAMING_TEXT', payload: '' });
          dispatch({ type: 'SET_STREAMING_REASONING', payload: '' });
          setPendingMessage(msg);
          setPickerPayload(chunk.data as ChunkSelectionPayload);
          return;
        }
        if (chunk.type === 'meta') {
          finalMeta = { ...finalMeta, ...chunk.data };
          if (chunk.data.creditsRemaining !== undefined) {
            dispatch({ type: 'SET_USER_PROFILE', payload: { ...state.userProfile, credits: chunk.data.creditsRemaining } as UserProfile });
          }
          if (chunk.data.selectedChunk !== undefined || chunk.data.mode) {
            dispatch({ type: 'SET_STREAMING_META', payload: { selectedChunk: chunk.data.selectedChunk, totalChunks: chunk.data.totalChunks, mode: chunk.data.mode, selectionReason: chunk.data.selectionReason } });
          }
        } else if (chunk.type === 'reasoning') { fullReasoning += chunk.data; dispatch({ type: 'SET_STREAMING_REASONING', payload: fullReasoning }); }
        else if (chunk.type === 'token') { full += chunk.data; dispatch({ type: 'SET_STREAMING_TEXT', payload: full }); }
        else if (chunk.type === 'error') throw new Error(chunk.data);
      }
      
      const newMsg = { id: Date.now().toString() + Math.random().toString().slice(2), role: 'ai' as const, content: full, reasoning: fullReasoning, meta: finalMeta };
        dispatch({ type: 'ADD_MESSAGE', payload: newMsg });
        refreshProfile();

      if (currentInstanceId) {
        api.getInstances().then(instances => {
          dispatch({ type: 'SET_INSTANCES', payload: instances });
          const serverInst = instances.find(i => i.id === currentInstanceId);
          if (serverInst) {
            const preserveChunk = chunkMode === 'manual';
            const merged: Instance = preserveChunk
              ? { ...serverInst, current_chunk_id: state.currentInstance?.current_chunk_id ?? serverInst.current_chunk_id }
              : serverInst;
            dispatch({ type: 'SET_CURRENT_INSTANCE', payload: merged });
          }
        }).catch(() => {});
      }
    } catch (e: any) {
      if (e.message?.includes('insufficient_credits') || e.message?.includes('Insufficient credits')) {
        dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'INSUFFICIENT CREDITS', message: 'You have run out of credits.', showCredits: true } });
      } else if (e.name === 'AbortError') {
        const stoppedMsg = { id: Date.now().toString() + Math.random().toString().slice(2), role: 'ai' as const, content: full + (full ? "" : ""), reasoning: fullReasoning, meta: finalMeta };
        dispatch({ type: 'ADD_MESSAGE', payload: stoppedMsg });
        refreshProfile();
      } else if (e.name === 'TypeError' || e.message?.includes('fetch') || e.message?.includes('network')) {
        dispatch({ type: 'ADD_MESSAGE', payload: { id: Date.now().toString() + Math.random().toString().slice(2), role: 'ai', content: (full ? full + "\n\n" : "") + "[⚠ NETWORK DISCONNECTED - STREAM HALTED]", meta: finalMeta } });
      } else {
        dispatch({ type: 'ADD_MESSAGE', payload: { id: Date.now().toString() + Math.random().toString().slice(2), role: 'ai', content: `[Error: ${e.message || 'Backend unreachable.'}]`, meta: finalMeta } });
      }
    }
    dispatch({ type: 'SET_STREAMING_TEXT', payload: '' });
    dispatch({ type: 'SET_STREAMING_REASONING', payload: '' });
    dispatch({ type: 'SET_GENERATING', payload: false });
  },[dispatch, state.currentInstance, state.settings.model, refreshProfile, chunkMode]);

  const handlePickerConfirm = useCallback((chunkIndex: number) => {
    setPickerPayload(null);
    const msg = pendingMessage;
    setPendingMessage('');
    setTimeout(() => sendToAPI(msg, chunkIndex), 0);
  }, [pendingMessage, sendToAPI]);

  const handlePickerCancel = useCallback(() => {
    setPickerPayload(null);
    setPendingMessage('');
  },[]);

  const handleRegenerate = useCallback(async (id: string) => {
    if (state.isGenerating || !state.currentInstance || !canChat || isArchived) return;
    const idx = state.messages.findIndex(m => m.id === id); if (idx === -1) return;
    const msg = state.messages[idx];
    
    let cutIndex: number;
    if (msg.role === 'ai' || msg.role === 'assistant') {
      cutIndex = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (state.messages[i].role === 'user') {
          cutIndex = i;
          break;
        }
      }
      if (cutIndex === -1) return;
    } else {
      cutIndex = idx;
    }
    
    const nm = state.messages.slice(0, cutIndex + 1);
    const lum = state.messages[cutIndex].content;
    
    const isManual = state.settings.chunkSelectionMode === 'manual';
    const currentChunkId = state.currentInstance.current_chunk_id;
    
    dispatch({ type: 'SET_MESSAGES', payload: nm });
    if (state.currentInstance.is_owner !== false) {
        try {
          await api.updateInstance(state.currentInstance.id, { 
              messages: nm,
              current_chunk_id: currentChunkId
          });
        } catch {}
    }
    setTimeout(() => sendToAPI(lum, isManual ? currentChunkId : undefined), 0);
  },[state.isGenerating, state.currentInstance, state.messages, dispatch, sendToAPI, canChat, isArchived, state.settings.chunkSelectionMode]);

  const handleBranch = async (id: string) => {
    if (!state.userProfile?.tier_config.branches) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'PRO FEATURE', message: 'Instance branching requires Pro tier.' } }); return; }
    try { const newInst = await api.branchInstance(state.currentInstance!.id, id); dispatch({ type: 'ADD_INSTANCE', payload: newInst }); dispatch({ type: 'SET_CURRENT_INSTANCE', payload: newInst }); }
    catch (e: any) { if (e.message?.includes('Maximum')) dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'LIMIT REACHED', message: e.message } }); else alert(e.message || 'Failed to branch'); }
  };

  const handleSend = () => {
    if (!input.trim() || state.isGenerating || !state.currentInstance || !canChat || isArchived) return;
    atBottom.current = true; const m = input.trim();
    localStorage.removeItem('chat_draft_' + state.currentInstance.id);
    setInput('');
    dispatch({ type: 'ADD_MESSAGE', payload: { id: Date.now().toString() + Math.random().toString().slice(2), role: 'user', content: m } });
    const isManual = state.settings.chunkSelectionMode === 'manual';
    const currentChunkId = state.currentInstance.current_chunk_id;
    setTimeout(() => sendToAPI(m, isManual ? currentChunkId : undefined), 0);
  };

  const ep = state.currentInstance ? state.currentInstance.episodes[state.currentInstance.currentEpisodeIndex] : null;
  const done = state.currentInstance && !ep;
  const sm = state.streamingMeta;
  const showChunkInfo = isChunkMode && sm && sm.selectedChunk !== undefined;

  return (
    <div id="tour-chat-area" className="flex-1 flex flex-col h-full overflow-hidden relative" style={{ background: 'var(--surface-1)' }}>
      {chunkNavOpen && (
        <ChunkNavigatorPanel isOpen onClose={() => setChunkNavOpen(false)} />
      )}
      {pickerPayload && (
        <ChunkPickerPanel
          isOpen
          payload={pickerPayload}
          onConfirm={handlePickerConfirm}
          onCancel={handlePickerCancel}
        />
      )}

      {state.currentInstance && (
        <div className="bezel-toolbar px-5 py-2.5 flex justify-between items-center select-none shrink-0">
          <div className="flex items-center gap-3">
            <div className="bezel-led animate-led-pulse" />
            <div className="para-badge"><span>INSTANCE</span></div>
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{state.currentInstance.showName}</span>
            {!isOwner && <div className="para-badge" style={{ background: '#06b6d4', color: '#000' }}><span>SHARED VIEW</span></div>}
          </div>
          <div className="flex items-center gap-3">
            <ChunkModeBadge mode={chunkMode} />
            {showChunkInfo && (<div className="para-badge" style={{ borderColor: '#f59e0b', color: '#f59e0b' }}><span>CHUNK {sm.selectedChunk! + 1}/{sm.totalChunks}</span></div>)}
            <div className="para-badge"><span>EPISODE</span></div>
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{ep ? ep.name : <span className="para-badge-glow para-badge"><span>COMPLETE</span></span>}</span>
            {ep && <div className="w-24"><ParaProgress current={state.currentInstance.currentEpisodeIndex + 1} total={state.currentInstance.episodes.length} /></div>}
            <ExportButton instanceId={state.currentInstance.id} />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-hidden p-3">
        <div ref={ref} onScroll={onScroll} className="bezel-well h-full overflow-y-auto custom-scrollbar">
          {!state.currentInstance ? (<div className="h-full flex flex-col items-center justify-center"><div className="text-center space-y-4"><div className="text-4xl glow-text-strong" style={{ color: 'var(--accent)' }}>◈</div><div className="text-lg font-bold tracking-[0.2em] text-emboss" style={{ color: 'var(--text-primary)' }}>CRISTOL</div><ParaDivider /><div className="text-[10px] tracking-widest text-engrave" style={{ color: 'var(--text-dim)' }}>SELECT OR START A CAMPAIGN</div></div></div>)
            : done ? (<div className="h-full flex flex-col items-center justify-center"><div className="text-center space-y-3"><div className="text-4xl glow-text-strong" style={{ color: '#22c55e' }}>✦</div><div className="text-xl font-bold text-emboss" style={{ color: '#22c55e' }}>COMPLETE</div><ParaDivider /><div className="text-sm" style={{ color: 'var(--text-muted)' }}>Journey finished.</div></div></div>)
            : state.messages.length === 0 && !state.isGenerating ? (<div className="p-10 text-center mt-10 animate-fade-in"><div className="text-base mb-4 font-bold tracking-wider glow-text" style={{ color: 'var(--accent)' }}>{ep?.name}</div><ParaDivider /><div className="italic max-w-lg mx-auto leading-relaxed text-sm mt-4 font-story" style={{ color: 'var(--text-secondary)' }}>{ep?.context}</div><div className="mt-8 flex flex-col items-center justify-center gap-4"><div className="flex items-center gap-2"><div className="bezel-led animate-led-pulse" /><span className="text-[10px] tracking-widest" style={{ color: 'var(--text-dim)' }}>Awaiting input...</span></div></div></div>)
            : (<div className="pb-4">
                {state.messages.map(m => (<ChatMessage key={m.id} message={m} isOwner={isOwner} isArchived={isArchived} isStreaming={false} streamingText="" streamingReasoning=""
                  onEdit={async (id, c) => {
                    const originalMsgs = state.messages;
                    const mList = state.messages.map(x => x.id === id ? { ...x, content: c } : x);
                    dispatch({ type: 'SET_MESSAGES', payload: mList });
                    if (state.currentInstance && state.currentInstance.is_owner) {
                      const merged = { ...state.currentInstance, messages: mList };
                      dispatch({ type: 'UPDATE_INSTANCE', payload: merged });
                      dispatch({ type: 'SET_CURRENT_INSTANCE', payload: merged });
                      try {
                        await api.updateInstance(state.currentInstance.id, { 
                            messages: mList,
                            current_chunk_id: state.currentInstance.current_chunk_id
                        });
                      } catch (err) {
                        dispatch({ type: 'SET_MESSAGES', payload: originalMsgs });
                        const reverted = { ...state.currentInstance, messages: originalMsgs };
                        dispatch({ type: 'UPDATE_INSTANCE', payload: reverted });
                        dispatch({ type: 'SET_CURRENT_INSTANCE', payload: reverted });
                        alert("Failed to save edit.");
                      }
                    }
                  }}
                  onDelete={async (id) => {
                    const originalMsgs = state.messages;
                    const mList = state.messages.filter(x => x.id !== id);
                    dispatch({ type: 'SET_MESSAGES', payload: mList });
                    if (state.currentInstance && state.currentInstance.is_owner) {
                      const merged = { ...state.currentInstance, messages: mList };
                      dispatch({ type: 'UPDATE_INSTANCE', payload: merged });
                      dispatch({ type: 'SET_CURRENT_INSTANCE', payload: merged });
                      try {
                        await api.updateInstance(state.currentInstance.id, { 
                            messages: mList,
                            current_chunk_id: state.currentInstance.current_chunk_id
                        });
                      } catch (err) {
                        dispatch({ type: 'SET_MESSAGES', payload: originalMsgs });
                        const reverted = { ...state.currentInstance, messages: originalMsgs };
                        dispatch({ type: 'UPDATE_INSTANCE', payload: reverted });
                        dispatch({ type: 'SET_CURRENT_INSTANCE', payload: reverted });
                        alert("Failed to delete message.");
                      }
                    }
                  }}
                  onRegenerate={handleRegenerate}
                  onBranch={handleBranch}
                />))}
                {(state.isGenerating || state.streamingText || state.streamingReasoning) && <ChatMessage message={{ id: 'stream', role: 'ai', content: state.streamingText, reasoning: state.streamingReasoning }} isStreaming streamingText={state.streamingText} streamingReasoning={state.streamingReasoning} onEdit={() => {}} onDelete={() => {}} onRegenerate={() => {}} />}
              </div>)}
        </div>
      </div>

      {state.currentInstance && !done && canChat && !isArchived && state.token && (
        <div id="tour-chat-input" className="bezel-statusbar px-4 py-3 shrink-0">
          <div className="flex gap-2 relative">
            <div className="absolute -top-2 left-0 flex items-center gap-3">
              {state.isGenerating ? (
                <><div className="flex items-center gap-1.5"><div className="bezel-led animate-led-pulse" style={{ width: 5, height: 5 }} /><span className="text-[8px] font-mono tracking-wider" style={{ color: 'var(--text-dim)' }}>STREAMING</span></div>
                  {showChunkInfo && <span className="text-[8px] font-mono" style={{ color: '#f59e0b' }}>[{sm!.mode?.toUpperCase()} · chunk {sm!.selectedChunk! + 1}/{sm!.totalChunks}]</span>}</>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[8px] font-mono tracking-wider" style={{ color: 'var(--text-dim)' }}>READY</span>
                  <ChunkModeBadge mode={chunkMode} />
                </div>
              )}
            </div>
            <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) { if (!state.isGenerating) handleSend(); } }}
              className={cn("textarea-field flex-1 h-20 text-sm font-story custom-scrollbar", state.isGenerating && "opacity-60")}
              placeholder={state.isGenerating ? "Streaming..." : "Enter action... (Ctrl+Enter)"} autoFocus />
            <div className="flex flex-col gap-1 shrink-0 self-stretch">
              {isChunkMode && (<button onClick={() => setChunkNavOpen(true)} className={cn("para-btn para-btn-sm flex-1", chunkMode === 'manual' && "!border-[#f59e0b]")} style={chunkMode === 'manual' ? { color: '#f59e0b' } : {}} title="Open Chunk Navigator"><span>CHUNKS</span></button>)}
              {state.isGenerating
                ? <button onClick={() => api.stop()} className="para-btn para-btn-danger flex-1"><span>STOP</span></button>
                : <button id="tour-send-btn" onClick={handleSend} disabled={!input.trim()} className={cn("para-btn flex-1", input.trim() ? "para-btn-primary" : "")} style={!input.trim() ? { color: 'var(--text-dim)' } : {}}><span>SEND</span></button>
              }
            </div>
          </div>
        </div>
      )}
      {state.currentInstance && !done && sharing === 'full' && !isArchived && !state.token && (
        <div className="bezel-statusbar px-4 py-3 shrink-0 flex items-center justify-between" style={{ background: 'rgba(6, 182, 212, 0.1)', borderTop: '1px solid rgba(6, 182, 212, 0.3)' }}>
          <div><div className="text-[11px] font-bold tracking-wider" style={{ color: '#06b6d4' }}>UPLINK REQUIRED FOR COLLABORATION</div><div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>Authenticate your node to send commands.</div></div>
          <button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'login' }); }} className="para-btn para-btn-primary" style={{ borderColor: '#06b6d4', color: '#fff', background: 'rgba(6, 182, 212, 0.5)' }}><span>LOGIN / REGISTER</span></button>
        </div>
      )}
      {state.currentInstance && (!canChat || isArchived) && !(sharing === 'full' && !state.token) && (
        <div className="bezel-statusbar px-4 py-3 shrink-0 flex items-center justify-center" style={{ background: 'rgba(245, 158, 11, 0.1)', borderTop: '1px solid rgba(245, 158, 11, 0.3)' }}>
          <span className="text-[10px] font-bold tracking-[0.2em] uppercase" style={{ color: '#f59e0b' }}>⚠ {isArchived ? 'Archived Instance - Read Only' : 'Read Only Mode'}</span>
        </div>
      )}
    </div>
  );
}

function SharedView() {
  const { state, dispatch } = useApp(); const[loading, setLoading] = useState(true); const [error, setError] = useState(''); const isEmbedded = window.self !== window.top;
  useEffect(() => {
    if (state.sharedId) { api.getSharedInstance(state.sharedId).then(inst => { dispatch({ type: 'SET_CURRENT_INSTANCE', payload: inst }); setLoading(false); }).catch(err => { setError(err.message || 'Private or not found'); setLoading(false); }); }
  },[state.sharedId, dispatch]);
  if (loading) return <div className="flex h-full items-center justify-center w-full" style={{ background: 'var(--surface-0)' }}><div className="text-[10px] tracking-widest text-emboss blink" style={{ color: 'var(--accent)' }}>ESTABLISHING UPLINK...</div></div>;
  if (error) return <div className="flex h-full items-center justify-center w-full" style={{ background: 'var(--surface-0)' }}><div className="bezel-frame p-8 text-center"><div className="text-4xl mb-4">🔒</div><div className="text-sm font-bold text-[#ef4444] mb-2">ACCESS DENIED</div><div className="text-[10px] text-[var(--text-muted)]">{error}</div><button onClick={() => window.location.href = '/'} className="para-btn mt-6"><span>RETURN HOME</span></button></div></div>;
  return (
    <div className="flex flex-col w-full h-full p-1.5 gap-1">
      {!isEmbedded && (<div className="title-bar flex items-center justify-between shrink-0 select-none px-3"><div className="flex items-center gap-2"><span className="text-[11px] glow-text-strong font-bold" style={{ color: '#06b6d4' }}>◈</span><span className="text-[10px] font-bold tracking-[0.15em] text-emboss" style={{ color: 'var(--text-secondary)' }}>CRISTOL NETWORK</span>{state.currentInstance?.creator_tier && (<div className="para-badge ml-2" style={{ background: 'rgba(6,182,212,0.1)', borderColor: '#06b6d4', color: '#06b6d4' }}><span>MADE WITH {state.currentInstance.creator_tier.toUpperCase()}</span></div>)}</div><div className="flex gap-2">{state.currentInstance && (<ExportButton instanceId={state.currentInstance.id} isShared />)}{!state.token ? (<button onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'register' }); }} className="para-btn para-btn-sm para-btn-primary" style={{ background: '#06b6d4', borderColor: '#06b6d4' }}><span>CREATE YOUR OWN</span></button>) : (<button onClick={() => { window.location.href = '/'; }} className="para-btn para-btn-sm"><span>MY DASHBOARD</span></button>)}</div></div>)}
      <ChatArea />
    </div>
  );
}

export function TutorialModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; }) {
    const { state, dispatch } = useApp();
    const [step, setStep] = useState(0);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [position, setPosition] = useState<React.CSSProperties>({});
    const popoverRef = useRef<HTMLDivElement>(null);
    
    // New state to track if the current step's action is completed
    const [taskCompleted, setTaskCompleted] = useState(false);

    const handleClose = () => {
        dispatch({ type: 'UPDATE_SETTINGS', payload: { hasSeenTutorial: true } });
        setStep(0);
        onClose();
    };

    // --- EXPANDED STEPS ---
    const steps = [
        { id: 'welcome', target: null, title: "WELCOME TO CRISTOL", content: "Your terminal to infinite realities. Let's walk through building your first universe from scratch.", icon: "◈", placement: "center", actionRequired: false, autoAdvance: false },
        { id: 'blueprints-tab', target: "#tour-blueprints-tab", title: "ACCESS BLUEPRINTS", content: "Open the BLUEPRINTS tab — this is where every universe begins.", icon: "◇", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'new-blueprint', target: "#tour-new-blueprint-btn", title: "CREATE BLUEPRINT", content: "Hit '+ NEW BLUEPRINT' to forge a fresh universe.", icon: "◇", placement: "right", actionRequired: true, autoAdvance: true },
        { id: 'title', target: "#tour-edit-title", title: "ENTER TITLE", content: "Give your campaign a name — something that sparks curiosity.", icon: "✎", placement: "right", actionRequired: true, autoAdvance: false },
        { id: 'description', target: "#tour-edit-desc", title: "ENTER DESCRIPTION", content: "Sketch the premise. What world are we stepping into?", icon: "✎", placement: "right", actionRequired: true, autoAdvance: false },
        { id: 'episodes-tab', target: "#tour-tab-episodes", title: "SWITCH TO CHAPTERS", content: "Move to the CHAPTERS tab to structure your story.", icon: "◇", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'add-episode', target: "#tour-add-episode-btn", title: "ADD CHAPTER", content: "Tap '+' to create a new episode. You can: (1) Search transcripts online — try googling 'SHOW NAME S01E01 transcript' and paste the result, (2) Copy chapters from books or scripts you own, (3) Use the IMP bulk-import button for markdown-formatted stories (# Title / ## Chapter), or (4) Write original content from pure imagination.", icon: "+", placement: "bottom", actionRequired: true, autoAdvance: false },

        // EPISODE NAMING STEPS
        { id: 'episode-title', target: "#tour-episode-title", title: "NAME YOUR EPISODE", content: "Give this chapter a title — it's the anchor for everything that follows.", icon: "✎", placement: "right", actionRequired: true, autoAdvance: false },
        { id: 'episode-context', target: "#tour-episode-context", title: "WRITE THE SCENE", content: "Describe the setting, action, or prompt that drives this episode forward.", icon: "✎", placement: "right", actionRequired: true, autoAdvance: false },
        { id: 'go-back', target: "#tour-episodes-list", title: "RETURN TO LIST", content: "Click any episode in the sidebar to switch or reorder.", icon: "◀", placement: "bottom", actionRequired: true, autoAdvance: true },

        // CONTINUE WITH SHIFTED INDICES
        { id: 'profile-tab', target: "#tour-tab-profile", title: "SWITCH TO PROFILE", content: "Open PROFILE to define who the player embodies.", icon: "⧉", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'profile-input', target: "#tour-profile-input", title: "DEFINE PROFILE", content: "Specify traits, relationships, powers — everything that shapes your character.", icon: "✎", placement: "right", actionRequired: true, autoAdvance: false },
        { id: 'lore-tab', target: "#tour-tab-lore", title: "SWITCH TO LORE", content: "Jump to LORE to establish the rules of this world.", icon: "◈", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'lore-input', target: "#tour-lore-input", title: "ADD LORE", content: "Write world lore by hand or let the engine auto-generate it.", icon: "✎", placement: "right", actionRequired: true, autoAdvance: false },
        { id: 'save', target: "#tour-save-blueprint-btn", title: "SAVE BLUEPRINT", content: "Lock it in. SAVE commits your universe to the system.", icon: "✓", placement: "left", actionRequired: true, autoAdvance: true },
        { id: 'play', target: "#tour-play-btn", title: "PLAY", content: "Hit PLAY to launch a live instance of your universe.", icon: "▶", placement: "right", actionRequired: true, autoAdvance: true },
        { id: 'chat-input', target: "#tour-chat-input", title: "CHAT INPUT", content: "This is your voice in the world. Type actions with markdown — *italics* for gestures, **bold** for shouts.", icon: "⧉", placement: "top", actionRequired: true, autoAdvance: true },
        { id: 'send', target: "#tour-send-btn", title: "SEND ACTION", content: "Hit SEND or press Ctrl+Enter to commit your move.", icon: "▶", placement: "top", actionRequired: true, autoAdvance: true },
        { id: 'controls', target: "#tour-chat-area", title: "MESSAGE CONTROLS", content: "Hover any message to Edit, Regenerate, or Branch the narrative.", icon: "⚙", placement: "top", actionRequired: false, autoAdvance: false },
        { id: 'finish-ep', target: "#tour-finish-ep-btn", title: "FINISH EPISODE", content: "When the scene reaches its natural end, tap FINISH EP to close the chapter.", icon: "◼", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'generate', target: "#tour-finish-generate-btn", title: "GENERATE SUMMARY", content: "Click to auto-summarize the session (Plus tier), or write your own continuity brief manually.", icon: "◇", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'confirm', target: "#tour-finish-confirm-btn", title: "CONFIRM & ADVANCE", content: "CONFIRM locks the episode and moves you to the next chapter.", icon: "▶", placement: "bottom", actionRequired: true, autoAdvance: true },
        { id: 'done', target: null, title: "TOUR COMPLETE", content: "You're now a certified Operative. Forge infinite realities. Good luck.", icon: "✓", placement: "center", actionRequired: false, autoAdvance: false }
    ];

    // --- TASK COMPLETION CHECK ---
    useEffect(() => {
        setTaskCompleted(false); // Reset on step change
    }, [step]);

    // Track if step was manually changed (via Back/Next) to prevent auto-advance from overriding it
    const manualChangeRef = useRef(false);

    useEffect(() => {
        if (!isOpen) return;
        const currentStep = steps[step];

        // If no action required, button is always enabled
        if (!currentStep?.actionRequired) {
            setTaskCompleted(true);
            return;
        }

        const checkTask = () => {
            setTaskCompleted(prev => {
                if (prev) return true; // Already completed, don't revert

                let completed = false;
                const getInputVal = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement)?.value?.trim() || '';

                if (step === 1 && (document.querySelector("#tour-blueprints-tab.para-tab-active") || document.querySelector("#tour-new-blueprint-btn"))) completed = true;
                if (step === 2 && state.editingShow !== undefined) completed = true;
                if (step === 3 && getInputVal('tour-edit-title').length > 0) completed = true;
                if (step === 4 && getInputVal('tour-edit-desc').length > 0) completed = true;
                if (step === 5 && document.querySelector('[data-tour-tab="episodes"].para-tab-active')) completed = true;
                if (step === 6 && document.querySelectorAll('#tour-episodes-list > div').length > 0) completed = true;
                
                // NEW STEP CHECKS
                if (step === 7 && getInputVal('tour-episode-title').length > 0) completed = true;
                if (step === 8 && getInputVal('tour-episode-context').length > 0) completed = true;
                if (step === 9) completed = true; // Go-back step auto-completes
                
                // SHIFTED INDICES
                if (step === 10 && document.querySelector('[data-tour-tab="profile"].para-tab-active')) completed = true;
                if (step === 11 && getInputVal('tour-profile-input').length > 0) completed = true;
                if (step === 12 && document.querySelector('[data-tour-tab="lore"].para-tab-active')) completed = true;
                if (step === 13 && getInputVal('tour-lore-input').length > 0) completed = true;
                if (step === 14 && state.editingShow === undefined) completed = true;
                if (step === 15 && document.querySelector('#tour-chat-input')) completed = true;
                if (step === 16 && (document.querySelector('#tour-chat-input textarea') as HTMLTextAreaElement)?.value?.trim().length > 0) completed = true;
                if (step === 17 && state.isGenerating) completed = true;
                if (step === 19 && document.querySelector("#tour-finish-modal")) completed = true;
                if (step === 20 && document.querySelector("#tour-finish-summary")) completed = true;
                if (step === 21 && !document.querySelector("#tour-finish-modal")) completed = true;

                return completed;
            });
        };

        checkTask();
        const interval = setInterval(checkTask, 500);
        return () => clearInterval(interval);
    }, [step, isOpen, state.editingShow, state.isGenerating]);

    // --- AUTO ADVANCE LOGIC ---
    useEffect(() => {
        if (isOpen && taskCompleted && steps[step]?.autoAdvance && !manualChangeRef.current) {
            const timer = setTimeout(() => {
                manualChangeRef.current = false;
                if (step < steps.length - 1) {
                    setStep(s => s + 1);
                } else {
                    handleClose();
                }
            }, 300); // Slight delay for visual feedback
            return () => clearTimeout(timer);
        }
    }, [taskCompleted, step, isOpen]);

    // Reset manual change flag after step settles
    useEffect(() => {
        const timer = setTimeout(() => { manualChangeRef.current = false; }, 100);
        return () => clearTimeout(timer);
    }, [step]);

    // --- TARGET TRACKING & POSITIONING ---
    useLayoutEffect(() => {
        if (!isOpen) return;
        const targetId = steps[step].target;
        
        // Calculate rect for highlight overlay
        if (targetId) {
            const el = document.querySelector(targetId);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
                setTimeout(() => {
                    const currentEl = document.querySelector(targetId);
                    setRect(currentEl ? currentEl.getBoundingClientRect() : null);
                }, 400);
            } else {
                setRect(null);
            }
        } else {
            setRect(null);
        }
        
        // Position above the status bar, aligned LEFT to avoid blocking message controls
        setPosition({
            bottom: '80px',
            left: '24px',
            top: 'auto',
            right: 'auto',
            transform: 'none',
            maxWidth: '320px',
            maxHeight: 'calc(100vh - 104px)'
        });
    }, [step, isOpen]);

    if (!isOpen) return null;

    const current = steps[step];

    // Removed darkening: transparent box-shadow and overlay
    const highlight: React.CSSProperties = rect ? {
        position: 'absolute', top: rect.top - 8, left: rect.left - 8,
        width: rect.width + 16, height: rect.height + 16,
        borderRadius: '10px', border: '2px solid var(--accent)',
        boxShadow: '0 0 0 9999px transparent, 0 0 12px var(--glow-color), inset 0 0 8px rgba(255,255,255,0.1)',
        pointerEvents: 'none', transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        animation: 'pulse-glow 2s infinite'
    } : { display: 'none' };

    return (
        <div className="fixed inset-0 z-[300]" style={{ pointerEvents: 'none' }}>
            <style>{`
                @keyframes pulse-glow {
                    0%, 100% { box-shadow: 0 0 0 9999px transparent, 0 0 12px var(--glow-color), inset 0 0 8px rgba(255,255,255,0.1); }
                    50% { box-shadow: 0 0 0 9999px transparent, 0 0 20px var(--accent), inset 0 0 12px rgba(255,255,255,0.15); }
                }
                @keyframes fade-in-pop { 0% { opacity: 0; transform: scale(0.95) translateY(5px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
            `}</style>
            {rect && <div style={{ overflow: 'hidden', position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                <div style={highlight} />
            </div>}
            <div className="absolute inset-0" style={{ background: 'transparent', pointerEvents: 'none' }} />
            
            <div ref={popoverRef} className="bezel-frame p-5 space-y-4 flex flex-col" style={{
                position: 'absolute', ...position, width: 'auto', maxWidth: '320px', zIndex: 310,
                pointerEvents: 'auto', animation: 'fade-in-pop 0.3s ease-out',
                background: 'var(--surface-2)', border: '1px solid var(--border-color)'
            }}>
                <div className="flex justify-between items-center shrink-0">
                    <div className="para-badge-glow para-badge"><span>OPERATIVE BRIEFING</span></div>
                    <CloseButton onClick={handleClose} />
                </div>
                <ParaDivider />
                <div className="text-center py-3 flex flex-col justify-center items-center space-y-3 shrink-0">
                    <div className="text-4xl glow-text-strong shrink-0" style={{ color: 'var(--accent)' }}>{current.icon}</div>
                    <h2 className="text-base font-bold tracking-widest text-emboss uppercase shrink-0" style={{ color: 'var(--text-primary)' }}>{current.title}</h2>
                    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{current.content}</p>
                </div>
                <div className="flex justify-center gap-1.5 mb-1 shrink-0">
                    {steps.map((_, i) => (<div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-[var(--surface-3)]"}`} />))}
                </div>
                <div className="flex gap-2 shrink-0 mt-1">
                    {step > 0 && (<button onClick={() => { manualChangeRef.current = true; setStep(s => s - 1); }} className="para-btn py-2.5 px-3 text-[10px]"><span>BACK</span></button>)}

                    {/* Modified Button Logic */}
                    <button
                        onClick={() => { manualChangeRef.current = true; step < steps.length - 1 ? setStep(s => s + 1) : handleClose(); }}
                        disabled={steps[step]?.actionRequired && !taskCompleted}
                        className={cn(
                            "para-btn para-btn-primary flex-1 py-2.5 text-[10px]",
                            (steps[step]?.actionRequired && !taskCompleted) && "opacity-50 cursor-not-allowed"
                        )}
                    >
                        <span>{step < steps.length - 1 ? 'NEXT ▶' : 'INITIALIZE ◈'}</span>
                    </button>
                </div>
                <div className="text-center mt-0.5 shrink-0">
                    <button onClick={handleClose} className="text-[9px] tracking-widest hover:text-white transition-colors" style={{ color: 'var(--text-dim)' }}>SKIP TUTORIAL</button>
                </div>
            </div>
        </div>
    );
}

function MainApp() {
  const { state, dispatch } = useApp();
  const[sOpen, setSOpen] = useState(false); const [fOpen, setFOpen] = useState(false); const[pOpen, setPOpen] = useState(false); const [shareOpen, setShareOpen] = useState(false); const[adminOpen, setAdminOpen] = useState(false);
  useKeyboardShortcuts();

  useEffect(() => {
    if (state.settings.hasSeenTutorial === false) {
      dispatch({ type: 'SET_TUTORIAL_OPEN', payload: true });
    }
  }, [state.settings.hasSeenTutorial, dispatch]);

  useEffect(() => {
    if (state.userProfile) {
      const p = state.userProfile; const trialJustEnded = p.trial_finished_today; const hasSeen = sessionStorage.getItem('trial_ended_notified');
      if (trialJustEnded && !hasSeen) { dispatch({ type: 'SET_UPGRADE_PROMPT', payload: { isOpen: true, title: 'PLUS TRIAL ENDED', message: 'Your 3-day Plus trial has concluded. Upgrade to Plus to restore them permanently.' } }); sessionStorage.setItem('trial_ended_notified', 'true'); }
    }
  }, [state.userProfile?.trial_finished_today, dispatch]);

  if (state.tierChangeNotification) { return (<div className="flex flex-col w-full h-full p-1.5 gap-1 relative"><TierChangeNotificationPanel /></div>); }

  const p = state.userProfile;
  const pendingDate = p?.pending_deletion_at ? new Date(p.pending_deletion_at) : null;
  const daysLeft = pendingDate ? Math.ceil((pendingDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
  const chunkMode = state.settings.chunkSelectionMode;

  return (
    <div className="flex flex-col w-full h-full p-1.5 gap-1">
      <SettingsModal isOpen={sOpen} onClose={() => setSOpen(false)} />
      <EditShowModal isOpen={state.editingShow !== undefined} onClose={() => dispatch({ type: 'SET_EDITING_SHOW', payload: undefined })} show={state.editingShow} />
      <FinishEpisodeModal isOpen={fOpen} onClose={() => setFOpen(false)} />
      <ProfileModal isOpen={pOpen} onClose={() => setPOpen(false)} />
      <ShareModal isOpen={shareOpen} onClose={() => setShareOpen(false)} />
      <AdminDashboardModal isOpen={adminOpen} onClose={() => setAdminOpen(false)} />
      <UpgradePromptModal />
      <TutorialModal isOpen={state.tutorialOpen} onClose={() => dispatch({ type: 'SET_TUTORIAL_OPEN', payload: false })} />
      {state.billingPageOpen && <BillingPage onClose={() => dispatch({ type: 'SET_BILLING_PAGE_OPEN', payload: false })} />}

      {p?.pending_deletion_at && daysLeft !== null && (
        <div className={cn("w-full shrink-0 p-3 flex items-center justify-between", daysLeft <= 1 ? "animate-pulse" : "")} style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)' }}>
          <div className="flex items-center gap-3"><span className="text-2xl" style={{ color: '#ef4444' }}>⚠</span><div><div className="text-[11px] font-bold tracking-widest uppercase" style={{ color: '#ef4444' }}>{daysLeft <= 1 ? "CRITICAL: CONTENT DELETION IMMINENT" : `URGENT: CONTENT DELETION IN ${daysLeft} DAYS`}</div><div className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>Your content retention period has expired.</div></div></div>
          <button onClick={async () => { try { await api.recoverContent(); const profile = await api.getMe(); dispatch({ type: 'SET_USER_PROFILE', payload: profile }); } catch (e) {  } }} className="para-btn para-btn-primary" style={{ background: '#ef4444', borderColor: '#ef4444', color: '#fff' }}><span>RECOVER CONTENT NOW</span></button>
        </div>
      )}

      {p?.subscription_tier === 'Free' && !p?.phone_verified && (
        <div className="w-full shrink-0 p-2 flex items-center justify-center gap-3 cursor-pointer hover:brightness-125 transition-all" style={{ background: 'rgba(245, 158, 11, 0.15)', borderBottom: '1px solid rgba(245, 158, 11, 0.3)' }} onClick={() => { dispatch({ type: 'SET_VIEW', payload: 'auth' }); dispatch({ type: 'SET_AUTH_MODE', payload: 'phone' }); }}>
          <span className="text-xl" style={{ color: '#f59e0b' }}></span>
          <span className="text-[11px] font-bold tracking-widest uppercase" style={{ color: '#f59e0b' }}>Verify your phone number to claim 75 free credits!</span>
          <button className="para-btn para-btn-sm ml-4" style={{ borderColor: '#f59e0b', color: '#f59e0b' }}><span>VERIFY NOW</span></button>
        </div>
      )}

      <div className="title-bar flex items-center justify-between shrink-0 select-none px-3">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-[11px] glow-text-strong font-bold" style={{ color: 'var(--accent)' }}>◈</span>
          <span className="text-[10px] font-bold tracking-[0.15em] text-emboss" style={{ color: 'var(--text-secondary)' }}>CRISTOL</span>
          <div className="para-badge ml-1"><span>v1.0</span></div>
        </div>
        <div id="tour-top-controls" className="flex items-center gap-2">
          <UpgradeButton />
          {(<div title="Episode navigation mode — change in Settings → AI Engine"><ChunkModeBadge mode={chunkMode} /></div>)}
          <ModelSelector />
          {state.currentInstance && state.messages.length > 0 && !state.currentInstance.is_archived && <button id="tour-finish-ep-btn" onClick={() => setFOpen(true)} className="para-btn para-btn-sm mr-1" style={{ color: 'var(--accent)' }} title="Finish Episode (Ctrl+E)"><span>FINISH EP</span></button>}
          {state.currentInstance && (<button onClick={() => setShareOpen(true)} className="para-btn para-btn-sm mr-2" style={{ color: '#06b6d4', borderColor: '#06b6d4' }}><span>SHARE</span></button>)}
          {state.userProfile?.is_admin && (<button onClick={() => setAdminOpen(true)} className="para-btn para-btn-sm mr-2" style={{ color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)' }}><span>ADMIN</span></button>)}
          <button onClick={() => setSOpen(true)} className="window-ctrl window-ctrl-util" title="Settings (Ctrl+Shift+S)"><div><SettingsIcon size={12} /></div></button>
          <button onClick={() => setPOpen(true)} className="window-ctrl" title="Profile (Ctrl+Shift+P)" style={{ color: 'var(--text-muted)' }}><div><UserIcon size={12} /></div></button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden gap-1">
        <Sidebar />
        <ChatArea />
      </div>
      <div className="bezel-statusbar h-5 flex items-center justify-center shrink-0"><div className="para-divider w-1/3"><div className="para-divider-shard" /><div className="para-divider-center" /><div className="para-divider-shard" /></div></div>
    </div>
  );
}

function App() {
  const { state } = useApp();
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.settings.colorTheme);
    document.documentElement.setAttribute('data-appearance', state.settings.appearance);

    const theme = state.settings.colorTheme;
    const appearance = state.settings.appearance;
    
    let bgColor = appearance === 'light' ? '#f0f0f2' : '#080808';
    if (appearance === 'dark' && theme === 'mono') bgColor = '#060606';

    let symbolColor = '#aaaaaa';
    if (appearance === 'dark') {
      switch (theme) {
        case 'green': symbolColor = '#22c55e'; break;
        case 'amber': symbolColor = '#f59e0b'; break;
        case 'cyan': symbolColor = '#06b6d4'; break;
        case 'purple': symbolColor = '#a855f7'; break;
        case 'red': symbolColor = '#ef4444'; break;
        case 'mono': default: symbolColor = '#aaaaaa'; break;
      }
    } else {
      switch (theme) {
        case 'green': symbolColor = '#4ade80'; break;
        case 'amber': symbolColor = '#fbbf24'; break;
        case 'cyan': symbolColor = '#22d3ee'; break;
        case 'purple': symbolColor = '#c084fc'; break;
        case 'red': symbolColor = '#f87171'; break;
        case 'mono': default: symbolColor = '#888888'; break;
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" rx="22" fill="${bgColor}"/>
  <text x="48.5" y="60" text-anchor="middle" dominant-baseline="middle" font-size="90" font-family="JetBrains Mono, monospace" font-weight="600" fill="${symbolColor}">◈</text>
</svg>`;

    let link = document.querySelector("link[rel~='icon']") as HTMLLinkElement;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }

    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;

  },[state.settings.colorTheme, state.settings.appearance]);

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col" style={{ background: 'var(--surface-0)' }}>
      {state.view === 'home' && <LandingPage />}
      {state.view === 'auth' && <AuthPage />}
      {state.view === 'app' && <MainApp />}
      {state.view === 'shared' && <SharedView />}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) { ReactDOM.createRoot(rootElement).render(<React.StrictMode><AppProvider><App /></AppProvider></React.StrictMode>); }
