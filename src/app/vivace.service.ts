import { Injectable, computed, effect, signal } from '@angular/core';
import { CURRENT_ADMIN, CURRENT_PROFESSIONAL, INITIAL_PATIENTS } from '../data/mockData';
import { createSseParser } from './sse-parser';
import { AdminUser, AlertSeverity, ChatMessage, DailyCheckIn, MedicationItem, Patient, PostOpInstruction, ProfessionalUser, UserRole, WoundPhoto } from '../types';

const STORAGE_KEY = 'vivace_patients_v2';
const PROFESSIONALS_STORAGE_KEY = 'vivace_professionals_v1';
const SESSION_STORAGE_KEY = 'vivace_session_v1';
const SYNC_PENDING_STORAGE_KEY = 'vivace_sync_pending_v1'; // chave antiga: só para limpar
// Prontuário e cadastros ficam só na aba (sessionStorage): somem quando ela
// fecha, em vez de ficar para sempre no computador, e logout/401 apagam na hora. Só o token da sessão pode ir para o
// localStorage, e só se o usuário marcar "Lembrar neste dispositivo".
const EVENT_RETRY_MIN_MS = 1_000;
const EVENT_RETRY_MAX_MS = 30_000;
const SYNC_INTERVAL_MS = 3_000;

declare const VIVACE_API_PORT: string;
// Public API origin for hosted builds (scripts/build-vercel.mjs). Unset in local development.
declare const VIVACE_API_URL: string;

const apiBase = (): string =>
  typeof VIVACE_API_URL === 'string' ? VIVACE_API_URL.replace(/\/+$/, '') : '';

const apiPort = (): string =>
  typeof VIVACE_API_PORT === 'string' && VIVACE_API_PORT.length > 0 ? VIVACE_API_PORT : '3001';

interface StoredSession {
  role: UserRole;
  patientId: string;
  token: string;
  name: string;
}

