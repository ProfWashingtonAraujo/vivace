import { Injectable, computed, effect, signal } from '@angular/core';
import { CURRENT_PROFESSIONAL, INITIAL_PATIENTS } from '../data/mockData';
import { AlertSeverity, ChatMessage, DailyCheckIn, MedicationItem, Patient, PostOpInstruction, ProfessionalUser, UserRole, WoundPhoto } from '../types';

const STORAGE_KEY = 'vivace_patients_v2';
const PROFESSIONALS_STORAGE_KEY = 'vivace_professionals_v1';
const SESSION_STORAGE_KEY = 'vivace_session_v1';
const SYNC_PENDING_STORAGE_KEY = 'vivace_sync_pending_v1';
const SYNC_INTERVAL_MS = 3_000;

interface StoredSession {
  role: UserRole;
  patientId: string;
}

@Injectable({ providedIn: 'root' })
export class VivaceService {
  private readonly storedSession = this.loadSession();
  private readonly patientsState = signal<Patient[]>(this.loadPatients());
  private readonly professionalsState = signal<ProfessionalUser[]>(this.loadProfessionals());
  private saveQueue = Promise.resolve();
  private pendingSaves = 0;
  private stateRevision = 0;
  private hasUnsavedChanges = this.loadSyncPending();

  readonly patients = this.patientsState.asReadonly();
  readonly professionals = this.professionalsState.asReadonly();
  readonly activePatientId = signal(this.storedSession?.patientId ?? 'pat-1');
  readonly currentRole = signal<UserRole>(this.storedSession?.role ?? 'professional');
  readonly isLoggedIn = signal(this.storedSession !== null);
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
    this.listenForMessages();
    window.setInterval(() => void this.loadSharedState(false), SYNC_INTERVAL_MS);
    effect(() => {
      try {
        localStorage.setItem(PROFESSIONALS_STORAGE_KEY, JSON.stringify(this.professionals()));
      } catch {
        // The demo remains usable when browser storage is unavailable.
      }
    });
  }

  loginAs(role: UserRole, patientId?: string, rememberMe = false): void {
    this.currentRole.set(role);
    if (patientId) this.activePatientId.set(patientId);
    this.isLoggedIn.set(true);
    this.saveSession(rememberMe);
  }

  logout(): void {
    this.isLoggedIn.set(false);
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // The demo remains usable when browser storage is unavailable.
    }
  }

  syncPendingChanges(): Promise<boolean> {
    return this.saveSharedState();
  }

  resetToDefaults(): void {
    this.patientsState.set(structuredClone(INITIAL_PATIENTS));
    this.professionalsState.set([structuredClone(CURRENT_PROFESSIONAL)]);
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

  submitDailyCheckIn(patientId: string, data: Omit<DailyCheckIn, 'id'>): Promise<boolean> {
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

  toggleMedicationTaken(patientId: string, medicationId: string, time: string): void {
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
    if (!messageText || !patient) return false;
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
      const response = await fetch(this.apiUrl('/api/messages'), {
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
    if (this.pendingSaves > 0) return;
    if (this.hasUnsavedChanges) {
      await this.saveSharedState();
      return;
    }
    try {
      const response = await fetch(this.apiUrl());
      if (response.status === 204) {
        if (initialize) await this.saveSharedState();
        return;
      }
      if (!response.ok) return;
      const state = await response.json() as { patients?: Patient[]; professionals?: ProfessionalUser[] };
      const professional = state.professionals?.[0] ?? this.professionalUser();
      const patients = state.patients
        ? this.assignPrimaryProfessional(state.patients.map(patient => this.normalizePatient(patient)), professional)
        : undefined;
      if (Array.isArray(patients) && JSON.stringify(patients) !== JSON.stringify(this.patients())) {
        this.patientsState.set(patients);
      }
      if (Array.isArray(state.professionals) && JSON.stringify(state.professionals) !== JSON.stringify(this.professionals())) {
        this.professionalsState.set(state.professionals);
      }
    } catch {
      // Local storage keeps the application available when the shared API is offline.
    }
  }

  private saveSharedState(): Promise<boolean> {
    this.stateRevision++;
    this.hasUnsavedChanges = true;
    this.storeSyncPending(true);
    this.pendingSaves++;
    const operation = this.saveQueue.then(async () => {
      const revision = this.stateRevision;
      try {
        const response = await fetch(this.apiUrl(), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patients: this.patients(), professionals: this.professionals() })
        });
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

  private apiUrl(path = '/api/state'): string {
    return `${location.protocol}//${location.hostname}:3001${path}`;
  }

  private listenForMessages(): void {
    const events = new EventSource(this.apiUrl('/api/events'));
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
        patientId: this.activePatientId()
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
