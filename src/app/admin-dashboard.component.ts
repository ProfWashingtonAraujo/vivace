import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { Patient, ProfessionalUser } from '../types';
import { VivaceService } from './vivace.service';

interface ProfessionalFormModel {
  name: string;
  email: string;
  crmCoren: string;
  specialty: string;
  role: string;
  password: string;
  passwordConfirmation: string;
}

interface PatientFormModel {
  name: string;
  age: number;
  gender: string;
  email: string;
  phone: string;
  cpf: string;
  procedure: string;
  surgeryDate: string;
  dischargeDate: string;
  hospital: string;
  password: string;
  passwordConfirmation: string;
}

@Component({
  selector: 'vivace-admin-dashboard',
  standalone: true,
  imports: [FormField],
  templateUrl: './admin-dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AdminDashboardComponent {
  readonly vivace = inject(VivaceService);
  readonly section = signal<'professional' | 'patient'>('professional');
  readonly feedbackMessage = signal('');
  readonly feedbackError = signal(false);
  readonly editingProfessionalId = signal<string | null>(null);
  readonly editingPatientId = signal<string | null>(null);
  readonly professionalModel = signal<ProfessionalFormModel>(this.emptyProfessional());
  readonly patientModel = signal<PatientFormModel>(this.emptyPatient());
  readonly professionalForm = form(this.professionalModel, path => {
    required(path.name);
    required(path.email);
    required(path.crmCoren);
    required(path.specialty);
    required(path.role);
  });
  readonly patientForm = form(this.patientModel, path => {
    required(path.name);
    required(path.age);
    required(path.gender);
    required(path.email);
    required(path.phone);
    required(path.cpf);
    required(path.procedure);
    required(path.surgeryDate);
    required(path.dischargeDate);
    required(path.hospital);
  });

  saveProfessional(event: Event): void {
    event.preventDefault();
    if (!this.validatePassword(this.professionalModel(), Boolean(this.editingProfessionalId()))) return;
    void submit(this.professionalForm, async () => {
      const { passwordConfirmation: _, ...professional } = this.professionalModel();
      const editingId = this.editingProfessionalId();
      if (editingId) {
        this.vivace.updateProfessional(editingId, professional);
      } else {
        this.vivace.addProfessional({
          ...professional,
          avatar: `https://ui-avatars.com.com/api/?name=${encodeURIComponent(professional.name)}&background=134E4A&color=ffffff`
        });
      }
      this.professionalModel.set(this.emptyProfessional());
      this.editingProfessionalId.set(null);
      this.showFeedback(editingId ? 'Profissional atualizado com sucesso.' : 'Profissional cadastrado com sucesso.');
    });
  }

  savePatient(event: Event): void {
    event.preventDefault();
    if (!this.validatePassword(this.patientModel(), Boolean(this.editingPatientId()))) return;
    void submit(this.patientForm, async () => {
      const editingId = this.editingPatientId();
      const { passwordConfirmation: _, ...patient } = this.patientModel();
      if (editingId) {
        this.vivace.updatePatientRegistration(editingId, patient);
      } else {
        this.vivace.addPatient(patient);
      }
      this.patientModel.set(this.emptyPatient());
      this.editingPatientId.set(null);
      this.showFeedback(editingId ? 'Paciente atualizado com sucesso.' : 'Paciente cadastrado com sucesso.');
    });
  }

  editProfessional(professional: ProfessionalUser): void {
    this.section.set('professional');
    this.editingProfessionalId.set(professional.id);
    this.professionalModel.set({
      name: professional.name,
      email: professional.email,
      crmCoren: professional.crmCoren,
      specialty: professional.specialty,
      role: professional.role,
      password: '',
      passwordConfirmation: ''
    });
  }

  editPatient(patient: Patient): void {
    this.section.set('patient');
    this.editingPatientId.set(patient.id);
    this.patientModel.set({
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      email: patient.email,
      phone: patient.phone,
      cpf: patient.cpf,
      procedure: patient.procedure,
      surgeryDate: patient.surgeryDate,
      dischargeDate: patient.dischargeDate,
      hospital: patient.hospital,
      password: '',
      passwordConfirmation: ''
    });
  }

  cancelProfessionalEdit(): void {
    this.editingProfessionalId.set(null);
    this.professionalModel.set(this.emptyProfessional());
  }

  cancelPatientEdit(): void {
    this.editingPatientId.set(null);
    this.patientModel.set(this.emptyPatient());
  }

  deleteProfessional(professional: ProfessionalUser): void {
    if (!window.confirm(`Excluir o cadastro de ${professional.name}?`)) return;
    if (!this.vivace.deleteProfessional(professional.id)) {
      this.showFeedback('Mantenha ao menos um profissional cadastrado.', true);
      return;
    }
    if (this.editingProfessionalId() === professional.id) this.cancelProfessionalEdit();
    this.showFeedback('Profissional excluído com sucesso.');
  }

  deletePatient(patient: Patient): void {
    if (!window.confirm(`Excluir o cadastro de ${patient.name}?`)) return;
    if (!this.vivace.deletePatient(patient.id)) {
      this.showFeedback('Mantenha ao menos um paciente cadastrado.', true);
      return;
    }
    if (this.editingPatientId() === patient.id) this.cancelPatientEdit();
    this.showFeedback('Paciente excluído com sucesso.');
  }

  private showFeedback(message: string, error = false): void {
    this.feedbackMessage.set(message);
    this.feedbackError.set(error);
    window.setTimeout(() => this.feedbackMessage.set(''), 3000);
  }

  private validatePassword(model: { password: string; passwordConfirmation: string }, editing: boolean): boolean {
    if (!editing && !model.password) {
      this.showFeedback('Informe uma senha para o novo cadastro.', true);
      return false;
    }
    if (!model.password && !model.passwordConfirmation) return true;
    if (model.password.length < 8) {
      this.showFeedback('A senha deve ter pelo menos 8 caracteres.', true);
      return false;
    }
    if (model.password !== model.passwordConfirmation) {
      this.showFeedback('A senha e a confirmação não coincidem.', true);
      return false;
    }
    return true;
  }

  private emptyProfessional(): ProfessionalFormModel {
    return { name: '', email: '', crmCoren: '', specialty: '', role: '', password: '', passwordConfirmation: '' };
  }

  private emptyPatient(): PatientFormModel {
    return {
      name: '',
      age: 18,
      gender: '',
      email: '',
      phone: '',
      cpf: '',
      procedure: '',
      surgeryDate: '',
      dischargeDate: '',
      hospital: '',
      password: '',
      passwordConfirmation: ''
    };
  }
}
