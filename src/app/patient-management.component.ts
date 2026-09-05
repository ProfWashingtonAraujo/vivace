import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { Patient } from '../types';
import { VivaceService } from './vivace.service';

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
  selector: 'vivace-patient-management',
  standalone: true,
  imports: [FormField],
  templateUrl: './patient-management.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PatientManagementComponent {
  readonly vivace = inject(VivaceService);
  readonly feedbackMessage = signal('');
  readonly feedbackError = signal(false);
  readonly editingPatientId = signal<string | null>(null);
  readonly patientAvatar = signal('');
  readonly processingAvatar = signal(false);
  readonly avatarError = signal('');
  readonly patientModel = signal<PatientFormModel>(this.emptyPatient());
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

  savePatient(event: Event): void {
    event.preventDefault();
    if (!this.validatePassword()) return;
    void submit(this.patientForm, async () => {
      const editingId = this.editingPatientId();
      const { passwordConfirmation: _, ...patient } = this.patientModel();
      const saved = editingId
        ? await this.vivace.updatePatientRegistration(editingId, patient, this.patientAvatar())
        : await this.vivace.addPatient(patient, this.patientAvatar());
      this.cancelPatientEdit();
      this.showFeedback(saved
        ? editingId ? 'Paciente atualizado com sucesso.' : 'Paciente cadastrado com sucesso.'
        : 'Cadastro salvo neste dispositivo e aguardando sincronização.', !saved);
    });
  }

  editPatient(patient: Patient): void {
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

  cancelPatientEdit(): void {
    this.editingPatientId.set(null);
    this.patientModel.set(this.emptyPatient());
    this.patientAvatar.set('');
    this.avatarError.set('');
  }

  async selectAvatar(event: Event): Promise<void> {
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

    this.processingAvatar.set(true);
    try {
      this.patientAvatar.set(await this.compressAvatar(file));
    } catch {
      this.avatarError.set('Não foi possível processar a foto. Tente outra imagem.');
    } finally {
      this.processingAvatar.set(false);
    }
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

  private validatePassword(): boolean {
    const model = this.patientModel();
    if (!this.editingPatientId() && !model.password) {
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

  private showFeedback(message: string, error = false): void {
    this.feedbackMessage.set(message);
    this.feedbackError.set(error);
    window.setTimeout(() => this.feedbackMessage.set(''), 3000);
  }

  private emptyPatient(): PatientFormModel {
    return {
      name: '', age: 18, gender: '', email: '', phone: '', cpf: '', procedure: '',
      surgeryDate: '', dischargeDate: '', hospital: '', password: '', passwordConfirmation: ''
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
