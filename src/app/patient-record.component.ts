import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Tab, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { FormsModule } from '@angular/forms';
import type { Options } from 'highcharts';
import { HighchartsChartDirective } from 'highcharts-angular';
import { AlertSeverity, MedicationItem, PostOpInstruction, TimelineEvent, WoundPhoto } from '../types';
import { VivaceService } from './vivace.service';

type RecordTab = 'wounds' | 'timeline' | 'vitals' | 'meds' | 'care' | 'chat' | 'notes';

interface MedicationFormModel {
  name: string;
  dose: string;
  frequency: string;
  purpose: string;
  instructions: string;
}

interface InstructionFormModel {
  category: PostOpInstruction['category'];
  title: string;
  content: string;
  important: boolean;
}

@Component({
  selector: 'vivace-patient-record',
  standalone: true,
  imports: [FormsModule, Tabs, TabList, Tab, TabPanel, HighchartsChartDirective],
  templateUrl: './patient-record.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientRecordComponent {
  readonly patientId = input.required<string>();
  readonly back = output<void>();
  readonly vivace = inject(VivaceService);
  readonly activeTab = signal<RecordTab>('wounds');
  readonly selectedPhotoId = signal<string | null>(null);
  readonly reviewVerdict = signal<'avaliado_adequado' | 'requer_atencao'>('avaliado_adequado');
  readonly reviewComment = signal('Aspecto cicatricial favorável, sem sinais de infecção. Manter os cuidados habituais.');
  readonly savedMessage = signal('');
  readonly showMedicationForm = signal(false);
  readonly editingMedicationId = signal<string | null>(null);
  readonly medicationTimes = signal<string[]>([]);
  readonly medicationMessage = signal('');
  readonly showInstructionForm = signal(false);
  readonly editingInstructionId = signal<string | null>(null);
  readonly instructionMessage = signal('');
  readonly sendingChat = signal(false);
  readonly chatError = signal('');
  medicationModel = this.emptyMedication();
  medicationTime = '08:00';
  instructionModel = this.emptyInstruction();
  chatMessage = '';
  noteText = '';

  readonly patient = computed(() => this.vivace.patients().find(item => item.id === this.patientId()) ?? this.vivace.patients()[0]);
  readonly timelineEvents = computed(() => [...this.patient().timeline].reverse());
  readonly timelineKinds: Record<TimelineEvent['type'], { label: string; color: string; icon: string }> = {
    cirurgia: { label: 'Cirurgia', color: '#0B2A4A', icon: 'M12 3v18M5 8l7-5 7 5M7 21h10' },
    alta: { label: 'Alta', color: '#1F7A5C', icon: 'M5 12l5 5L20 7' },
    checkin: { label: 'Check-in', color: '#0B5CAB', icon: 'M9 5h6M9 3h6v4H9zM6 5H5v16h14V5h-1M9 14l2 2 4-4' },
    curativo: { label: 'Curativo', color: '#92400E', icon: 'M4 8h16v8H4zM9 8v8M15 8v8' },
    mensagem: { label: 'Mensagem', color: '#52627A', icon: 'M4 5h16v11H9l-5 4z' },
    medicacao: { label: 'Medicação', color: '#6D4BC2', icon: 'M8 4h8l3 3v13H5V7zM9 12h6M12 9v6' }
  };
  readonly woundPhotos = computed(() => this.patient().woundPhotos.filter(photo => !photo.imageUrl.includes('images.unsplash.com')));
  readonly selectedPhoto = computed(() => {
    const photos = this.woundPhotos();
    return photos.find(photo => photo.id === this.selectedPhotoId())
      ?? photos.find(photo => photo.reviewStatus === 'pendente')
      ?? photos[0];
  });
  readonly painChartOptions = computed<Options>(() => {
    const checkIns = [...this.patient().checkIns].reverse();
    return {
      chart: { type: 'areaspline', height: 280, backgroundColor: 'transparent', spacing: [10, 8, 8, 8] },
      title: { text: 'Evolução da dor', align: 'left', style: { color: '#1B2B3F', fontSize: '14px', fontWeight: '700' } },
      subtitle: { text: 'Escala visual analógica (EVA)', align: 'left', style: { color: '#52627A', fontSize: '12px' } },
      xAxis: { categories: checkIns.map(item => item.dayLabel), tickLength: 0, lineColor: '#D9E2EC' },
      yAxis: {
        min: 0,
        max: 10,
        tickInterval: 2,
        title: { text: '' },
        gridLineColor: '#D9E2EC',
        plotBands: [{ from: 7, to: 10, color: 'rgba(255,127,102,0.10)', label: { text: 'Alerta', style: { color: '#C2412D', fontSize: '12px' } } }]
      },
      tooltip: { valueSuffix: '/10' },
      legend: { enabled: false },
      credits: { enabled: false },
      accessibility: { description: 'Gráfico da evolução do nível de dor informado pelo paciente em cada check-in.' },
      plotOptions: { series: { marker: { enabled: true, radius: 4 }, lineWidth: 3 }, areaspline: { fillOpacity: 0.12 } },
      series: [{ name: 'Dor', type: 'areaspline', color: '#FF7F66', data: checkIns.map(item => item.painLevel) }]
    };
  });
  readonly temperatureChartOptions = computed<Options>(() => {
    const checkIns = [...this.patient().checkIns].reverse();
    return {
      chart: { type: 'spline', height: 280, backgroundColor: 'transparent', spacing: [10, 8, 8, 8] },
      title: { text: 'Curva de temperatura', align: 'left', style: { color: '#1B2B3F', fontSize: '14px', fontWeight: '700' } },
      subtitle: { text: 'Medição axilar em °C', align: 'left', style: { color: '#52627A', fontSize: '12px' } },
      xAxis: { categories: checkIns.map(item => item.dayLabel), tickLength: 0, lineColor: '#D9E2EC' },
      yAxis: {
        min: 35,
        max: 40,
        tickInterval: 1,
        title: { text: '' },
        gridLineColor: '#D9E2EC',
        plotLines: [{ value: 37.8, color: '#FF7F66', dashStyle: 'Dash', width: 2, label: { text: 'Limite 37,8°C', align: 'right', x: -4, y: -6, style: { color: '#C2412D', fontSize: '12px' } } }]
      },
      tooltip: { valueSuffix: '°C', valueDecimals: 1 },
      legend: { enabled: false },
      credits: { enabled: false },
      accessibility: { description: 'Gráfico da evolução da temperatura axilar informada pelo paciente em cada check-in.' },
      plotOptions: { series: { marker: { enabled: true, radius: 4 }, lineWidth: 3 } },
      series: [{ name: 'Temperatura', type: 'spline', color: '#0B5CAB', data: checkIns.map(item => item.temperature) }]
    };
  });

  selectPhoto(photo: WoundPhoto): void {
    this.selectedPhotoId.set(photo.id);
    if (photo.reviewFeedback) this.reviewComment.set(photo.reviewFeedback);
  }

  saveReview(): void {
    const photo = this.selectedPhoto();
    if (!photo || !this.reviewComment().trim()) return;
    this.vivace.reviewWoundPhoto(this.patient().id, photo.id, this.reviewVerdict(), this.reviewComment());
    this.savedMessage.set('Parecer registrado e disponibilizado ao paciente.');
    window.setTimeout(() => this.savedMessage.set(''), 3000);
  }

  updateStatus(status: AlertSeverity): void {
    this.vivace.updatePatientStatus(this.patient().id, status);
  }

  formatDate(value: string): string {
    const [year, month, day] = value.split('-');
    return year && month && day ? `${day}/${month}/${year}` : value;
  }

  newMedication(): void {
    this.editingMedicationId.set(null);
    this.medicationModel = this.emptyMedication();
    this.medicationTimes.set([]);
    this.medicationTime = '08:00';
    this.showMedicationForm.set(true);
  }

  editMedication(medication: MedicationItem): void {
    this.editingMedicationId.set(medication.id);
    this.medicationModel = {
      name: medication.name,
      dose: medication.dose,
      frequency: medication.frequency,
      purpose: medication.purpose,
      instructions: medication.instructions
    };
    this.medicationTimes.set([...medication.times]);
    this.showMedicationForm.set(true);
  }

  addMedicationTime(): void {
    if (!this.medicationTime || this.medicationTimes().includes(this.medicationTime)) return;
    this.medicationTimes.update(times => [...times, this.medicationTime].sort());
  }

  removeMedicationTime(time: string): void {
    this.medicationTimes.update(times => times.filter(item => item !== time));
  }

  saveMedication(): void {
    const medication = {
      name: this.medicationModel.name.trim(),
      dose: this.medicationModel.dose.trim(),
      frequency: this.medicationModel.frequency.trim(),
      purpose: this.medicationModel.purpose.trim(),
      instructions: this.medicationModel.instructions.trim(),
      times: this.medicationTimes()
    };
    if (Object.values(medication).some(value => typeof value === 'string' && !value) || !medication.times.length) {
      this.showMedicationFeedback('Preencha todos os campos e adicione ao menos um horário.');
      return;
    }

    const editingId = this.editingMedicationId();
    if (editingId) this.vivace.updateMedication(this.patient().id, editingId, medication);
    else this.vivace.addMedication(this.patient().id, medication);
    this.cancelMedicationEdit();
    this.showMedicationFeedback(editingId ? 'Medicamento atualizado com sucesso.' : 'Medicamento adicionado à prescrição.');
  }

  deleteMedication(medication: MedicationItem): void {
    if (!window.confirm(`Excluir ${medication.name} da prescrição?`)) return;
    this.vivace.deleteMedication(this.patient().id, medication.id);
    if (this.editingMedicationId() === medication.id) this.cancelMedicationEdit();
    this.showMedicationFeedback('Medicamento excluído da prescrição.');
  }

  cancelMedicationEdit(): void {
    this.showMedicationForm.set(false);
    this.editingMedicationId.set(null);
    this.medicationModel = this.emptyMedication();
    this.medicationTimes.set([]);
  }

  newInstruction(): void {
    this.editingInstructionId.set(null);
    this.instructionModel = this.emptyInstruction();
    this.showInstructionForm.set(true);
  }

  editInstruction(instruction: PostOpInstruction): void {
    this.editingInstructionId.set(instruction.id);
    this.instructionModel = {
      category: instruction.category,
      title: instruction.title,
      content: instruction.content,
      important: Boolean(instruction.important)
    };
    this.showInstructionForm.set(true);
  }

  saveInstruction(): void {
    const instruction = {
      category: this.instructionModel.category,
      title: this.instructionModel.title.trim(),
      content: this.instructionModel.content.trim(),
      important: this.instructionModel.important,
      iconName: this.instructionModel.category
    };
    if (!instruction.title || !instruction.content) {
      this.showInstructionFeedback('Informe o título e o conteúdo da orientação.');
      return;
    }

    const editingId = this.editingInstructionId();
    if (editingId) this.vivace.updateInstruction(this.patient().id, editingId, instruction);
    else this.vivace.addInstruction(this.patient().id, instruction);
    this.cancelInstructionEdit();
    this.showInstructionFeedback(editingId ? 'Orientação atualizada com sucesso.' : 'Orientação enviada ao paciente.');
  }

  deleteInstruction(instruction: PostOpInstruction): void {
    if (!window.confirm(`Excluir a orientação “${instruction.title}”?`)) return;
    this.vivace.deleteInstruction(this.patient().id, instruction.id);
    if (this.editingInstructionId() === instruction.id) this.cancelInstructionEdit();
    this.showInstructionFeedback('Orientação excluída.');
  }

  cancelInstructionEdit(): void {
    this.showInstructionForm.set(false);
    this.editingInstructionId.set(null);
    this.instructionModel = this.emptyInstruction();
  }

  async sendChat(): Promise<void> {
    if (!this.chatMessage.trim() || this.sendingChat()) return;
    this.sendingChat.set(true);
    this.chatError.set('');
    const saved = await this.vivace.sendMessage(this.patient().id, this.chatMessage, 'equipe');
    this.sendingChat.set(false);
    if (saved) this.chatMessage = '';
    else this.chatError.set('Não foi possível enviar. Verifique a conexão e tente novamente.');
  }

  addNote(): void {
    if (!this.noteText.trim()) return;
    this.vivace.addClinicalNote(this.patient().id, this.noteText);
    this.noteText = '';
    this.savedMessage.set('Nota clínica salva no prontuário.');
    window.setTimeout(() => this.savedMessage.set(''), 3000);
  }

  private showMedicationFeedback(message: string): void {
    this.medicationMessage.set(message);
    window.setTimeout(() => this.medicationMessage.set(''), 3000);
  }

  private emptyMedication(): MedicationFormModel {
    return { name: '', dose: '', frequency: '', purpose: '', instructions: '' };
  }

  private showInstructionFeedback(message: string): void {
    this.instructionMessage.set(message);
    window.setTimeout(() => this.instructionMessage.set(''), 3000);
  }

  private emptyInstruction(): InstructionFormModel {
    return { category: 'curativo', title: '', content: '', important: false };
  }
}
