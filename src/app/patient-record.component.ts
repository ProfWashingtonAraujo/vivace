import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { Tab, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { FormsModule } from '@angular/forms';
import type { Options } from 'highcharts';
import { HighchartsChartDirective } from 'highcharts-angular';
import { AlertSeverity, WoundPhoto } from '../types';
import { VivaceService } from './vivace.service';

type RecordTab = 'wounds' | 'timeline' | 'vitals' | 'meds' | 'chat' | 'notes';

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
  chatMessage = '';
  noteText = '';

  readonly patient = computed(() => this.vivace.patients().find(item => item.id === this.patientId()) ?? this.vivace.patients()[0]);
  readonly selectedPhoto = computed(() => {
    const patient = this.patient();
    return patient.woundPhotos.find(photo => photo.id === this.selectedPhotoId())
      ?? patient.woundPhotos.find(photo => photo.reviewStatus === 'pendente')
      ?? patient.woundPhotos[0];
  });
  readonly painChartOptions = computed<Options>(() => {
    const checkIns = [...this.patient().checkIns].reverse();
    return {
      chart: { type: 'areaspline', height: 280, backgroundColor: 'transparent', spacing: [10, 8, 8, 8] },
      title: { text: 'Evolução da dor', align: 'left', style: { color: '#2D3748', fontSize: '14px', fontWeight: '700' } },
      subtitle: { text: 'Escala visual analógica (EVA)', align: 'left', style: { color: '#718096', fontSize: '10px' } },
      xAxis: { categories: checkIns.map(item => item.dayLabel), tickLength: 0, lineColor: '#E2E8F0' },
      yAxis: {
        min: 0,
        max: 10,
        tickInterval: 2,
        title: { text: '' },
        gridLineColor: '#E2E8F0',
        plotBands: [{ from: 7, to: 10, color: 'rgba(255,127,102,0.10)', label: { text: 'Alerta', style: { color: '#C2412D', fontSize: '10px' } } }]
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
      title: { text: 'Curva de temperatura', align: 'left', style: { color: '#2D3748', fontSize: '14px', fontWeight: '700' } },
      subtitle: { text: 'Medição axilar em °C', align: 'left', style: { color: '#718096', fontSize: '10px' } },
      xAxis: { categories: checkIns.map(item => item.dayLabel), tickLength: 0, lineColor: '#E2E8F0' },
      yAxis: {
        min: 35,
        max: 40,
        tickInterval: 1,
        title: { text: '' },
        gridLineColor: '#E2E8F0',
        plotLines: [{ value: 37.8, color: '#FF7F66', dashStyle: 'Dash', width: 2, label: { text: 'Limite 37,8°C', align: 'right', style: { color: '#C2412D', fontSize: '10px' } } }]
      },
      tooltip: { valueSuffix: '°C', valueDecimals: 1 },
      legend: { enabled: false },
      credits: { enabled: false },
      accessibility: { description: 'Gráfico da evolução da temperatura axilar informada pelo paciente em cada check-in.' },
      plotOptions: { series: { marker: { enabled: true, radius: 4 }, lineWidth: 3 } },
      series: [{ name: 'Temperatura', type: 'spline', color: '#134E4A', data: checkIns.map(item => item.temperature) }]
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

  sendChat(): void {
    this.vivace.sendMessage(this.patient().id, this.chatMessage, 'equipe');
    this.chatMessage = '';
  }

  addNote(): void {
    if (!this.noteText.trim()) return;
    this.vivace.addClinicalNote(this.patient().id, this.noteText);
    this.noteText = '';
    this.savedMessage.set('Nota clínica salva no prontuário.');
    window.setTimeout(() => this.savedMessage.set(''), 3000);
  }
}