export interface LoginResult {
  ok: boolean;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class VivaceService {
  private readonly storedSession = this.loadSession();
  private readonly patientsState = signal<Patient[]>(this.loadPatients());
  private readonly professionalsState = signal<ProfessionalUser[]>(this.loadProfessionals());
  private readonly adminsState = signal<AdminUser[]>([structuredClone(CURRENT_ADMIN)]);
  private noticeTimer = 0;
  private token = this.storedSession?.token ?? '';
  private eventsAbort: AbortController | null = null;

  readonly patients = this.patientsState.asReadonly();
  readonly professionals = this.professionalsState.asReadonly();
  readonly admins = this.adminsState.asReadonly();
  readonly activePatientId = signal(this.storedSession?.role === 'patient' ? this.storedSession.patientId : 'pat-1');
  readonly currentRole = signal<UserRole>(this.storedSession?.role ?? 'professional');
  readonly isLoggedIn = signal(this.storedSession !== null);
  // Aviso de falha ou conflito de uma gravação, mostrado pelo shell do app.
  readonly notice = signal<{ text: string; error: boolean } | null>(null);
  readonly sessionName = signal(this.storedSession?.name ?? '');
  readonly professionalUser = computed(() => this.professionals()[0] ?? CURRENT_PROFESSIONAL);
  readonly selectedPatient = computed(() =>
    this.patients().find(patient => patient.id === this.activePatientId()) ?? this.patients()[0]
  );

  constructor() {
    this.purgeLegacyClinicalCache();
    this.patientsState.update(patients => this.assignPrimaryProfessional(patients, this.professionalUser()));
    effect(() => {
      const patients = this.patients();
      // Deslogado não há o que guardar: o estado é o de demonstração do bundle.
      if (!this.isLoggedIn()) return;
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(patients));
      } catch {
        // The demo remains usable when browser storage is unavailable.
      }
    });
    void this.loadSharedState();
    if (this.token) this.listenForMessages();
    window.setInterval(() => void this.loadSharedState(), SYNC_INTERVAL_MS);
    effect(() => {
      const professionals = this.professionals();
      if (!this.isLoggedIn()) return;
      try {
        sessionStorage.setItem(PROFESSIONALS_STORAGE_KEY, JSON.stringify(professionals));
      } catch {
        // The demo remains usable when browser storage is unavailable.
      }
    });
  }

  async login(username: string, password: string, rememberMe = false): Promise<LoginResult> {
    try {
      const response = await fetch(this.apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const result = await response.json().catch(() => ({})) as { token?: string; role?: UserRole; patientId?: string | null; name?: string; error?: string };
      if (!response.ok || !result.token || !result.role) {
        return { ok: false, message: result.error ?? 'Não foi possível entrar. Verifique a conexão e tente novamente.' };
      }
      this.token = result.token;
      this.currentRole.set(result.role);
      if (result.patientId) this.activePatientId.set(result.patientId);
      this.sessionName.set(result.name ?? '');
      this.isLoggedIn.set(true);
      this.saveSession(rememberMe);
      this.listenForMessages();
      await this.loadSharedState();
      return { ok: true, message: '' };
    } catch {
      return { ok: false, message: 'API indisponível. Confirme se o servidor está rodando na mesma rede.' };
    }
  }

  async logout(): Promise<void> {
    const token = this.token;
    this.token = '';
    this.stopListening();
    this.isLoggedIn.set(false);
    this.sessionName.set('');
    this.clearClinicalData();
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // The demo remains usable when browser storage is unavailable.
    }
    if (!token) return;
    try {
      await fetch(this.apiUrl('/api/auth/logout'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // The session is already discarded locally.
    }
  }

  notify(text: string, error = false): void {
    this.notice.set({ text, error });
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.notice.set(null), 7_000);
  }

  // Toda gravação é uma chamada própria e só vale quando o servidor confirma: nada é
  // alterado na tela antes disso. 409 (versão que mudou) e erros viram aviso, e o estado
  // é recarregado para a tela refletir o que está no servidor.
  private async call<T>(method: string, path: string, options: { body?: unknown; version?: number } = {}): Promise<{ ok: true; data: T } | { ok: false }> {
    if (!this.token) return { ok: false };
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.version !== undefined) headers['If-Match'] = `"${options.version}"`;
    try {
      const response = await this.authFetch(this.apiUrl(path), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      if (response.status === 401) {
        await this.handleUnauthorized();
        return { ok: false };
      }
      const data = await response.json().catch(() => ({})) as T & { error?: string; current?: unknown };
      if (response.ok) return { ok: true, data };
      if (response.status === 409 && data.current) {
        this.notify('Este registro foi alterado por outra pessoa. Mostramos a versão atual; confira e refaça a alteração.', true);
        void this.loadSharedState();
      } else if (response.status === 409) {
        this.notify(data.error ?? 'A alteração conflita com um cadastro existente.', true);
      } else if (response.status === 403) {
        this.notify('Você não tem permissão para esta ação.', true);
      } else if (response.status === 404) {
        this.notify('O registro não existe mais. Atualizamos a tela.', true);
        void this.loadSharedState();
      } else if (response.status === 400 || response.status === 413) {
        this.notify('Os dados enviados não foram aceitos. Revise os campos e tente de novo.', true);
      } else {
        this.notify('Não foi possível salvar agora. Tente novamente.', true);
      }
      return { ok: false };
    } catch {
      this.notify('Sem conexão com o servidor. A alteração não foi salva.', true);
      return { ok: false };
    }
  }

  // Grava e, se deu certo, traz o estado novo do servidor.
  private async save(method: string, path: string, options: { body?: unknown; version?: number } = {}): Promise<boolean> {
    const result = await this.call<unknown>(method, path, options);
    if (!result.ok) return false;
    await this.loadSharedState();
    return true;
  }

  private versionOf<T extends { id: string; version?: number }>(items: T[], id: string, given?: number): number | undefined {
    return given ?? items.find(item => item.id === id)?.version;
  }

  private newClientId(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  addProfessional(professional: Omit<ProfessionalUser, 'id'>): Promise<boolean> {
    return this.save('POST', '/api/professionals', {
      body: { ...professional, clientId: this.newClientId('prof') }
    });
  }

  async updateProfessional(id: string, changes: Omit<ProfessionalUser, 'id' | 'avatar'>, avatar?: string, version?: number): Promise<boolean> {
    const { password, ...fields } = changes;
    const body = { ...fields, ...(avatar === undefined ? {} : { avatar: avatar || this.avatarFor(changes.name) }) };
    const saved = await this.save('PATCH', `/api/professionals/${encodeURIComponent(id)}`, {
      body, version: this.versionOf(this.professionals(), id, version)
    });
    if (!saved || !password) return saved;
    return this.save('PUT', `/api/professionals/${encodeURIComponent(id)}/password`, { body: { password } });
  }

  async deleteProfessional(id: string, version?: number): Promise<boolean> {
    if (this.professionals().length <= 1) {
      this.notify('Mantenha ao menos um profissional cadastrado.', true);
      return false;
    }
    return this.save('DELETE', `/api/professionals/${encodeURIComponent(id)}`, { version: this.versionOf(this.professionals(), id, version) });
  }

  addAdmin(admin: Pick<AdminUser, 'name' | 'email' | 'password'>): Promise<boolean> {
    return this.save('POST', '/api/admins', { body: { ...admin, clientId: this.newClientId('adm') } });
  }

  async deleteAdmin(id: string, version?: number): Promise<boolean> {
    if (this.admins().length <= 1) {
      this.notify('Mantenha ao menos um administrador cadastrado.', true);
      return false;
    }
    return this.save('DELETE', `/api/admins/${encodeURIComponent(id)}`, { version: this.versionOf(this.admins(), id, version) });
  }

  async updateAdmin(id: string, changes: Pick<AdminUser, 'name' | 'email' | 'password'>, version?: number): Promise<boolean> {
    const { password, ...fields } = changes;
    const saved = await this.save('PATCH', `/api/admins/${encodeURIComponent(id)}`, {
      body: fields, version: this.versionOf(this.admins(), id, version)
    });
    if (!saved || !password) return saved;
    return this.save('PUT', `/api/admins/${encodeURIComponent(id)}/password`, { body: { password } });
  }

  addPatient(patient: Pick<Patient, 'name' | 'age' | 'gender' | 'email' | 'password' | 'phone' | 'cpf' | 'procedure' | 'surgeryDate' | 'dischargeDate' | 'hospital'>, avatar?: string): Promise<boolean> {
    return this.save('POST', '/api/patients', {
      body: { ...patient, avatar: avatar || this.avatarFor(patient.name), clientId: this.newClientId('pat') }
    });
  }

  async updatePatientRegistration(id: string, changes: Pick<Patient, 'name' | 'age' | 'gender' | 'email' | 'password' | 'phone' | 'cpf' | 'procedure' | 'surgeryDate' | 'dischargeDate' | 'hospital'>, avatar?: string, version?: number): Promise<boolean> {
    const { password, ...fields } = changes;
    const body = { ...fields, ...(avatar === undefined ? {} : { avatar: avatar || this.avatarFor(changes.name) }) };
    const saved = await this.save('PATCH', `/api/patients/${encodeURIComponent(id)}`, {
      body, version: this.versionOf(this.patients(), id, version)
    });
    if (!saved || !password) return saved;
    return this.save('PUT', `/api/patients/${encodeURIComponent(id)}/password`, { body: { password } });
  }

  async deletePatient(id: string, version?: number): Promise<boolean> {
    if (this.patients().length <= 1) {
      this.notify('Mantenha ao menos um paciente cadastrado.', true);
      return false;
    }
    const saved = await this.save('DELETE', `/api/patients/${encodeURIComponent(id)}`, { version: this.versionOf(this.patients(), id, version) });
    if (saved && this.activePatientId() === id) this.activePatientId.set(this.patients()[0].id);
    return saved;
  }

  // O servidor decide id, hora, autor e status: aqui só vão as medições do paciente.
  async submitDailyCheckIn(patientId: string, data: Omit<DailyCheckIn, 'id'>, photo?: { imageUrl: string; patientNotes?: string }): Promise<boolean> {
    const result = await this.call<{ patient: Patient }>('POST', '/api/checkins', {
      body: {
        id: this.newClientId('chk'),
        patientId,
        checkIn: data,
        photo: photo ? { id: this.newClientId('wp'), imageUrl: photo.imageUrl, patientNotes: photo.patientNotes } : undefined
      }
    });
    if (!result.ok) return false;
    this.mergePatient(result.data.patient);
    return true;
  }

  private mergePatient(patient: Patient): void {
    if (!this.token) return;
    this.patientsState.update(patients => patients.map(item => item.id === patient.id ? this.normalizePatient(patient) : item));
  }

  async toggleMedicationTaken(patientId: string, medicationId: string, time: string): Promise<boolean> {
    const result = await this.call<{ patient: Patient }>('POST', '/api/medication-taken', { body: { patientId, medicationId, time } });
    if (!result.ok) return false;
    this.mergePatient(result.data.patient);
    return true;
  }

  addMedication(patientId: string, medication: Omit<MedicationItem, 'id' | 'takenToday' | 'version'>): Promise<boolean> {
    return this.save('POST', `/api/patients/${encodeURIComponent(patientId)}/medications`, {
      body: { ...medication, clientId: this.newClientId('med') }
    });
  }

  updateMedication(patientId: string, medicationId: string, changes: Omit<MedicationItem, 'id' | 'takenToday' | 'version'>, version?: number): Promise<boolean> {
    const medications = this.patients().find(patient => patient.id === patientId)?.medications ?? [];
    return this.save('PATCH', `/api/patients/${encodeURIComponent(patientId)}/medications/${encodeURIComponent(medicationId)}`, {
      body: changes, version: this.versionOf(medications, medicationId, version)
    });
  }

  deleteMedication(patientId: string, medicationId: string, version?: number): Promise<boolean> {
    const medications = this.patients().find(patient => patient.id === patientId)?.medications ?? [];
    return this.save('DELETE', `/api/patients/${encodeURIComponent(patientId)}/medications/${encodeURIComponent(medicationId)}`, {
      version: this.versionOf(medications, medicationId, version)
    });
  }

  addInstruction(patientId: string, instruction: Omit<PostOpInstruction, 'id' | 'version'>): Promise<boolean> {
    return this.save('POST', `/api/patients/${encodeURIComponent(patientId)}/instructions`, {
      body: { ...instruction, clientId: this.newClientId('inst') }
    });
  }

  updateInstruction(patientId: string, instructionId: string, changes: Omit<PostOpInstruction, 'id' | 'version'>, version?: number): Promise<boolean> {
    const instructions = this.patients().find(patient => patient.id === patientId)?.instructions ?? [];
    return this.save('PATCH', `/api/patients/${encodeURIComponent(patientId)}/instructions/${encodeURIComponent(instructionId)}`, {
      body: changes, version: this.versionOf(instructions, instructionId, version)
    });
  }

  deleteInstruction(patientId: string, instructionId: string, version?: number): Promise<boolean> {
    const instructions = this.patients().find(patient => patient.id === patientId)?.instructions ?? [];
    return this.save('DELETE', `/api/patients/${encodeURIComponent(patientId)}/instructions/${encodeURIComponent(instructionId)}`, {
      version: this.versionOf(instructions, instructionId, version)
    });
  }

  reviewWoundPhoto(patientId: string, photoId: string, status: WoundPhoto['reviewStatus'], feedback: string): Promise<boolean> {
    if (status === 'pendente') return Promise.resolve(false);
    return this.save('PUT', `/api/patients/${encodeURIComponent(patientId)}/wound-photos/${encodeURIComponent(photoId)}/review`, {
      body: { status, feedback }
    });
  }

  async sendMessage(patientId: string, text: string, sender: ChatMessage['sender']): Promise<boolean> {
    const messageText = text.trim();
    const patient = this.patients().find(item => item.id === patientId);
    if (!messageText || !patient || !this.token) return false;
    if (this.currentRole() === 'patient' && patientId !== this.activePatientId()) return false;
    const message: ChatMessage = {
      id: `msg-${crypto.randomUUID()}`,
      sender,
      senderName: sender === 'equipe' ? (this.sessionName() || this.professionalUser().name) : patient.name,
      timestamp: this.time(new Date()),
      text: messageText,
      isRead: false
    };
    this.mergeChatMessage(patientId, message);
    try {
      const response = await this.authFetch(this.apiUrl('/api/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId,
          text: message.text,
          sender: message.sender,
          senderName: message.senderName,
          clientMessageId: message.id
        })
      });
      if (response.status === 401) {
        await this.handleUnauthorized();
        throw new Error('Session expired');
      }
      if (!response.ok) throw new Error('Message not saved');
      const result = await response.json() as { message: ChatMessage };
      this.mergeChatMessage(patientId, result.message);
      return true;
    } catch {
      this.patientsState.update(patients => patients.map(item => item.id === patientId
        ? { ...item, messages: item.messages.filter(itemMessage => itemMessage.id !== message.id) }
        : item));
      return false;
    }
  }

  addClinicalNote(patientId: string, text: string): Promise<boolean> {
    const noteText = text.trim();
    if (!noteText) return Promise.resolve(false);
    return this.save('POST', `/api/patients/${encodeURIComponent(patientId)}/clinical-notes`, {
      body: { text: noteText, clientId: this.newClientId('cn') }
    });
  }

  updatePatientStatus(patientId: string, status: AlertSeverity): Promise<boolean> {
    return this.save('PUT', `/api/patients/${encodeURIComponent(patientId)}/status`, { body: { status } });
  }

  private avatarFor(name: string): string {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=E6F0FA&color=0B5CAB`;
  }

  private assignPrimaryProfessional(patients: Patient[], professional: ProfessionalUser): Patient[] {
    const defaultSurgeon = `${CURRENT_PROFESSIONAL.name} (${CURRENT_PROFESSIONAL.crmCoren})`;
    const updatedSurgeon = `${professional.name} (${professional.crmCoren})`;
    return patients.map(patient => patient.surgeon === defaultSurgeon ? { ...patient, surgeon: updatedSurgeon } : patient);
  }

  private async loadSharedState(): Promise<void> {
    if (!this.token) return;
    const requestToken = this.token;
    try {
      const response = await this.authFetch(this.apiUrl());
      // Resposta de uma sessão que já não é a atual (logout, ou novo login logo
      // depois): não devolve o prontuário para a tela de login e, sobretudo, um
      // 401 atrasado da sessão antiga não pode deslogar a nova.
      if (this.token !== requestToken) return;
      if (response.status === 401) {
        await this.handleUnauthorized();
        return;
      }
      if (!response.ok) return;
      const state = await response.json() as { patients?: Patient[]; professionals?: ProfessionalUser[]; admins?: AdminUser[] };
      if (this.token !== requestToken) return;
      const professional = state.professionals?.[0] ?? this.professionalUser();
      const patients = state.patients
        ? this.assignPrimaryProfessional(state.patients.map(patient => this.normalizePatient(patient)), professional)
        : undefined;
      if (Array.isArray(patients) && JSON.stringify(patients) !== JSON.stringify(this.patients())) {
        this.patientsState.set(patients);
      }
      if (Array.isArray(state.professionals) && state.professionals.length && JSON.stringify(state.professionals) !== JSON.stringify(this.professionals())) {
        this.professionalsState.set(state.professionals);
      }
      if (Array.isArray(state.admins) && state.admins.length && JSON.stringify(state.admins) !== JSON.stringify(this.admins())) {
        this.adminsState.set(state.admins);
      }
    } catch {
      // Sem a API, a tela fica com o último estado carregado.
    }
  }

  private async handleUnauthorized(): Promise<void> {
    await this.logout();
  }

  private apiUrl(path = '/api/state'): string {
    const base = apiBase();
    return base ? `${base}${path}` : `${location.protocol}//${location.hostname}:${apiPort()}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async authFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.authHeaders())) headers.set(name, value);
    return fetch(url, { ...init, headers });
  }

  // O stream é lido com fetch para mandar o token em Authorization. O EventSource
  // não manda cabeçalho, e a alternativa era o token na URL (log de proxy,
  // histórico, Referer). Em troca, a reconexão é nossa, com espera crescente.
  private listenForMessages(): void {
    this.stopListening();
    const controller = new AbortController();
    this.eventsAbort = controller;
    void this.runEventStream(this.token, controller.signal);
  }

  private stopListening(): void {
    this.eventsAbort?.abort();
    this.eventsAbort = null;
  }

  private async runEventStream(token: string, signal: AbortSignal): Promise<void> {
    let delay = EVENT_RETRY_MIN_MS;
    while (!signal.aborted && this.token === token) {
      try {
        const response = await fetch(this.apiUrl('/api/events'), {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          cache: 'no-store',
          signal
        });
        // Sessão inválida: não adianta reconectar. A sincronização periódica do
        // estado recebe o 401 e faz o logout.
        if (response.status === 401) return;
        if (response.ok && response.body) {
          delay = EVENT_RETRY_MIN_MS;
          const parser = createSseParser(data => this.handleEventData(data));
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.push(value);
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await this.pause(delay, signal);
      delay = Math.min(delay * 2, EVENT_RETRY_MAX_MS);
    }
  }

  private pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const timer = window.setTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private handleEventData(data: string): void {
    try {
      const payload = JSON.parse(data) as { type?: string; patientId?: string; message?: ChatMessage };
      if (payload.type === 'message.created' && payload.patientId && payload.message) {
        this.mergeChatMessage(payload.patientId, payload.message);
      }
    } catch {
      // Invalid events are ignored; polling remains available as a fallback.
    }
  }

  private mergeChatMessage(patientId: string, message: ChatMessage): void {
    this.patientsState.update(patients => patients.map(patient => {
      if (patient.id !== patientId) return patient;
      const existingIndex = patient.messages.findIndex(item => item.id === message.id);
      if (existingIndex < 0) return { ...patient, messages: [...patient.messages, message] };
      const messages = [...patient.messages];
      messages[existingIndex] = message;
      return { ...patient, messages };
    }));
  }

  // Logout e 401: o prontuário sai da memória e do navegador. Sem isso, o próximo
  // usuário do mesmo computador herdava o cache.
  private clearClinicalData(): void {
    this.notice.set(null);
    this.patientsState.set(structuredClone(INITIAL_PATIENTS).map(patient => this.normalizePatient(patient)));
    this.professionalsState.set([structuredClone(CURRENT_PROFESSIONAL)]);
    this.adminsState.set([structuredClone(CURRENT_ADMIN)]);
    this.activePatientId.set('pat-1');
    try {
      for (const key of [STORAGE_KEY, PROFESSIONALS_STORAGE_KEY, SYNC_PENDING_STORAGE_KEY]) {
        sessionStorage.removeItem(key);
        localStorage.removeItem(key);
      }
    } catch {
      // Nothing to clear when browser storage is unavailable.
    }
  }

  // Versões anteriores guardavam o prontuário no localStorage, que sobrevive ao
  // fechamento do navegador. Quem já tem essas chaves as perde na primeira carga.
  private purgeLegacyClinicalCache(): void {
    try {
      for (const key of [STORAGE_KEY, PROFESSIONALS_STORAGE_KEY, SYNC_PENDING_STORAGE_KEY]) {
        localStorage.removeItem(key);
      }
    } catch {
      // Nothing to purge when browser storage is unavailable.
    }
  }

  private loadPatients(): Patient[] {
    try {
      const value = sessionStorage.getItem(STORAGE_KEY);
      if (value) return (JSON.parse(value) as Patient[]).map(patient => this.normalizePatient(patient));
    } catch {
      // Fall back to bundled demonstration data.
    }
    return structuredClone(INITIAL_PATIENTS).map(patient => this.normalizePatient(patient));
  }

  private loadProfessionals(): ProfessionalUser[] {
    try {
      const value = sessionStorage.getItem(PROFESSIONALS_STORAGE_KEY);
      if (value) return JSON.parse(value) as ProfessionalUser[];
    } catch {
      // Fall back to bundled demonstration data.
    }
    return [structuredClone(CURRENT_PROFESSIONAL)];
  }

  private loadSession(): StoredSession | null {
    try {
      const value = localStorage.getItem(SESSION_STORAGE_KEY) ?? sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!value) return null;
      const session = JSON.parse(value) as StoredSession;
      if (!['professional', 'patient', 'admin'].includes(session.role) || typeof session.patientId !== 'string') {
        return null;
      }
      if (typeof session.token !== 'string' || !session.token) return null;
      return session;
    } catch {
      return null;
    }
  }

  private normalizePatient(patient: Patient): Patient {
    return {
      ...patient,
      woundReviewPending: patient.woundPhotos.some(photo => this.isRealWoundPhoto(photo) && photo.reviewStatus === 'pendente')
    };
  }

  private isRealWoundPhoto(photo: WoundPhoto): boolean {
    return !photo.imageUrl.includes('images.unsplash.com');
  }

  private saveSession(rememberMe: boolean): void {
    try {
      const storage = rememberMe ? localStorage : sessionStorage;
      const otherStorage = rememberMe ? sessionStorage : localStorage;
      storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        role: this.currentRole(),
        patientId: this.activePatientId(),
        token: this.token,
        name: this.sessionName()
      } satisfies StoredSession));
      otherStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // The current session still works when browser storage is unavailable.
    }
  }

  private time(value: Date): string {
    return value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
}
