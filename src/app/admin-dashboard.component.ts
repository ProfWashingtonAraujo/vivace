import { ChangeDetectionStrategy, Component, inject, computed, signal } from '@angular/core';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { AdminUser, ProfessionalUser } from '../types';
import { VivaceService } from './vivace.service';

interface AdminFormModel {
  name: string;
  email: string;
  password: string;
  passwordConfirmation: string;
}

interface ProfessionalFormModel {
  name: string;
  email: string;
  crmCoren: string;
  specialty: string;
  role: string;
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
  readonly feedbackMessage = signal('');
  readonly feedbackError = signal(false);
  readonly editingProfessionalId = signal<string | null>(null);
  private editingProfessionalVersion?: number;
  readonly formOpen = signal(false);
  readonly searchQuery = signal('');
  readonly filteredProfessionals = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const list = this.vivace.professionals();
    return query
      ? list.filter(item => [item.name, item.specialty, item.role, item.crmCoren, item.email].some(value => value.toLowerCase().includes(query)))
      : list;
  });
  readonly professionalAvatar = signal('');
  readonly processingAvatar = signal(false);
  readonly avatarError = signal('');
  readonly professionalModel = signal<ProfessionalFormModel>(this.emptyProfessional());
  readonly adminFormOpen = signal(false);
  readonly editingAdminId =signal<string | null>(null);
  private editingAdminVersion?: number;
  readonly adminModel = signal<AdminFormModel>(this.emptyAdmin());
  readonly adminForm = form(this.adminModel);
  readonly professionalForm = form(this.professionalModel, path => {
    required(path.name);
    required(path.email);
    required(path.crmCoren);
    required(path.specialty);
    required(path.role);
  });

  saveProfessional(event: Event): void {
    event.preventDefault();
    if (!this.validatePassword()) return;
    void submit(this.professionalForm, async () => {
      const { passwordConfirmation: _, ...professional } = this.professionalModel();
      const editingId = this.editingProfessionalId();
      const saved = editingId
        ? await this.vivace.updateProfessional(editingId, professional, this.professionalAvatar(), this.editingProfessionalVersion)
        : await this.vivace.addProfessional({
          ...professional,
          avatar: this.professionalAvatar() || `https://ui-avatars.com/api/?name=${encodeURIComponent(professional.name)}&background=0B5CAB&color=ffffff`
        });
      if (!saved) return; // o aviso do motivo vem do serviço; o formulário fica aberto
      this.cancelProfessionalEdit();
      this.showFeedback(editingId ? 'Profissional atualizado com sucesso.' : 'Profissional cadastrado com sucesso.');
    });
  }

  startNewProfessional(): void {
    this.cancelProfessionalEdit();
    this.formOpen.set(true);
  }

  editProfessional(professional: ProfessionalUser): void {
    this.formOpen.set(true);
    this.editingProfessionalId.set(professional.id);
    this.editingProfessionalVersion = professional.version;
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

  cancelProfessionalEdit(): void {
    this.formOpen.set(false);
    this.editingProfessionalId.set(null);
    this.professionalModel.set(this.emptyProfessional());
    this.professionalAvatar.set('');
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
      this.professionalAvatar.set(await this.compressAvatar(file));
    } catch {
      this.avatarError.set('Não foi possível processar a foto. Tente outra imagem.');
    } finally {
      this.processingAvatar.set(false);
    }
  }

  async deleteProfessional(professional: ProfessionalUser): Promise<void> {
    if (!window.confirm(`Excluir o cadastro de ${professional.name}?`)) return;
    if (!await this.vivace.deleteProfessional(professional.id, professional.version)) return;
    if (this.editingProfessionalId() === professional.id) this.cancelProfessionalEdit();
    this.showFeedback('Profissional excluído com sucesso.');
  }

  startNewAdmin(): void {
    this.cancelAdminEdit();
    this.adminFormOpen.set(true);
  }

  async deleteAdmin(admin: AdminUser): Promise<void> {
    if (!window.confirm(`Excluir o administrador ${admin.name}?`)) return;
    if (!await this.vivace.deleteAdmin(admin.id, admin.version)) return;
    if (this.editingAdminId() === admin.id) this.cancelAdminEdit();
    this.showFeedback('Administrador excluído com sucesso.');
  }

  editAdmin(admin: AdminUser): void {
    this.adminFormOpen.set(true);
    this.editingAdminId.set(admin.id);
    this.editingAdminVersion = admin.version;
    this.adminModel.set({ name: admin.name, email: admin.email, password: '', passwordConfirmation: '' });
  }

  cancelAdminEdit(): void {
    this.adminFormOpen.set(false);
    this.editingAdminId.set(null);
    this.adminModel.set(this.emptyAdmin());
  }

  saveAdmin(event: Event): void {
    event.preventDefault();
    const id = this.editingAdminId();
    const { name, email, password, passwordConfirmation } = this.adminModel();
    if (!name.trim() || !email.trim()) {
      this.showFeedback('Informe o nome e o e-mail do administrador.', true);
      return;
    }
    if (!this.passwordIsValid(password, passwordConfirmation, !id)) return;
    void submit(this.adminForm, async () => {
      const values = { name: name.trim(), email: email.trim(), password };
      const saved = id
        ? await this.vivace.updateAdmin(id, values, this.editingAdminVersion)
        : await this.vivace.addAdmin(values);
      if (!saved) return; // o aviso do motivo vem do serviço; o formulário fica aberto
      this.cancelAdminEdit();
      this.showFeedback(id ? 'Administrador atualizado com sucesso.' : 'Administrador cadastrado com sucesso.');
    });
  }

  private validatePassword(): boolean {
    const model = this.professionalModel();
    return this.passwordIsValid(model.password, model.passwordConfirmation, !this.editingProfessionalId());
  }

  private passwordIsValid(password: string, confirmation: string, mandatory: boolean): boolean {
    if (mandatory && !password) {
      this.showFeedback('Informe uma senha para o novo cadastro.', true);
      return false;
    }
    if (!password && !confirmation) return true;
    if (password.length < 8) {
      this.showFeedback('A senha deve ter pelo menos 8 caracteres.', true);
      return false;
    }
    if (password !== confirmation) {
      this.showFeedback('A senha e a confirmação não coincidem.', true);
      return false;
    }
    return true;
  }

  private emptyAdmin(): AdminFormModel {
    return { name: '', email: '', password: '', passwordConfirmation: '' };
  }

  private showFeedback(message: string, error = false): void {
    this.feedbackMessage.set(message);
    this.feedbackError.set(error);
    window.setTimeout(() => this.feedbackMessage.set(''), 3000);
  }

  private emptyProfessional(): ProfessionalFormModel {
    return { name: '', email: '', crmCoren: '', specialty: '', role: '', password: '', passwordConfirmation: '' };
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
