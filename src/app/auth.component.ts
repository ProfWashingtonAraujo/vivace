import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { form, FormField, required, submit } from '@angular/forms/signals';
import { UserRole } from '../types';
import { VivaceService } from './vivace.service';

interface LoginModel {
  username: string;
  password: string;
  rememberMe: boolean;
}

@Component({
  selector: 'vivace-auth',
  standalone: true,
  imports: [FormField],
  templateUrl: './auth.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AuthComponent {
  readonly vivace = inject(VivaceService);
  readonly tab = signal<UserRole>('professional');
  readonly showPassword = signal(false);
  readonly loginError = signal('');
  readonly loginModel = signal<LoginModel>({
    username: '',
    password: '',
    rememberMe: true
  });
  readonly loginForm = form(this.loginModel, path => {
    required(path.username, { message: 'Informe o usuário.' });
    required(path.password, { message: 'Informe a senha.' });
  });

  selectTab(role: UserRole): void {
    this.tab.set(role);
    this.loginError.set('');
    // Switching profile starts from an empty form; no credentials are ever pre-filled.
    this.loginModel.update(model => ({ ...model, username: '', password: '' }));
  }

  login(event: Event): void {
    event.preventDefault();
    this.loginError.set('');
    void submit(this.loginForm, async () => {
      const result = await this.vivace.login(
        this.loginModel().username.trim(),
        this.loginModel().password,
        this.loginModel().rememberMe
      );
      if (!result.ok) this.loginError.set(result.message);
    });
  }
}
