import { ChangeDetectionStrategy, Component, computed, inject, signal, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AlertSeverity, Patient } from '../types';
import { VivaceService } from './vivace.service';
import { PatientManagementComponent } from './patient-management.component';

type StatusFilter = 'todos' | AlertSeverity | 'pendente_foto';
type DayFilter = 'todos' | 'd0_d3' | 'd4_d7' | 'd8_plus';

@Component({
  selector: 'vivace-professional-dashboard',
  standalone: true,
  imports: [FormsModule, PatientManagementComponent],
  templateUrl: './professional-dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfessionalDashboardComponent {
  readonly vivace = inject(VivaceService);
  readonly openPatient = output<string>();
  readonly searchQuery = signal('');
  readonly statusFilter = signal<StatusFilter>('todos');
  readonly dayFilter = signal<DayFilter>('todos');
  readonly managingPatients = signal(false);

  readonly criticalPatients = computed(() => this.vivace.patients().filter(patient => patient.status === 'critico'));
  readonly criticalCount = computed(() => this.criticalPatients().length);
  readonly attentionCount = computed(() => this.vivace.patients().filter(patient => patient.status === 'atencao').length);
  readonly stableCount = computed(() => this.vivace.patients().filter(patient => patient.status === 'estavel').length);
  readonly pendingCount = computed(() => this.vivace.patients().filter(patient => patient.woundReviewPending).length);
  readonly filteredPatients = computed(() => {
    const query = this.searchQuery().trim().toLocaleLowerCase('pt-BR');
    return this.vivace.patients().filter(patient => {
      const matchesQuery = !query || patient.name.toLocaleLowerCase('pt-BR').includes(query)
        || patient.procedure.toLocaleLowerCase('pt-BR').includes(query)
        || patient.cpf.includes(query);
      const status = this.statusFilter();
      const matchesStatus = status === 'todos' || (status === 'pendente_foto' ? patient.woundReviewPending : patient.status === status);
      const day = this.dayFilter();
      const matchesDay = day === 'todos'
        || (day === 'd0_d3' && patient.postOpDay <= 3)
        || (day === 'd4_d7' && patient.postOpDay >= 4 && patient.postOpDay <= 7)
        || (day === 'd8_plus' && patient.postOpDay >= 8);
      return matchesQuery && matchesStatus && matchesDay;
    });
  });

  statusLabel(status: AlertSeverity): string {
    return status === 'critico' ? 'Alerta crítico' : status === 'atencao' ? 'Atenção' : 'Estável';
  }

  statusClasses(status: AlertSeverity): string {
    return status === 'critico' ? 'bg-[#FFE5E0] text-[#C2412D]' : status === 'atencao' ? 'bg-[#FEF3C7] text-[#92400E]' : 'bg-[#D1FAE5] text-[#134E4A]';
  }

  clearFilters(): void {
    this.searchQuery.set('');
    this.statusFilter.set('todos');
    this.dayFilter.set('todos');
  }

  trackPatient(_: number, patient: Patient): string {
    return patient.id;
  }
}
