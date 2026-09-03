import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AccordionContent, AccordionGroup, AccordionPanel, AccordionTrigger } from '@angular/aria/accordion';
import { Tab, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { FormsModule } from '@angular/forms';
import { DailyCheckIn } from '../types';
import { VivaceService } from './vivace.service';

type PatientTab = 'summary' | 'checkin' | 'medications' | 'care' | 'messages';

@Component({
  selector: 'vivace-patient-portal',
  standalone: true,
  imports: [
    FormsModule,
    Tabs,
    TabList,
    Tab,
    TabPanel,
    AccordionGroup,
    AccordionTrigger,
    AccordionPanel,
    AccordionContent
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
  readonly patient = this.vivace.selectedPatient;
  readonly todayCheckIn = computed(() => this.patient()?.checkIns[0]);
  readonly lastPhoto = computed(() => this.patient()?.woundPhotos[0]);

  painLevel = this.patient()?.currentPain ?? 3;
  temperature = this.patient()?.currentTemp ?? 36.7;
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

  readonly faqs = [
    { question: 'É normal sentir repuxamento ou leve ardor nas incisões?', answer: 'Pode ocorrer nos primeiros dias. Avise a equipe se houver vermelhidão crescente, secreção, calor local ou piora importante da dor.' },
    { question: 'Como aliviar o desconforto de gases no ombro ou tórax?', answer: 'Pequenas caminhadas dentro de casa e a medicação prescrita podem ajudar. Procure atendimento se houver falta de ar ou dor intensa.' },
    { question: 'Posso tomar banho e molhar os curativos?', answer: 'Siga a orientação específica da sua equipe. Use água corrente e sabonete neutro, sem esfregar, e seque com toques suaves.' },
    { question: 'Quando posso dirigir e fazer exercícios?', answer: 'A liberação depende do procedimento e da evolução. Confirme com sua equipe no retorno antes de retomar essas atividades.' }
  ];

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

  submitCheckIn(): void {
    const patient = this.patient();
    if (!patient) return;
    if (this.photoUrl()) this.vivace.uploadWoundPhoto(patient.id, this.photoUrl(), this.photoNotes || this.notes);
    this.vivace.submitDailyCheckIn(patient.id, {
      date: new Date().toLocaleDateString('pt-BR'),
      dayLabel: `D+${patient.postOpDay}`,
      painLevel: this.painLevel,
      temperature: this.temperature,
      mobilityScore: this.mobilityScore,
      symptoms: this.symptoms(),
      notes: this.notes,
      mood: this.mood,
      photoUploaded: Boolean(this.photoUrl())
    });
    this.photoUrl.set('');
    this.photoName.set('');
    this.photoNotes = '';
    this.checkInSaved.set(true);
  }

  finishCheckIn(): void {
    this.checkInSaved.set(false);
    this.activeTab.set('summary');
  }

  sendMessage(text = this.message): void {
    const patient = this.patient();
    if (!patient || !text.trim()) return;
    this.vivace.sendMessage(patient.id, text, 'paciente');
    this.message = '';
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
