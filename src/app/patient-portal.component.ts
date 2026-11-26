import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Tab, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { FormsModule } from '@angular/forms';
import { DailyCheckIn } from '../types';
import { VivaceService } from './vivace.service';
import { spo2Band } from './spo2';

type PatientTab = 'summary' | 'checkin' | 'medications' | 'care' | 'messages';

@Component({
  selector: 'vivace-patient-portal',
  standalone: true,
  imports: [
    FormsModule,
    Tabs,
    TabList,
    Tab,
    TabPanel
  ],
  templateUrl: './patient-portal.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientPortalComponent {
  readonly vivace = inject(VivaceService);
  readonly activeTab = signal<PatientTab>('summary');
  readonly checkInSaved = signal(false);
  readonly symptoms = signal<string[]>([]);
  readonly photoUrl = signal('');
  readonly photoName = signal('');
  readonly photoError = signal('');
  readonly processingPhoto = signal(false);
  readonly savingCheckIn = signal(false);
  readonly sendingMessage = signal(false);
  readonly messageError = signal('');
  readonly patient = this.vivace.selectedPatient;
  // O cirurgião da equipe do próprio paciente ("Nome (CRM)" no cadastro), sem o CRM.
  readonly surgeonName = computed(() => (this.patient()?.surgeon ?? '').replace(/\s*\([^)]*\)\s*$/, '') || 'Equipe de cirurgia');
  readonly todayCheckIn = computed(() => {
    const day = (label: string) => Number(/\d+/.exec(label)?.[0] ?? 0);
    return this.patient()?.checkIns.reduce<DailyCheckIn | undefined>((latest, item) => !latest || day(item.dayLabel) > day(latest.dayLabel) ? item : latest, undefined);
  });
  // Um check-in por dia, contado no fuso de São Paulo, o mesmo que o servidor usa.
  readonly viewMonth = signal(this.currentMonth());
  readonly doneDays = computed(() => new Set((this.patient()?.checkIns ?? []).map(item => this.dayKey(item.date))));
  readonly checkedInToday = computed(() => this.doneDays().has(this.todayKey()));
  // Um por dia, a menos que a equipe reabra o de hoje.
  readonly checkInOpen = computed(() => !this.checkedInToday() || Boolean(this.patient()?.checkInReopened));
  readonly monthTitle = computed(() => {
    const { year, month } = this.viewMonth();
    return new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  });
  readonly calendarCells = computed(() => {
    const { year, month } = this.viewMonth();
    const today = this.todayKey();
    const offset = new Date(year, month, 1).getDay();
    const total = new Date(year, month + 1, 0).getDate();
    const done = this.doneDays();
    return [
      ...Array.from({ length: offset }, () => null),
      ...Array.from({ length: total }, (_, index) => {
        const key = this.dayKey(`${index + 1}/${month + 1}/${year}`);
        return { day: index + 1, done: done.has(key), today: key === today };
      })
    ];
  });
  // Linha do dia: cada horário de cada remédio vira uma dose, em ordem de relógio (fuso de
  // São Paulo, o mesmo do servidor). "Se dor" nunca fica atrasada: não tem hora obrigatória.
  private readonly nowMinutes = signal(this.saoPauloMinutes());
  private readonly pendingDoses = signal<ReadonlySet<string>>(new Set());
  readonly doseSlots = computed(() => {
    const now = this.nowMinutes();
    const pending = this.pendingDoses();
    const slots = (this.patient()?.medications ?? []).flatMap(med => med.times.map(time => {
      const [hour, minute] = time.split(':').map(Number);
      const key = `${med.id}|${time}`;
      return {
        key, med, time, minutes: hour * 60 + minute, taken: Boolean(med.takenToday[time]),
        asNeeded: /se dor|se necess/i.test(med.frequency), saving: pending.has(key)
      };
    })).sort((a, b) => a.minutes - b.minutes || a.med.name.localeCompare(b.med.name));
    const nextKey = slots.find(slot => !slot.taken && slot.minutes >= now - 60)?.key;
    return slots.map(slot => ({
      ...slot,
      state: slot.taken ? 'taken' : slot.key === nextKey ? 'next' : !slot.asNeeded && slot.minutes < now - 60 ? 'late' : 'later'
    }));
  });
  readonly dosesTaken = computed(() => this.doseSlots().filter(slot => slot.taken).length);
  readonly nextDoseText = computed(() => {
    const slots = this.doseSlots();
    const next = slots.find(slot => slot.state === 'next');
    if (next) return `Próxima: ${next.time} · ${next.med.name}`;
    if (slots.every(slot => slot.taken)) return 'Todas as doses de hoje foram tomadas.';
    return slots.some(slot => slot.state === 'late') ? 'Há doses com horário passado. Confirme as que você já tomou.' : 'Sem próxima dose hoje.';
  });
  readonly weekDays = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
  readonly lastPhoto = computed(() => this.patient()?.woundPhotos.find(photo => !photo.imageUrl.includes('images.unsplash.com')));

  painLevel = this.patient()?.currentPain ?? 3;
  temperature = this.patient()?.currentTemp ?? 36.7;
  spo2: number | null = null;
  readonly spo2Band = spo2Band;
  mobilityScore: DailyCheckIn['mobilityScore'] = 'caminha_pouco';
  mood: DailyCheckIn['mood'] = 'bem';
  notes = '';
  photoNotes = '';
  message = '';

  readonly availableSymptoms = [
    'Ardor no local da cirurgia', 'Gases ou estômago cheio', 'Dor no ombro ou costas',
    'Náusea ou falta de apetite', 'Inchaço moderado', 'Tontura ao levantar',
    'Intestino preso', 'Sensação de cansaço'
  ];

  constructor() {
    const timer = setInterval(() => this.nowMinutes.set(this.saoPauloMinutes()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  async toggleDose(medicationId: string, time: string): Promise<void> {
    const patient = this.patient();
    const key = `${medicationId}|${time}`;
    if (!patient || this.pendingDoses().has(key)) return;
    this.pendingDoses.update(keys => new Set(keys).add(key));
    try {
      await this.vivace.toggleMedicationTaken(patient.id, medicationId, time);
    } finally {
      this.pendingDoses.update(keys => { const next = new Set(keys); next.delete(key); return next; });
    }
  }

  private saoPauloMinutes(): number {
    const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date()).split(':').map(Number);
    return hour * 60 + minute;
  }

  shiftMonth(amount: number): void {
    this.viewMonth.update(({ year, month }) => {
      const next = new Date(year, month + amount, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  }

  private currentMonth(): { year: number; month: number } {
    const [year, month] = this.todayKey().split('/').slice(1).reverse().map(Number);
    return { year, month: month - 1 };
  }

  private todayKey(): string {
    const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()).split('-');
    return this.dayKey(`${day}/${month}/${year}`);
  }

  // 'd/m/aaaa' (com ou sem zeros) vira 'dd/mm/aaaa', a forma que o servidor grava.
  private dayKey(label: string): string {
    const [day = '', month = '', year = ''] = label.split('/');
    return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
  }

  // Saturação é opcional; informada, tem de ser inteira de 50 a 100 (o servidor recusa o resto).
  spo2Invalid(): boolean {
    return this.spo2 !== null && this.spo2 !== undefined && (!Number.isInteger(this.spo2) || this.spo2 < 50 || this.spo2 > 100);
  }

  toggleSymptom(symptom: string): void {
    this.symptoms.update(items => items.includes(symptom) ? items.filter(item => item !== symptom) : [...items, symptom]);
  }

  changeTemperature(amount: number): void {
    this.temperature = Math.min(41, Math.max(35, Number((this.temperature + amount).toFixed(1))));
  }

  async selectPhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.photoError.set('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      this.photoError.set('Escolha uma imagem JPEG, PNG ou WebP.');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      this.photoError.set('A foto deve ter no máximo 8 MB.');
      return;
    }

    this.processingPhoto.set(true);
    try {
      this.photoUrl.set(await this.compressPhoto(file));
      this.photoName.set(file.name);
    } catch {
      this.photoError.set('Não foi possível processar a foto. Tente outra imagem.');
    } finally {
      this.processingPhoto.set(false);
    }
  }

  removePhoto(): void {
    this.photoUrl.set('');
    this.photoName.set('');
    this.photoError.set('');
  }

  async submitCheckIn(): Promise<void> {
    const patient = this.patient();
    if (!patient || this.savingCheckIn() || !this.checkInOpen() || this.spo2Invalid()) return;
    this.savingCheckIn.set(true);
    this.photoError.set('');
    const photo = this.photoUrl()
      ? { imageUrl: this.photoUrl(), patientNotes: this.photoNotes || this.notes }
      : undefined;
    const saved = await this.vivace.submitDailyCheckIn(patient.id, {
      date: new Date().toLocaleDateString('pt-BR'),
      dayLabel: `D+${patient.postOpDay}`,
      painLevel: this.painLevel,
      temperature: this.temperature,
      spo2: this.spo2 ?? null,
      mobilityScore: this.mobilityScore,
      symptoms: this.symptoms(),
      notes: this.notes,
      mood: this.mood,
      photoUploaded: Boolean(this.photoUrl())
    }, photo);
    this.finishSavingCheckIn(saved);
  }

  private finishSavingCheckIn(saved: boolean): void {
    this.savingCheckIn.set(false);
    if (!saved) {
      this.photoError.set('Não foi possível enviar o check-in. Verifique a conexão e tente novamente.');
      return;
    }
    this.photoUrl.set('');
    this.photoName.set('');
    this.photoNotes = '';
    this.checkInSaved.set(true);
  }

  finishCheckIn(): void {
    this.checkInSaved.set(false);
    this.activeTab.set('summary');
  }

  async sendMessage(text = this.message): Promise<void> {
    const patient = this.patient();
    if (!patient || !text.trim() || this.sendingMessage()) return;
    this.sendingMessage.set(true);
    this.messageError.set('');
    const saved = await this.vivace.sendMessage(patient.id, text, 'paciente');
    this.sendingMessage.set(false);
    if (saved) this.message = '';
    else this.messageError.set('Não foi possível enviar. Verifique a conexão e tente novamente.');
  }

  private compressPhoto(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const source = URL.createObjectURL(file);
      image.onload = () => {
        const maxDimension = 1280;
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        if (!context) {
          URL.revokeObjectURL(source);
          reject(new Error('Canvas unavailable'));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(source);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      image.onerror = () => {
        URL.revokeObjectURL(source);
        reject(new Error('Invalid image'));
      };
      image.src = source;
    });
  }
}
