export type UserRole = 'professional' | 'patient' | 'admin';

export type AlertSeverity = 'estavel' | 'atencao' | 'critico';

export interface TimelineEvent {
  id: string;
  date: string;
  dayLabel: string; // e.g. "D+0", "D+1", "D+3"
  title: string;
  description: string;
  author: string;
  type: 'cirurgia' | 'alta' | 'checkin' | 'curativo' | 'mensagem' | 'medicacao';
}

export interface WoundPhoto {
  id: string;
  date: string;
  dayLabel: string;
  imageUrl: string;
  patientNotes?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewStatus: 'pendente' | 'avaliado_adequado' | 'requer_atencao';
  reviewFeedback?: string;
}

export interface MedicationItem {
  id: string;
  name: string;
  dose: string;
  frequency: string;
  purpose: string;
  times: string[]; // e.g. ["08:00", "16:00", "00:00"]
  instructions: string;
  takenToday: { [time: string]: boolean };
}

export interface DailyCheckIn {
  id: string;
  date: string;
  dayLabel: string;
  painLevel: number; // 0-10
  temperature: number; // °C
  mobilityScore: 'repouso_absoluto' | 'caminha_pouco' | 'caminha_bem' | 'plena';
  symptoms: string[];
  notes?: string;
  mood: 'otimo' | 'bem' | 'desconfortavel' | 'preocupado' | 'com_dor';
  photoUploaded?: boolean;
}

export interface ChatMessage {
  id: string;
  sender: 'paciente' | 'equipe';
  senderName: string;
  timestamp: string;
  text: string;
  isRead: boolean;
}

export interface PostOpInstruction {
  id: string;
  category: 'curativo' | 'alimentacao' | 'atividade' | 'higiene' | 'alerta' | 'medicacao';
  title: string;
  content: string;
  iconName: string;
  important?: boolean;
}

export interface Patient {
  id: string;
  name: string;
  age: number;
  gender: string;
  avatar: string;
  email: string;
  password?: string;
  phone: string;
  cpf: string;
  procedure: string;
  surgeryDate: string;
  dischargeDate: string;
  hospital: string;
  surgeon: string;
  anesthesiaType: string;
  allergies: string[];
  status: AlertSeverity;
  postOpDay: number;
  lastCheckInTime: string;
  currentPain: number;
  currentTemp: number;
  bloodPressure: string;
  heartRate: number;
  woundReviewPending: boolean;
  medicationAdherencePercent: number;
  emergencyContact: {
    name: string;
    phone: string;
    relationship: string;
  };
  timeline: TimelineEvent[];
  woundPhotos: WoundPhoto[];
  medications: MedicationItem[];
  checkIns: DailyCheckIn[];
  messages: ChatMessage[];
  instructions: PostOpInstruction[];
  clinicalNotes: {
    id: string;
    author: string;
    date: string;
    text: string;
  }[];
}

export interface ProfessionalUser {
  id: string;
  name: string;
  role: string;
  crmCoren: string;
  avatar: string;
  email: string;
  password?: string;
  specialty: string;
}
