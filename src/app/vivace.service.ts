import { Injectable, computed, effect, signal } from '@angular/core';
import { CURRENT_PROFESSIONAL, INITIAL_PATIENTS } from '../data/mockData';
import { AlertSeverity, ChatMessage, DailyCheckIn, Patient, ProfessionalUser, UserRole, WoundPhoto } from '../types';

const STORAGE_KEY = 'vivace_patients_v2';
const PROFESSIONALS_STORAGE_KEY = 'vivace_professionals_v1';

@Injectable({ providedIn: 'root' })
export class VivaceService {
  private readonly patientsState = signal<Patient[]>(this.loadPatients());
  private readonly professionalsState = signal<ProfessionalUser[]>(this.loadProfessionals());

  readonly patients = this.patientsState.asReadonly();
  readonly professionals = this.professionalsState.asReadonly();
  readonly activePatientId = signal('pat-1');
  readonly currentRole = signal<UserRole>('professional');
  readonly isLoggedIn = signal(false);
  readonly professionalUser = computed(() => this.professionals()[0] ?? CURRENT_PROFESSIONAL);
  readonly selectedPatient = computed(() =>
    this.patients().find(patient => patient.id === this.activePatientId()) ?? this.patients()[0]
  );

  constructor() {
    effect(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.patients()));
      } catch {
        // The demo remains usable when browser storage is unavailable.
      }
    });
    effect(() => {
      try {
        localStorage.setItem(PROFESSIONALS_STORAGE_KEY, JSON.stringify(this.professionals()));
      } catch {
        // The demo remains usable when browser storage is unavailable.
      }
    });
  }

  loginAs(role: UserRole, patientId?: string): void {
    this.currentRole.set(role);
    if (patientId) this.activePatientId.set(patientId);
    this.isLoggedIn.set(true);
  }

  logout(): void {
    this.isLoggedIn.set(false);
  }

  resetToDefaults(): void {
    this.patientsState.set(structuredClone(INITIAL_PATIENTS));
    this.professionalsState.set([structuredClone(CURRENT_PROFESSIONAL)]);
    this.activePatientId.set('pat-1');
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PROFESSIONALS_STORAGE_KEY);
  }

  addProfessional(professional: Omit<ProfessionalUser, 'id'>): void {
    this.professionalsState.update(professionals => [
      ...professionals,
      { ...professional, id: `prof-${Date.now()}` }
    ]);
  }

  updateProfessional(id: string, changes: Omit<ProfessionalUser, 'id' | 'avatar'>): void {
    this.professionalsState.update(professionals => professionals.map(professional =>
      professional.id === id ? { ...professional, ...changes, password: changes.password || professional.password } : professional
    ));
  }

  deleteProfessional(id: string): boolean {
    if (this.professionals().length <= 1) return false;
    this.professionalsState.update(professionals => professionals.filter(professional => professional.id !== id));
    return true;
  }

  addPatient(patient: Pick<Patient, 'name' | 'age' | 'gender' | 'email' | 'password' | 'phone' | 'cpf' | 'procedure' | 'surgeryDate' | 'dischargeDate' | 'hospital'>): void {
    const surgeryDate = new Date(`${patient.surgeryDate}T12:00:00`);
    const postOpDay = Number.isNaN(surgeryDate.getTime())
      ? 0
      : Math.max(0, Math.floor((Date.now() - surgeryDate.getTime()) / 86_400_000));
    const professional = this.professionals()[0] ?? CURRENT_PROFESSIONAL;
    const newPatient: Patient = {
      ...patient,
      id: `pat-${Date.now()}`,
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(patient.name)}&background=E6F4F1&color=134E4A`,
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
  }

  updatePatientRegistration(id: string, changes: Pick<Patient, 'name' | 'age' | 'gender' | 'email' | 'password' | 'phone' | 'cpf' | 'procedure' | 'surgeryDate' | 'dischargeDate' | 'hospital'>): void {
    const surgeryDate = new Date(`${changes.surgeryDate}T12:00:00`);
    const postOpDay = Number.isNaN(surgeryDate.getTime())
      ? 0
      : Math.max(0, Math.floor((Date.now() - surgeryDate.getTime()) / 86_400_000));
    this.updatePatient(id, patient => ({ ...patient, ...changes, password: changes.password || patient.password, postOpDay }));
  }

  deletePatient(id: string): boolean {
    if (this.patients().length <= 1) return false;
    this.patientsState.update(patients => patients.filter(patient => patient.id !== id));
    if (this.activePatientId() === id) this.activePatientId.set(this.patients()[0].id);
    return true;
  }

  submitDailyCheckIn(patientId: string, data: Omit<DailyCheckIn, 'id'>): void {
    this.updatePatient(patientId, patient => {
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

  uploadWoundPhoto(patientId: string, imageUrl: string, patientNotes?: string): void {
    this.updatePatient(patientId, patient => {
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
        woundReviewPending: woundPhotos.some(photo => photo.reviewStatus === 'pendente'),
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

  sendMessage(patientId: string, text: string, sender: ChatMessage['sender']): void {
    const messageText = text.trim();
    if (!messageText) return;
    this.updatePatient(patientId, patient => ({
      ...patient,
      messages: [...patient.messages, {
        id: `msg-${Date.now()}`,
        sender,
        senderName: sender === 'equipe' ? this.professionalUser().name : patient.name,
        timestamp: `Hoje às ${this.time(new Date())}`,
        text: messageText,
        isRead: sender === 'equipe'
      }]
    }));
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

  private updatePatient(patientId: string, updater: (patient: Patient) => Patient): void {
    this.patientsState.update(patients => patients.map(patient => patient.id === patientId ? updater(patient) : patient));
  }

  private loadPatients(): Patient[] {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (value) return JSON.parse(value) as Patient[];
    } catch {
      // Fall back to bundled demonstration data.
    }
    return structuredClone(INITIAL_PATIENTS);
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

  private date(value: Date): string {
    return value.toLocaleDateString('pt-BR');
  }

  private time(value: Date): string {
    return value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
}
