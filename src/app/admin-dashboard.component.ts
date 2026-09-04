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
  readonly professionalAvatar = signal('');
  readonly patientAvatar = signal('');
  readonly processingAvatar = signal<'professional' | 'patient' | null>(null);
  readonly avatarError = signal('');
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
        this.vivace.updateProfessional(editingId, professional, this.professionalAvatar());
      } else {
        this.vivace.addProfessional({
          ...professional,
          avatar: this.professionalAvatar() || `https://ui-avatars.com/api/?name=${encodeURIComponent(professional.name)}&background=134E4A&color=ffffff`
        });
      }
      this.professionalModel.set(this.emptyProfessional());
      this.professionalAvatar.set('');
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
        this.vivace.updatePatientRegistration(editingId, patient, this.patientAvatar());
      } else {
        this.vivace.addPatient(patient, this.patientAvatar());
      }
      this.patientModel.set(this.emptyPatient());
      this.patientAvatar.set('');
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
    this.professionalAvatar.set(professional.avatar);
    this.avatarError.set('');
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
    this.patientAvatar.set(patient.avatar);
    this.avatarError.set('');
  }

  cancelProfessionalEdit(): void {
    this.editingProfessionalId.set(null);
    this.professionalModel.set(this.emptyProfessional());
    this.professionalAvatar.set('');
    this.avatarError.set('');
  }

  cancelPatientEdit(): void {
    this.editingPatientId.set(null);
    this.patientModel.set(this.emptyPatient());
    this.patientAvatar.set('');
    this.avatarError.set('');
  }

  async selectAvatar(event: Event, type: 'professional' | 'patient'): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.avatarError.set('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      this.avatarError.set('Escolha uma imagem JPEG, PNG ou WebP.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.avatarError.set('A foto deve ter no máximo 5 MB.');
      return;
    }

    this.processingAvatar.set(type);
    try {
      const avatar = await this.compressAvatar(file);
      if (type === 'professional') this.professionalAvatar.set(avatar);
      else this.patientAvatar.set(avatar);
    } catch {
      this.avatarError.set('Não foi possível processar a foto. Tente outra imagem.');
    } finally {
      this.processingAvatar.set(null);
    }
  }

  removeAvatar(type: 'professional' | 'patient'): void {
    if (type === 'professional') this.professionalAvatar.set('');
    else this.patientAvatar.set('');
    this.avatarError.set('');
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

  private compressAvatar(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const source = URL.createObjectURL(file);
      image.onload = () => {
        const size = Math.min(image.width, image.height);
        const canvas = document.createElement('canvas');
        canvas.width = 512;
        canvas.height = 512;
        const context = canvas.getContext('2d');
        if (!context) {
          URL.revokeObjectURL(source);
          reject(new Error('Canvas unavailable'));
          return;
        }
        context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 512, 512);
        URL.revokeObjectURL(source);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      image.onerror = () => {
        URL.revokeObjectURL(source);
        reject(new Error('Invalid image'));
      };
      image.src = source;
    });
  }
}
