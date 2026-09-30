import { Injectable, computed, effect, signal } from '@angular/core';
import { CURRENT_ADMIN, CURRENT_PROFESSIONAL, INITIAL_PATIENTS } from '../data/mockData';
import { AdminUser, AlertSeverity, ChatMessage, DailyCheckIn, MedicationItem, Patient, PostOpInstruction, ProfessionalUser, UserRole, WoundPhoto } from '../types';

const STORAGE_KEY = 'vivace_patients_v2';
const PROFESSIONALS_STORAGE_KEY = 'vivace_professionals_v1';
const SESSION_STORAGE_KEY = 'vivace_session_v1';
const SYNC_PENDING_STORAGE_KEY = 'vivace_sync_pending_v1';
const SYNC_INTERVAL_MS = 3_000;

declare const VIVACE_API_PORT: string;

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
  private saveQueue = Promise.resolve();
  private pendingSaves = 0;
  private stateRevision = 0;
  private hasUnsavedChanges = this.loadSyncPending();
  private token = this.storedSession?.token ?? '';

  readonly patients = this.patientsState.asReadonly();
  readonly professionals = this.professionalsState.asReadonly();
  readonly admins = this.adminsState.asReadonly();
  readonly activePatientId = signal(this.storedSession?.role === 'patient' ? this.storedSession.patientId : 'pat-1');
  readonly currentRole = signal<UserRole>(this.storedSession?.role ?? 'professional');
  readonly isLoggedIn = signal(this.storedSession !== null);
  readonly sessionName = signal(this.storedSession?.name ?? '');
  readonly professionalUser = computed(() => this.professionals()[0] ?? CURRENT_PROFESSIONAL);
  readonly selectedPatient = computed(() =>
    this.patients().find(patient => patient.id === this.activePatientId()) ?? this.patients()[0]
  );

  constructor() {
    this.patientsState.update(patients => this.assignPrimaryProfessional(patients, this.professionalUser()));
    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.patients()));
      } catch {
        // The demo remains usable when browser storage is unavailable.
      }
    });
    void this.loadSharedState();
    if (this.token) this.listenForMessages();
    window.setInterval(() => void this.loadSharedState(false), SYNC_INTERVAL_MS);
    effect(() => {
      try {
        localStorage.setItem(PROFESSIONALS_STORAGE_KEY, JSON.stringify(this.professionals()));
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
    this.isLoggedIn.set(false);
    this.sessionName.set('');
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
        headers: this.authHeaders()
      });
    } catch {
      // The session is already discarded locally.
    }
  }

  syncPendingChanges(): Promise<boolean> {
    return this.saveSharedState();
  }

  resetToDefaults(): void {
    this.patientsState.set(structuredClone(INITIAL_PATIENTS));
    this.professionalsState.set([structuredClone(CURRENT_PROFESSIONAL)]);
    this.adminsState.set([structuredClone(CURRENT_ADMIN)]);
    this.activePatientId.set('pat-1');
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROFESSIONALS_STORAGE_KEY);
    void this.saveSharedState();
  }

  addProfessional(professional: Omit<ProfessionalUser, 'id'>): Promise<boolean> {
    this.professionalsState.update(professionals => [
      ...professionals,
      { ...professional, id: `prof-${Date.now()}` }
    ]);
    return this.saveSharedState();
  }

  updateProfessional(id: string, changes: Omit<ProfessionalUser, 'id' | 'avatar'>, avatar?: string): Promise<boolean> {
    const currentProfessional = this.professionals().find(professional => professional.id === id);
    this.professionalsState.update(professionals => professionals.map(professional =>
      professional.id === id ? {
        ...professional,
        ...changes,
        avatar: avatar === undefined ? professional.avatar : avatar || this.avatarFor(changes.name),
        password: changes.password || professional.password
      } : professional
    ));
    if (currentProfessional) {
      const currentSurgeon = `${currentProfessional.name} (${currentProfessional.crmCoren})`;
      const defaultSurgeon = `${CURRENT_PROFESSIONAL.name} (${CURRENT_PROFESSIONAL.crmCoren})`;
      const updatedSurgeon = `${changes.name} (${changes.crmCoren})`;
      this.patientsState.update(patients => patients.map(patient => patient.surgeon === currentSurgeon || patient.surgeon === defaultSurgeon
        ? { ...patient, surgeon: updatedSurgeon }
        : patient));
    }
    return this.saveSharedState();
  }

  deleteProfessional(id: string): boolean {
    if (this.professionals().length <= 1) return false;
    this.professionalsState.update(professionals => professionals.filter(professional => professional.id !== id));
    void this.saveSharedState();
    return true;
  }

  addPatient(patient: Pick<Patient, 'name' | 'age' | 'gender' | 'email' | 'password' | 'phone' | 'cpf' | 'procedure' | 'surgeryDate' | 'dischargeDate' | 'hospital'>, avatar?: string): Promise<boolean> {
    const surgeryDate = new Date(`${patient.surgeryDate}T12:00:00`);
    const postOpDay = Number.isNaN(surgeryDate.getTime())
      ? 0
      : Math.max(0, Math.floor((Date.now() - surgeryDate.getTime()) / 86_400_000));
    const professional = this.professionals()[0] ?? CURRENT_PROFESSIONAL;
    const newPatient: Patient = {
      ...patient,
      id: `pat-${Date.now()}`,
      avatar: avatar || this.avatarFor(patient.name),
      surgeon: `${professional.name} (${professional.crmCoren})`,
      anesthesiaType: 'Não informado',
      allergies: [],
      status: 'estavel',
      postOpDay,
      lastCheckInTime: 'Aguardando primeiro check-in',
      currentPain: 0,
      currentTemp: 36.5,
      bloodPressure: 'Não informado',
      heartRate: 0,
      woundReviewPending: false,
      medicationAdherencePercent: 100,
      emergencyContact: { name: 'Não informado', phone: '', relationship: '' },
      timeline: [],
      woundPhotos: [],
      medications: [],
      checkIns: [],
      messages: [],
      instructions: [],
      clinicalNotes: []
    };
    this.patientsState.update(patients => [...patients, newPatient]);
    return this.saveSharedState();
  }

  updatePatientRegistration(id: string, changes: Pick<Patient, 'name' | 'age' | 'gender' | 'email' | 'password' | 'phone' | 'cpf' | 'procedure' | 'surgeryDate' | 'dischargeDate' | 'hospital'>, avatar?: string): Promise<boolean> {
    const surgeryDate = new Date(`${changes.surgeryDate}T12:00:00`);
    const postOpDay = Number.isNaN(surgeryDate.getTime())
      ? 0
      : Math.max(0, Math.floor((Date.now() - surgeryDate.getTime()) / 86_400_000));
    return this.updatePatient(id, patient => ({
      ...patient,
      ...changes,
      avatar: avatar === undefined ? patient.avatar : avatar || this.avatarFor(changes.name),
      password: changes.password || patient.password,
      postOpDay
    }));
  }

  deletePatient(id: string): boolean {
    if (this.patients().length <= 1) return false;
    this.patientsState.update(patients => patients.filter(patient => patient.id !== id));
    if (this.activePatientId() === id) this.activePatientId.set(this.patients()[0].id);
    void this.saveSharedState();
    return true;
  }

  submitDailyCheckIn(patientId: string, data: Omit<DailyCheckIn, 'id'>, photo?: { imageUrl: string; patientNotes?: string }): Promise<boolean> {
    if (this.currentRole() === 'patient') return this.sendPatientCheckIn(patientId, data, photo);
    return this.updatePatient(patientId, patient => {
      const now = new Date();
      const status: AlertSeverity = data.painLevel >= 7 || data.temperature >= 37.8
        ? 'critico'
        : data.painLevel >= 4 || data.temperature >= 37.3
          ? 'atencao'
          : 'estavel';
      const checkIn: DailyCheckIn = { ...data, id: `chk-${Date.now()}` };

      return {
        ...patient,
        checkIns: [checkIn, ...patient.checkIns],
        currentPain: data.painLevel,
        currentTemp: data.temperature,
        lastCheckInTime: `Hoje às ${this.time(now)}`,
        status,
        timeline: [...patient.timeline, {
          id: `tl-${Date.now()}`,
          date: `${this.date(now)} ${this.time(now)}`,
          dayLabel: data.dayLabel,
          title: `Check-in Diário (${data.dayLabel})`,
          description: `Dor ${data.painLevel}/10, Temp ${data.temperature}°C. ${data.notes ?? ''}`.trim(),
          author: `${patient.name} (Paciente)`,
          type: 'checkin'
        }]
      };
    });
  }

  private async sendPatientCheckIn(patientId: string, data: Omit<DailyCheckIn, 'id'>, photo?: { imageUrl: string; patientNotes?: string }): Promise<boolean> {
    if (!this.token) return false;
    try {
      const response = await this.authFetch(this.apiUrl('/api/checkins'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: `chk-${Date.now()}`,
          patientId,
          checkIn: data,
          photo: photo ? { id: `wp-${Date.now()}`, imageUrl: photo.imageUrl, patientNotes: photo.patientNotes } : undefined
        })
      });
      if (response.status === 401) {
        await this.handleUnauthorized();
        return false;
      }
      if (!response.ok) return false;
      const result = await response.json() as { patient: Patient };
      this.mergePatient(result.patient);
      this.hasUnsavedChanges = false;
      this.storeSyncPending(false);
      return true;
    } catch {
      return false;
    }
  }

  private mergePatient(patient: Patient): void {
    this.patientsState.update(patients => patients.map(item => item.id === patient.id ? patient : item));
  }

  private async confirmDoseAsPatient(patientId: string, medicationId: string, time: string): Promise<boolean> {
    if (!this.token) return false;
    try {
      const response = await this.authFetch(this.apiUrl('/api/medication-taken'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId, medicationId, time })
      });
      if (response.status === 401) {
        await this.handleUnauthorized();
        return false;
      }
      if (!response.ok) return false;
      const result = await response.json() as { patient: Patient };
      this.mergePatient(result.patient);
      return true;
    } catch {
      return false;
    }
  }

  toggleMedicationTaken(patientId: string, medicationId: string, time: string): void {
    if (this.currentRole() === 'patient') {
      void this.confirmDoseAsPatient(patientId, medicationId, time);
      return;
    }
    this.updatePatient(patientId, patient => {
      const medications = patient.medications.map(medication => medication.id === medicationId
        ? { ...medication, takenToday: { ...medication.takenToday, [time]: !medication.takenToday[time] } }
        : medication);
      const slots = medications.flatMap(medication => medication.times.map(item => medication.takenToday[item]));
      const adherence = slots.length ? Math.round(slots.filter(Boolean).length / slots.length * 100) : 100;
      return { ...patient, medications, medicationAdherencePercent: adherence };
    });
  }

  addMedication(patientId: string, medication: Omit<MedicationItem, 'id' | 'takenToday'>): void {
    this.updatePatient(patientId, patient => {
      const medications = [...patient.medications, {
        ...medication,
        id: `med-${Date.now()}`,
        takenToday: Object.fromEntries(medication.times.map(time => [time, false]))
      }];
      return { ...patient, medications, medicationAdherencePercent: this.medicationAdherence(medications) };
    });
  }

  updateMedication(patientId: string, medicationId: string, changes: Omit<MedicationItem, 'id' | 'takenToday'>): void {
    this.updatePatient(patientId, patient => {
      const medications = patient.medications.map(medication => medication.id === medicationId ? {
        ...changes,
        id: medication.id,
        takenToday: Object.fromEntries(changes.times.map(time => [time, medication.takenToday[time] ?? false]))
      } : medication);
      return { ...patient, medications, medicationAdherencePercent: this.medicationAdherence(medications) };
    });
  }

  deleteMedication(patientId: string, medicationId: string): void {
    this.updatePatient(patientId, patient => {
      const medications = patient.medications.filter(medication => medication.id !== medicationId);
      return { ...patient, medications, medicationAdherencePercent: this.medicationAdherence(medications) };
    });
  }

  addInstruction(patientId: string, instruction: Omit<PostOpInstruction, 'id'>): void {
    this.updatePatient(patientId, patient => ({
      ...patient,
      instructions: [...patient.instructions, { ...instruction, id: `inst-${Date.now()}` }]
    }));
  }

  updateInstruction(patientId: string, instructionId: string, changes: Omit<PostOpInstruction, 'id'>): void {
    this.updatePatient(patientId, patient => ({
      ...patient,
      instructions: patient.instructions.map(instruction => instruction.id === instructionId
        ? { ...changes, id: instruction.id }
        : instruction)
    }));
  }

  deleteInstruction(patientId: string, instructionId: string): void {
    this.updatePatient(patientId, patient => ({
      ...patient,
      instructions: patient.instructions.filter(instruction => instruction.id !== instructionId)
    }));
  }

  uploadWoundPhoto(patientId: string, imageUrl: string, patientNotes?: string): Promise<boolean> {
    return this.updatePatient(patientId, patient => {
      const now = new Date();
      const photo: WoundPhoto = {
        id: `wp-${Date.now()}`,
        date: this.date(now),
        dayLabel: `D+${patient.postOpDay}`,
        imageUrl,
        patientNotes,
        reviewStatus: 'pendente'
      };
      return {
        ...patient,
        woundPhotos: [photo, ...patient.woundPhotos],
        woundReviewPending: true,
        timeline: [...patient.timeline, {
          id: `tl-${Date.now()}`,
          date: `${this.date(now)} ${this.time(now)}`,
          dayLabel: photo.dayLabel,
          title: 'Nova Foto da Ferida Cirúrgica Enviada',
          description: patientNotes || 'Registro fotográfico enviado para avaliação.',
          author: `${patient.name} (Paciente)`,
          type: 'curativo'
        }]
      };
    });
  }

  reviewWoundPhoto(patientId: string, photoId: string, status: WoundPhoto['reviewStatus'], feedback: string): void {
    if (status === 'pendente') return;
    this.updatePatient(patientId, patient => {
      const now = new Date();
      const woundPhotos = patient.woundPhotos.map(photo => photo.id === photoId ? {
        ...photo,
        reviewStatus: status,
        reviewFeedback: feedback,
        reviewedBy: this.professionalUser().name,
        reviewedAt: `${this.date(now)} às ${this.time(now)}`
      } : photo);
      return {
        ...patient,
        woundPhotos,
        woundReviewPending: woundPhotos.some(photo => this.isRealWoundPhoto(photo) && photo.reviewStatus === 'pendente'),
        timeline: [...patient.timeline, {
          id: `tl-${Date.now()}`,
          date: `${this.date(now)} ${this.time(now)}`,
          dayLabel: `D+${patient.postOpDay}`,
          title: status === 'avaliado_adequado' ? 'Cicatrização aprovada' : 'Ferida requer atenção',
          description: feedback,
          author: this.professionalUser().name,
          type: 'curativo'
        }]
      };
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
      senderName: sender === 'equipe' ? this.professionalUser().name : patient.name,
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

  addClinicalNote(patientId: string, text: string): void {
    const noteText = text.trim();
    if (!noteText) return;
    this.updatePatient(patientId, patient => ({
      ...patient,
      clinicalNotes: [{
        id: `cn-${Date.now()}`,
        author: this.professionalUser().name,
        date: `${this.date(new Date())} ${this.time(new Date())}`,
        text: noteText
      }, ...patient.clinicalNotes]
    }));
  }

  updatePatientStatus(patientId: string, status: AlertSeverity): void {
    this.updatePatient(patientId, patient => ({ ...patient, status }));
  }

  private updatePatient(patientId: string, updater: (patient: Patient) => Patient): Promise<boolean> {
    this.patientsState.update(patients => patients.map(patient => patient.id === patientId ? updater(patient) : patient));
    return this.saveSharedState();
  }

  private medicationAdherence(medications: MedicationItem[]): number {
    const slots = medications.flatMap(medication => medication.times.map(time => medication.takenToday[time]));
    return slots.length ? Math.round(slots.filter(Boolean).length / slots.length * 100) : 100;
  }

  private avatarFor(name: string): string {
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=E6F4F1&color=134E4A`;
  }

  private assignPrimaryProfessional(patients: Patient[], professional: ProfessionalUser): Patient[] {
    const defaultSurgeon = `${CURRENT_PROFESSIONAL.name} (${CURRENT_PROFESSIONAL.crmCoren})`;
    const updatedSurgeon = `${professional.name} (${professional.crmCoren})`;
    return patients.map(patient => patient.surgeon === defaultSurgeon ? { ...patient, surgeon: updatedSurgeon } : patient);
  }

  private async loadSharedState(initialize = true): Promise<void> {
    if (!this.token || this.pendingSaves > 0) return;
    if (this.hasUnsavedChanges) {
      await this.saveSharedState();
      return;
    }
    try {
      const response = await this.authFetch(this.apiUrl());
      if (response.status === 401) {
        await this.handleUnauthorized();
        return;
      }
      if (response.status === 204) {
        if (initialize) await this.saveSharedState();
        return;
      }
      if (!response.ok) return;
      const state = await response.json() as { patients?: Patient[]; professionals?: ProfessionalUser[]; admins?: AdminUser[] };
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
      // Local storage keeps the application available when the shared API is offline.
    }
  }

  private saveSharedState(): Promise<boolean> {
    if (!this.token || this.currentRole() === 'patient') return Promise.resolve(false);
    this.stateRevision++;
    this.hasUnsavedChanges = true;
    this.storeSyncPending(true);
    this.pendingSaves++;
    const operation = this.saveQueue.then(async () => {
      const revision = this.stateRevision;
      try {
        const response = await this.authFetch(this.apiUrl(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patients: this.patients(),
            professionals: this.professionals(),
            admins: this.admins()
          })
        });
        if (response.status === 401) {
          await this.handleUnauthorized();
          return false;
        }
        if (response.status === 403) return false;
        if (!response.ok) return false;
        if (this.stateRevision === revision) {
          this.hasUnsavedChanges = false;
          this.storeSyncPending(false);
        }
        return true;
      } catch {
        return false;
      } finally {
        this.pendingSaves--;
      }
    });
    this.saveQueue = operation.then(() => undefined);
    return operation;
  }

  private async handleUnauthorized(): Promise<void> {
    this.storeSyncPending(false);
    await this.logout();
  }

  private apiUrl(path = '/api/state'): string {
    return `${location.protocol}//${location.hostname}:${apiPort()}${path}`;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async authFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.authHeaders())) headers.set(name, value);
    return fetch(url, { ...init, headers });
  }

  private listenForMessages(): void {
    const separator = this.apiUrl('/api/events').includes('?') ? '&' : '?';
    const events = new EventSource(`${this.apiUrl('/api/events')}${separator}token=${encodeURIComponent(this.token)}`);
    events.onmessage = event => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; patientId?: string; message?: ChatMessage };
        if (payload.type === 'message.created' && payload.patientId && payload.message) {
          this.mergeChatMessage(payload.patientId, payload.message);
        }
      } catch {
        // Invalid events are ignored; polling remains available as a fallback.
      }
    };
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

  private loadPatients(): Patient[] {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (value) return (JSON.parse(value) as Patient[]).map(patient => this.normalizePatient(patient));
    } catch {
      // Fall back to bundled demonstration data.
    }
    return structuredClone(INITIAL_PATIENTS).map(patient => this.normalizePatient(patient));
  }

  private loadProfessionals(): ProfessionalUser[] {
    try {
      const value = localStorage.getItem(PROFESSIONALS_STORAGE_KEY);
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

  private loadSyncPending(): boolean {
    try {
      return localStorage.getItem(SYNC_PENDING_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private storeSyncPending(pending: boolean): void {
    try {
      if (pending) localStorage.setItem(SYNC_PENDING_STORAGE_KEY, 'true');
      else localStorage.removeItem(SYNC_PENDING_STORAGE_KEY);
    } catch {
      // In-memory retries still protect the current session when storage is unavailable.
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

  private date(value: Date): string {
    return value.toLocaleDateString('pt-BR');
  }

  private time(value: Date): string {
    return value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
}
