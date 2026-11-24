import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
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
  readonly chatScroll = viewChild<ElementRef<HTMLElement>>('chatScroll');
  readonly chatSuggestions = ['Mantenha repouso e beba bastante água.', 'Envie uma foto do curativo pelo portal.', 'Vamos agendar o seu retorno. Qual o melhor horário?'];

  constructor() {
    // Keep the newest message in view when the tab opens and whenever a message arrives.
    afterRenderEffect(() => {
      const count = this.patient().messages.length;
      const element = this.chatScroll()?.nativeElement;
      if (element && count >= 0) element.scrollTop = element.scrollHeight;
    });
  }
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
  readonly medicationSummary = computed(() => {
    const doses = this.patient().medications
      .flatMap(medication => medication.times.map(time => ({ name: medication.name, dose: medication.dose, time, taken: !!medication.takenToday[time] })))
      .sort((first, second) => this.doseOrder(first.time).localeCompare(this.doseOrder(second.time)));
    const taken = doses.filter(dose => dose.taken).length;
    const pending = doses.filter(dose => !dose.taken);
    const nowTime = this.currentTime();
    return {
      total: doses.length,
      taken,
      percent: doses.length ? Math.round(taken / doses.length * 100) : 100,
      late: pending.filter(dose => this.doseOrder(dose.time) < nowTime).length,
      next: pending.find(dose => this.doseOrder(dose.time) >= nowTime) ?? null
    };
  });

  doseState(medication: MedicationItem, time: string): 'tomada' | 'atrasada' | 'pendente' {
    if (medication.takenToday[time]) return 'tomada';
    return this.doseOrder(time) < this.currentTime() ? 'atrasada' : 'pendente';
  }

  /** A 00:00 dose belongs to the end of the day, not the start. */
  private doseOrder(time: string): string {
    return time === '00:00' ? '24:00' : time;
  }

  private currentTime(): string {
    return new Date().toTimeString().slice(0, 5);
  }

  readonly careKinds: Record<PostOpInstruction['category'], { label: string; icon: string }> = {
    curativo: { label: 'Curativo', icon: 'M4 8h16v8H4zM9 8v8M15 8v8' },
    alimentacao: { label: 'Alimentação', icon: 'M7 3v8a2 2 0 0 0 4 0V3M9 11v10M17 3c-2 2-3 4-3 7h3v11' },
    atividade: { label: 'Atividade física', icon: 'M13 4a1.5 1.5 0 1 0 0 .01M8 21l3-6 3 2 2-5-4-3-3 3-3-1' },
    higiene: { label: 'Higiene', icon: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z' },
    alerta: { label: 'Sinal de alerta', icon: 'M12 8v5M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' },
    medicacao: { label: 'Medicação', icon: 'M8 4h8l3 3v13H5V7zM9 12h6M12 9v6' }
  };
  /** Important guidance first, keeping the team's own order inside each group. */
  readonly sortedInstructions = computed(() => {
    const list = this.patient().instructions;
    return [...list.filter(item => item.important), ...list.filter(item => !item.important)];
  });
  readonly importantInstructionCount = computed(() => this.patient().instructions.filter(item => item.important).length);
  readonly woundPhotos = computed(() => this.patient().woundPhotos.filter(photo => !photo.imageUrl.includes('images.unsplash.com')));
  readonly selectedPhoto = computed(() => {
    const photos = this.woundPhotos();
    return photos.find(photo => photo.id === this.selectedPhotoId())
      ?? photos.find(photo => photo.reviewStatus === 'pendente')
      ?? photos[0];
  });
  /** Check-ins ordered from oldest to newest by post-op day, whatever order they are stored in. */
  readonly chronologicalCheckIns = computed(() => {
    const day = (label: string) => Number(/\d+/.exec(label)?.[0] ?? 0);
    return [...this.patient().checkIns].reverse().sort((first, second) => day(first.dayLabel) - day(second.dayLabel));
  });
  readonly painChartOptions = computed<Options>(() => {
    const checkIns = this.chronologicalCheckIns();
    const level = (pain: number) => pain >= 7 ? { label: 'Intensa', color: '#C2412D' } : pain >= 4 ? { label: 'Moderada', color: '#B45309' } : { label: 'Leve', color: '#1F7A5C' };
    const last = checkIns.at(-1);
    const previous = checkIns.at(-2);
    const delta = last && previous ? last.painLevel - previous.painLevel : 0;
    const trend = !previous ? '' : delta === 0 ? ' · igual ao registro anterior' : delta < 0 ? ` · ${-delta} ${-delta === 1 ? 'ponto' : 'pontos'} abaixo do registro anterior` : ` · ${delta} ${delta === 1 ? 'ponto' : 'pontos'} acima do registro anterior`;
    return {
      chart: { type: 'spline', height: 280, backgroundColor: 'transparent', spacing: [10, 12, 8, 8] },
      title: { text: 'Evolução da dor', align: 'left', style: { color: '#1B2B3F', fontSize: '14px', fontWeight: '700' } },
      subtitle: { text: last ? `Último registro: ${last.painLevel}/10 (${level(last.painLevel).label.toLowerCase()}) em ${last.dayLabel}${trend}` : 'Sem registros de dor', align: 'left', style: { color: '#52627A', fontSize: '12px' } },
      xAxis: { categories: checkIns.map(item => item.dayLabel), tickLength: 0, lineColor: '#D9E2EC', labels: { style: { color: '#52627A', fontSize: '12px' } } },
      yAxis: {
        min: 0,
        max: 10,
        tickInterval: 2,
        title: { text: '' },
        gridLineColor: '#E6ECF2',
        labels: { style: { color: '#52627A', fontSize: '12px' } },
        plotBands: [
          { from: 0, to: 3.5, color: 'rgba(31,122,92,0.07)', label: { text: 'Leve', align: 'right', x: -6, y: -4, verticalAlign: 'bottom', style: { color: '#1F7A5C', fontSize: '12px' } } },
          { from: 3.5, to: 6.5, color: 'rgba(180,83,9,0.07)', label: { text: 'Moderada', align: 'right', x: -6, y: 16, style: { color: '#B45309', fontSize: '12px' } } },
          { from: 6.5, to: 10, color: 'rgba(194,65,45,0.08)', label: { text: 'Intensa', align: 'right', x: -6, y: 16, style: { color: '#C2412D', fontSize: '12px' } } }
        ]
      },
      tooltip: {
        useHTML: false,
        formatter() {
          const point = this as unknown as { x: string; y: number };
          const item = checkIns.find(entry => entry.dayLabel === point.x);
          return `${point.x}${item ? ` · ${item.date}` : ''} — Dor ${point.y}/10 (${level(point.y).label.toLowerCase()})`;
        }
      },
      legend: { enabled: false },
      credits: { enabled: false },
      accessibility: { description: `Gráfico da evolução do nível de dor em cada check-in. ${checkIns.map(item => `${item.dayLabel}: ${item.painLevel} de 10`).join('; ')}.` },
      plotOptions: { series: { lineWidth: 3, marker: { enabled: true, radius: 6, lineWidth: 2, lineColor: '#FFFFFF' }, dataLabels: { enabled: true, y: -4, style: { color: '#1B2B3F', fontSize: '12px', fontWeight: '700', textOutline: 'none' }, format: '{y}' } },
      },
      series: [{ name: 'Dor', type: 'spline', color: '#0B5CAB', data: checkIns.map(item => ({ y: item.painLevel, color: level(item.painLevel).color })) }]
    };
  });
  readonly temperatureChartOptions = computed<Options>(() => {
    const checkIns = this.chronologicalCheckIns();
    const level = (temperature: number) => temperature >= 37.8 ? { label: 'Febre', color: '#C2412D' } : temperature >= 37.3 ? { label: 'Febrícula', color: '#B45309' } : { label: 'Normal', color: '#1F7A5C' };
    const format = (value: number) => value.toFixed(1).replace('.', ',');
    const last = checkIns.at(-1);
    const previous = checkIns.at(-2);
    const delta = last && previous ? Math.round((last.temperature - previous.temperature) * 10) / 10 : 0;
    const trend = !previous ? '' : delta === 0 ? ' · igual ao registro anterior' : ` · ${delta < 0 ? 'queda' : 'alta'} de ${format(Math.abs(delta))}°C desde o registro anterior`;
    const max = Math.max(39, Math.ceil(Math.max(...checkIns.map(item => item.temperature), 0) + 0.5));
    return {
      chart: { type: 'spline', height: 280, backgroundColor: 'transparent', spacing: [10, 12, 8, 8] },
      title: { text: 'Curva de temperatura', align: 'left', style: { color: '#1B2B3F', fontSize: '14px', fontWeight: '700' } },
      subtitle: { text: last ? `Último registro: ${format(last.temperature)}°C (${level(last.temperature).label.toLowerCase()}) em ${last.dayLabel}${trend}` : 'Sem registros de temperatura', align: 'left', style: { color: '#52627A', fontSize: '12px' } },
      xAxis: { categories: checkIns.map(item => item.dayLabel), tickLength: 0, lineColor: '#D9E2EC', labels: { style: { color: '#52627A', fontSize: '12px' } } },
      yAxis: {
        min: 35.5,
        max,
        tickInterval: 0.5,
        title: { text: '' },
        gridLineColor: '#E6ECF2',
        labels: { format: '{value:.1f}', style: { color: '#52627A', fontSize: '12px' } },
        plotBands: [
          { from: 35.5, to: 37.25, color: 'rgba(31,122,92,0.07)', label: { text: 'Normal', align: 'right', x: -6, y: -4, verticalAlign: 'bottom', style: { color: '#1F7A5C', fontSize: '12px' } } },
          { from: 37.25, to: 37.75, color: 'rgba(180,83,9,0.09)' },
          { from: 37.75, to: max, color: 'rgba(194,65,45,0.08)', label: { text: 'Febre (≥ 37,8°C)', align: 'right', x: -6, y: 16, style: { color: '#C2412D', fontSize: '12px' } } }
        ]
      },
      tooltip: {
        formatter() {
          const point = this as unknown as { x: string; y: number };
          const item = checkIns.find(entry => entry.dayLabel === point.x);
          return `${point.x}${item ? ` · ${item.date}` : ''} — ${format(point.y)}°C (${level(point.y).label.toLowerCase()})`;
        }
      },
      legend: { enabled: false },
      credits: { enabled: false },
      accessibility: { description: `Gráfico da temperatura axilar em cada check-in. ${checkIns.map(item => `${item.dayLabel}: ${format(item.temperature)} graus`).join('; ')}.` },
      plotOptions: { series: { lineWidth: 3, marker: { enabled: true, radius: 6, lineWidth: 2, lineColor: '#FFFFFF' }, dataLabels: { enabled: true, y: -4, style: { color: '#1B2B3F', fontSize: '12px', fontWeight: '700', textOutline: 'none' }, formatter() { return format(this.y ?? 0); } } },
      },
      series: [{ name: 'Temperatura', type: 'spline', color: '#0B5CAB', data: checkIns.map(item => ({ y: item.temperature, color: level(item.temperature).color })) }]
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
