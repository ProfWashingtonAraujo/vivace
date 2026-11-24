import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AdminDashboardComponent } from './admin-dashboard.component';
import { AuthComponent } from './auth.component';
import { PatientPortalComponent } from './patient-portal.component';
import { PatientRecordComponent } from './patient-record.component';
import { ProfessionalDashboardComponent } from './professional-dashboard.component';
import { VivaceService } from './vivace.service';

@Component({
  selector: 'vivace-root',
  standalone: true,
  imports: [AdminDashboardComponent, AuthComponent, PatientPortalComponent, PatientRecordComponent, ProfessionalDashboardComponent],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  readonly vivace = inject(VivaceService);
  readonly viewingRecordId = signal<string | null>(null);
  readonly showAlerts = signal(false);
  readonly alertPatients = computed(() => this.vivace.patients().filter(patient => patient.status !== 'estavel' || patient.woundReviewPending));

  openPatient(patientId: string): void {
    this.vivace.activePatientId.set(patientId);
    this.viewingRecordId.set(patientId);
    this.showAlerts.set(false);
  }

  resetDemo(): void {
    if (!window.confirm('Restaurar os dados de demonstração? Todos os pacientes, profissionais e registros atuais serão substituídos, para todos os aparelhos conectados.')) return;
    this.vivace.resetToDefaults();
  }

  logout(): void {
    this.viewingRecordId.set(null);
    this.showAlerts.set(false);
    void this.vivace.logout();
  }
}
